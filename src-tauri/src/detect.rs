//! Meeting detection (Stage 5 Task 1): "another app is on a call — want to
//! record?"
//!
//! Same split as `audio.rs`/`stt.rs`: a pure, fully unit-tested decision
//! core ([`DetectorCore`]) with zero `unsafe`, driven by a thin hardware-
//! facing shim that's only ever exercised behind `#[cfg(target_os =
//! "macos")]` and mostly left to the ignored FFI smoke test (see the bottom
//! of this file) rather than ordinary unit tests. Three pieces:
//!
//! 1. [`DetectorCore`] — the state machine. Fed [`DetectorEvent`]s (mic
//!    transitions, a periodic tick carrying the current meeting-app check,
//!    settings/recording-state snapshots, and a prompt's eventual outcome),
//!    it emits [`Action::ShowPrompt`] exactly when the spec's AND holds:
//!    enabled, mic continuously active ≥5s, a meeting app present *at the
//!    moment the threshold is checked*, and Minute isn't already recording
//!    — and nothing outside a `Cooldown`/`Prompted`/`SuppressedUntilMicDrop`
//!    phase. No real clock: every method takes `now: Instant` explicitly, so
//!    tests drive it with synthetic offsets from a fixed base instant (same
//!    trick as `audio::ElapsedTracker`'s tests) rather than sleeping.
//! 2. macOS-only hardware shims (`mod macos`, `#[cfg(target_os =
//!    "macos")]`): a CoreAudio mic-activity listener and an NSWorkspace
//!    running-app check. Both permission-free.
//! 3. [`DetectorHandle`] — the managed Tauri state gluing the two together:
//!    owns at most one running detector thread, started/stopped live by
//!    `set_settings` toggling `Settings::meeting_detection` (see
//!    `lib.rs::set_settings`). Disabled means **zero** detector threads, not
//!    a parked one — `start`/`stop` actually spawn/join, they don't just
//!    flip a pause flag on a thread that keeps existing (see Stage 5 Task 6's
//!    stage-gate check: "detection toggle off = zero detector threads").
//!
//! ## A deliberate deviation from the plan: Proc listener, not Block listener
//!
//! The plan (and the CoreAudio precedent it cites, insidegui/AudioCap) calls
//! for `AudioObjectAddPropertyListenerBlock`. This module uses the classic
//! `AudioObjectAddPropertyListener`/`AudioObjectRemovePropertyListener`
//! *Proc*-based pair instead — a plain `extern "C-unwind" fn` pointer plus a
//! `*mut c_void` client-data pointer, no Objective-C block involved. Two
//! reasons: (1) Apple's own docs for the Proc-based remove call are
//! unqualified ("unregisters ... from receiving notifications"), while the
//! Block-based remove's docs describe a dispatch-queue handoff that can
//! still have an in-flight callback landing *after* the remove call returns
//! — exactly the kind of use-after-free hazard `RunEvent`/shutdown-ordering
//! code needs to not have to reason about. (2) it avoids threading
//! `block2`/`dispatch2`'s `RcBlock`→`DynBlock` pointer-cast dance through
//! the unsafe surface for no behavioral difference — same properties, same
//! addresses, same effect. See `macos::MicMonitor` for the full listener
//! lifetime argument.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::audio::SharedRecorderState;
use crate::catalog::{self, ModelKind};
use crate::settings::SharedSettings;

// ---------------------------------------------------------------------------
// DetectorCore — pure decision core
// ---------------------------------------------------------------------------

/// How long the mic must be *continuously* active, with a meeting app
/// present at the moment the threshold is crossed, before a prompt fires.
pub const DEBOUNCE: Duration = Duration::from_secs(5);

/// Cooldown applied after a prompt is dismissed or times out: no new prompt
/// for this long, even if the same call is still ongoing.
pub const COOLDOWN: Duration = Duration::from_secs(15 * 60);

/// If a shown prompt receives no explicit [`PromptOutcome`] within this long,
/// [`DetectorCore`] treats it as [`PromptOutcome::TimedOut`] on its own. This
/// is what keeps the core's contract self-consistent even before Task 2
/// wires a real popup that reports outcomes — without it, a `ShowPrompt`
/// nobody ever answers would latch the core in `Prompted` forever. Matches
/// the popup's own planned auto-dismiss (~12s per the Task 2 spec); if the
/// popup *does* report an explicit outcome first, that wins (this is purely
/// a fallback, not a race — see `process`'s `Outcome` arm, which applies
/// unconditionally regardless of this timer).
pub const PROMPT_AUTO_TIMEOUT: Duration = Duration::from_secs(12);

/// The outcome of a shown prompt, reported back into the core once known.
///
/// Constructed for real now (Stage 5 Task 2): `popup::popup_start`/
/// `popup::popup_dismiss` report `Accepted`/`Dismissed`/`TimedOut` through
/// [`report_outcome`] -> the detector thread's outcome channel -> here.
/// Before that wiring existed, `DetectorCore::evaluate`'s own
/// [`PROMPT_AUTO_TIMEOUT`] fallback was the only thing keeping a shown
/// prompt from latching forever — that fallback stays in place as a
/// safety net (e.g. the popup window failing to create at all), it's just
/// no longer the *only* path to an outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOutcome {
    /// The user clicked "Start recording".
    Accepted,
    /// The user dismissed the prompt (the × / "not now").
    Dismissed,
    /// Nobody responded before the popup auto-dismissed.
    TimedOut,
}

/// One timestamped input to [`DetectorCore::process`].
#[derive(Debug, Clone, PartialEq)]
pub enum DetectorEvent {
    /// The default input device started being used by *some* process
    /// (possibly Minute itself — see `minute_recording`, not this event, for
    /// that distinction).
    MicStarted,
    /// The default input device is no longer in use by anyone.
    MicStopped,
    /// A periodic re-check while the mic is hot: carries the current
    /// running-app allowlist check (`None` if no meeting app/browser is
    /// currently running). Also where a stale `Cooldown`/`Prompted` auto-
    /// timeout gets noticed and resolved — see `evaluate`.
    Tick { meeting_app_present: Option<String> },
    /// Settings snapshot: whether meeting detection is turned on at all.
    /// Not fed by `run_detector_thread` today — the real `DetectorHandle`
    /// enforces enabled/disabled by spawning/joining the whole thread (see
    /// the module docs' "zero detector threads" contract), so a live core
    /// never actually needs telling *while running*. Kept as a first-class
    /// event anyway so the "disable mid-debounce" boundary stays testable
    /// against the core directly, independent of how any particular caller
    /// chooses to wire enable/disable — see
    /// `core_tests::disable_mid_debounce_discards_the_partial_streak`.
    #[allow(dead_code)]
    SetEnabled(bool),
    /// Recorder-state snapshot: whether Minute itself is already recording.
    /// Minute's own mic usage must never trigger its own prompt — see the
    /// `!minute_recording` term in `evaluate`.
    SetMinuteRecording(bool),
    /// Whether at least one speech-to-text catalog entry is installed on
    /// disk right now — closes a real, reachable edge (Stage 5 Task 3):
    /// enable meeting detection in Settings, then later delete every
    /// installed STT model. Deleting a model touches nothing in
    /// `settings.json` and never calls `set_settings`, so the live detector
    /// thread is never told to stop — it would otherwise keep prompting
    /// while the frontend has re-gated `view` back to `'onboarding'` (see
    /// `useModelManager`'s re-gate effect), producing a popup whose "Start
    /// recording" `useAppState`'s `meeting-popup-start` handler can only
    /// bounce straight back to onboarding with an error. Fed by
    /// `run_detector_thread` every poll tick, exactly like
    /// `SetMinuteRecording` (see that function's body) — never fed by real
    /// user action, so unlike `SetEnabled` there's no "mid-debounce" streak
    /// to specially discard, just one more term in `evaluate`'s AND.
    SetSttModelInstalled(bool),
    /// A previously shown prompt's resolution — see [`PromptOutcome`]'s docs.
    Outcome(PromptOutcome),
}

/// What [`DetectorCore::process`] wants the caller to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Show the "Meeting detected" prompt for this friendly app name.
    ShowPrompt { app_name: String },
    /// Nothing to do.
    None,
}

/// Internal phase — everything other than `Watching` suppresses new prompts
/// regardless of how the mic/app/enabled/recording snapshot looks.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    /// Normal operation: a prompt fires the instant the AND-condition holds.
    Watching,
    /// A prompt was shown at `since` and no outcome has arrived yet — see
    /// `PROMPT_AUTO_TIMEOUT`.
    Prompted { since: Instant },
    /// The user accepted the last prompt (Start) — suppressed until the mic
    /// goes fully inactive again (`MicStopped`), per the spec's "no prompt
    /// until mic drops" rule for an accepted call.
    SuppressedUntilMicDrop,
    /// The last prompt was dismissed or timed out — suppressed until `until`
    /// regardless of mic state (see `COOLDOWN`).
    Cooldown(Instant),
}

/// The meeting-detection decision engine — see the module docs for the full
/// picture. Holds no real clock and does no I/O; every transition is driven
/// by an explicit `now: Instant` passed into [`process`](Self::process).
pub struct DetectorCore {
    enabled: bool,
    minute_recording: bool,
    mic_active: bool,
    /// When the current unbroken mic-active streak began, if any —
    /// `None` whenever the mic is inactive, or was reset (disabled mid-
    /// debounce, or a `MicStopped`).
    mic_hot_since: Option<Instant>,
    /// The most recent `Tick`'s running-app check result.
    last_meeting_app: Option<String>,
    /// The most recent `SetSttModelInstalled` snapshot — see that event
    /// variant's docs for the edge this closes. Defaults to `true` in
    /// [`new`](Self::new) (the ordinary post-onboarding case), so every
    /// test above this field's introduction, none of which ever sends
    /// `SetSttModelInstalled`, keeps its original meaning unchanged.
    stt_model_installed: bool,
    phase: Phase,
}

impl DetectorCore {
    /// `enabled` is the initial settings snapshot — in practice, the real
    /// [`DetectorHandle`] only ever runs a thread (and therefore only ever
    /// constructs a core) while detection is enabled, so this is normally
    /// `true`; the field still exists (rather than being hardcoded) so
    /// `SetEnabled`'s reset behavior stays independently testable.
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            minute_recording: false,
            mic_active: false,
            mic_hot_since: None,
            last_meeting_app: None,
            stt_model_installed: true,
            phase: Phase::Watching,
        }
    }

    /// Feeds one timestamped event into the core, returning the action (if
    /// any) the caller should take.
    pub fn process(&mut self, event: DetectorEvent, now: Instant) -> Action {
        match event {
            DetectorEvent::MicStarted => {
                self.mic_active = true;
                self.mic_hot_since = Some(now);
                self.evaluate(now)
            }
            DetectorEvent::MicStopped => {
                self.mic_active = false;
                self.mic_hot_since = None;
                // A time-based Cooldown counts down regardless of mic
                // state — an unrelated later call must not inherit a
                // still-open prompt/suppression from a call that just
                // ended. Every other phase has nothing left to suppress
                // once the mic goes cold, so it returns to Watching.
                if !matches!(self.phase, Phase::Cooldown(_)) {
                    self.phase = Phase::Watching;
                }
                Action::None
            }
            DetectorEvent::Tick { meeting_app_present } => {
                self.last_meeting_app = meeting_app_present;
                self.evaluate(now)
            }
            DetectorEvent::SetEnabled(enabled) => {
                self.enabled = enabled;
                if !enabled {
                    // Disabling mid-debounce must not let a stale streak
                    // silently count through the disabled span — the next
                    // enable starts a fresh 5s window, never crediting time
                    // that elapsed while off.
                    self.mic_hot_since = None;
                    self.phase = Phase::Watching;
                } else if self.mic_active {
                    // Re-enabling with the mic already hot restarts the
                    // debounce from now, rather than requiring a fresh
                    // `MicStarted` that will never come (the mic never
                    // actually stopped).
                    self.mic_hot_since = Some(now);
                }
                Action::None
            }
            DetectorEvent::SetMinuteRecording(recording) => {
                self.minute_recording = recording;
                Action::None
            }
            DetectorEvent::SetSttModelInstalled(installed) => {
                self.stt_model_installed = installed;
                Action::None
            }
            DetectorEvent::Outcome(outcome) => {
                // Phase-checked, not unconditional: a stale outcome for a
                // prompt that isn't (or is no longer) actually shown — e.g.
                // a late `popup_dismiss`/`popup_start` IPC call racing the
                // core's own `PROMPT_AUTO_TIMEOUT` fallback, which may have
                // already resolved this same prompt on its own by the time
                // the real outcome arrives — must not retroactively
                // introduce a cooldown/suppression onto whatever the core
                // has independently moved on to since (a fresh `Watching`,
                // a `Cooldown` already running for an unrelated reason,
                // ...). It only actually applies while a prompt is
                // genuinely still `Prompted` — see
                // `core_tests::outcome_while_watching_is_tolerated_and_does_not_corrupt_state`
                // for the regression this guards.
                if let Phase::Prompted { .. } = self.phase {
                    self.phase = match outcome {
                        PromptOutcome::Accepted => Phase::SuppressedUntilMicDrop,
                        PromptOutcome::Dismissed | PromptOutcome::TimedOut => {
                            Phase::Cooldown(now + COOLDOWN)
                        }
                    };
                }
                Action::None
            }
        }
    }

    /// Re-checks the AND-condition against the current snapshot. Also where
    /// a `Cooldown` that has expired, or a `Prompted` prompt that nobody
    /// answered within [`PROMPT_AUTO_TIMEOUT`], gets resolved — both just
    /// fall through to a fresh `Watching` evaluation (a `Prompted` timeout
    /// becomes a `Cooldown`, exactly like an explicit `Outcome::TimedOut`
    /// would, rather than immediately re-showing a prompt the same instant
    /// the old one expires).
    fn evaluate(&mut self, now: Instant) -> Action {
        if let Phase::Cooldown(until) = self.phase {
            if now >= until {
                self.phase = Phase::Watching;
            }
        }
        if let Phase::Prompted { since } = self.phase {
            // `Instant` is documented monotonic, so `since` should never be
            // ahead of `now` here; `saturating_duration_since` (over plain
            // `-`/`duration_since`) costs nothing in the common case and
            // just keeps this panic-free if that guarantee were ever
            // violated (a platform bug, a mocked clock in some future test).
            if now.saturating_duration_since(since) >= PROMPT_AUTO_TIMEOUT {
                self.phase = Phase::Cooldown(now + COOLDOWN);
            }
        }

        if self.phase != Phase::Watching {
            return Action::None;
        }
        if !self.enabled || self.minute_recording || !self.mic_active || !self.stt_model_installed {
            return Action::None;
        }
        let Some(app_name) = self.last_meeting_app.clone() else {
            return Action::None;
        };
        let Some(hot_since) = self.mic_hot_since else {
            return Action::None;
        };
        // Same `saturating_duration_since` rationale as above: `Instant`'s
        // monotonicity guarantee means this never actually saturates, it's
        // just cost-free insurance against panicking if it somehow did.
        if now.saturating_duration_since(hot_since) < DEBOUNCE {
            return Action::None;
        }

        self.phase = Phase::Prompted { since: now };
        Action::ShowPrompt { app_name }
    }
}

// PartialEq for Phase is only needed for the `!= Phase::Watching` check
// above; deriving it needs `Instant: PartialEq`, which it is, so a plain
// `#[derive(PartialEq)]` on the enum (already present) covers it — no
// manual impl needed. (Comment kept so a future reader doesn't wonder why
// there's no explicit impl block here.)

#[cfg(test)]
mod core_tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    // --- the debounce boundary ------------------------------------------

    #[test]
    fn exactly_5s_continuous_mic_and_app_present_triggers_prompt() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        assert_eq!(core.process(DetectorEvent::MicStarted, base), Action::None);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn just_under_5s_does_not_trigger() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + Duration::from_millis(4900),
        );
        assert_eq!(action, Action::None);
    }

    #[test]
    fn mic_drop_before_threshold_resets_the_debounce() {
        // Mic goes hot at 0, drops at 4.9s (never reached 5s continuous),
        // restarts immediately — the restarted streak must count from its
        // own start, not inherit any credit from the first one.
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(DetectorEvent::MicStopped, base + Duration::from_millis(4900));
        core.process(DetectorEvent::MicStarted, base + Duration::from_millis(4900));

        // 4.9s after the restart (9.8s of wall-clock since the very first
        // MicStarted) — would already be well past 5s if the reset hadn't
        // happened.
        let too_early = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + Duration::from_millis(9800),
        );
        assert_eq!(too_early, Action::None);

        // 5.0s after the restart.
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + Duration::from_millis(9900),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn mic_flap_with_a_genuine_gap_requires_a_fresh_independent_5s_streak() {
        // Same shape as the test above, but with an actual gap where the mic
        // is genuinely inactive for a beat (4s active, 1s off, 4s active)
        // rather than an instantaneous stop-then-restart at the same
        // instant — the second streak still can't inherit any credit from
        // the first, and nothing fires while the mic is inactive either.
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(DetectorEvent::MicStopped, base + secs(4));

        // Mid-gap: mic is genuinely off — no prompt regardless of app
        // presence.
        let during_gap = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + Duration::from_millis(4_500),
        );
        assert_eq!(during_gap, Action::None);

        core.process(DetectorEvent::MicStarted, base + secs(5));

        // 4s into the second streak — not yet at its own 5s mark.
        let too_early = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(4),
        );
        assert_eq!(too_early, Action::None);

        // 5s into the second streak — fires on its own merits, independent
        // of the first (unrelated) 4s streak before the gap.
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    // --- app presence timing ---------------------------------------------

    #[test]
    fn app_appearing_after_mic_already_hot_still_triggers_once_present() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let no_app_yet = core.process(
            DetectorEvent::Tick {
                meeting_app_present: None,
            },
            base + secs(3),
        );
        assert_eq!(no_app_yet, Action::None);

        // App shows up only now, after the mic's already been hot 6s.
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Microsoft Teams".to_string()),
            },
            base + secs(6),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Microsoft Teams".to_string()
            }
        );
    }

    #[test]
    fn app_quitting_before_threshold_blocks_until_it_reappears() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(2),
        );
        // App quits before the 5s mark.
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: None,
            },
            base + secs(4),
        );
        // At the 5s mark, the app is (still) absent — no prompt even
        // though the mic has now been hot for exactly 5s.
        let blocked = core.process(
            DetectorEvent::Tick {
                meeting_app_present: None,
            },
            base + secs(5),
        );
        assert_eq!(blocked, Action::None);

        // App comes back a second later — prompts immediately, since the
        // mic-hot streak was never actually broken.
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(6),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    // --- enabled / disabled ------------------------------------------------

    #[test]
    fn disabled_blocks_entirely_even_if_every_other_condition_holds() {
        let base = Instant::now();
        let mut core = DetectorCore::new(false);

        core.process(DetectorEvent::MicStarted, base);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(action, Action::None);
    }

    #[test]
    fn disable_mid_debounce_discards_the_partial_streak() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        // Disabled 2s in.
        core.process(DetectorEvent::SetEnabled(false), base + secs(2));
        // Still disabled at what would have been the 7s mark (5s after the
        // original MicStarted) — must not fire even though 5s elapsed,
        // since detection was off.
        let while_disabled = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(7),
        );
        assert_eq!(while_disabled, Action::None);

        // Re-enabled at 8s, mic still hot — the timer restarts from here,
        // not from the original MicStarted.
        core.process(DetectorEvent::SetEnabled(true), base + secs(8));
        let too_early = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + Duration::from_millis(12_900), // 4.9s after re-enable
        );
        assert_eq!(too_early, Action::None);

        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(13), // 5.0s after re-enable
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    // --- Minute's own recording --------------------------------------------

    #[test]
    fn minute_already_recording_suppresses_the_prompt() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);
        core.process(DetectorEvent::SetMinuteRecording(true), base);

        core.process(DetectorEvent::MicStarted, base);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(action, Action::None);

        // Minute stops recording, mic is still (genuinely) hot from the
        // real meeting app — the very next tick can prompt immediately,
        // since the underlying 5s streak was never actually broken by
        // Minute's own recording toggling on/off.
        core.process(DetectorEvent::SetMinuteRecording(false), base + secs(6));
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(6),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    // --- stt_model_installed (Stage 5 Task 3's onboarding-suppression fix) -

    #[test]
    fn no_stt_model_installed_suppresses_the_prompt_even_if_every_other_condition_holds() {
        // The reachable edge this closes: detection stays enabled (nothing
        // about deleting a model touches `settings.meetingDetection`), but
        // every STT model has since been deleted — re-gating the frontend
        // back to onboarding. The still-running detector must not prompt.
        let base = Instant::now();
        let mut core = DetectorCore::new(true);
        core.process(DetectorEvent::SetSttModelInstalled(false), base);

        core.process(DetectorEvent::MicStarted, base);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(action, Action::None);
    }

    #[test]
    fn stt_model_installed_defaults_to_true_so_a_fresh_core_prompts_normally() {
        // No `SetSttModelInstalled` ever sent — the ordinary post-onboarding
        // case every other test above this field's introduction relies on.
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn stt_model_becoming_installed_again_lets_a_fresh_streak_prompt() {
        // A model finishes installing (e.g. the user completes onboarding)
        // partway through an already-hot mic streak — the very next tick at
        // or past the 5s mark prompts on that streak's own merits, same as
        // any other input becoming true mid-streak (e.g.
        // `app_appearing_after_mic_already_hot_still_triggers_once_present`).
        let base = Instant::now();
        let mut core = DetectorCore::new(true);
        core.process(DetectorEvent::SetSttModelInstalled(false), base);

        core.process(DetectorEvent::MicStarted, base);
        let blocked = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(3),
        );
        assert_eq!(blocked, Action::None);

        core.process(DetectorEvent::SetSttModelInstalled(true), base + secs(4));
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    // --- prompt outcomes ----------------------------------------------------

    #[test]
    fn accepted_suppresses_until_mic_drops_then_a_fresh_cycle_can_prompt_again() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let shown = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(
            shown,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );

        core.process(DetectorEvent::Outcome(PromptOutcome::Accepted), base + secs(5));

        // Mic stays hot a long time (the recording itself) — must not
        // re-prompt no matter how long.
        let suppressed = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(600),
        );
        assert_eq!(suppressed, Action::None);

        // The call finally ends — mic drops.
        core.process(DetectorEvent::MicStopped, base + secs(700));
        // A brand new call starts later.
        core.process(DetectorEvent::MicStarted, base + secs(800));
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(805),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn dismissed_applies_a_15_minute_cooldown_then_reprompts_if_still_ongoing() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        core.process(DetectorEvent::Outcome(PromptOutcome::Dismissed), base + secs(5));

        // Still within the 15-minute cooldown (5s + 899s = 904s < 905s).
        let blocked = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(899),
        );
        assert_eq!(blocked, Action::None);

        // Cooldown expires at 5s + 900s = 905s; the call is still going —
        // reprompt right at the boundary.
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(900),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn timed_out_applies_the_same_cooldown_as_dismissed() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        core.process(DetectorEvent::Outcome(PromptOutcome::TimedOut), base + secs(5));

        let blocked = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(100),
        );
        assert_eq!(blocked, Action::None);
    }

    #[test]
    fn a_shown_prompt_never_reprompts_on_further_ticks_before_any_outcome() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let first = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert!(matches!(first, Action::ShowPrompt { .. }));

        let second = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(6),
        );
        assert_eq!(second, Action::None);
    }

    #[test]
    fn an_unanswered_prompt_auto_times_out_and_then_cools_down() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let shown = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert!(matches!(shown, Action::ShowPrompt { .. }));

        // No explicit Outcome ever arrives (no popup wired yet). The very
        // next tick right at the auto-timeout mark (5s shown-at + 12s) is
        // where the core notices on its own and enters Cooldown from *that*
        // instant — it's the tick itself that resolves the stale Prompted
        // phase, so the cooldown's 15 minutes count from here, not from the
        // original shown-at time (see `evaluate`'s lazy resolution: nothing
        // fires purely on the passage of time between ticks).
        let still_cooling = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(12),
        );
        assert_eq!(still_cooling, Action::None);

        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(12) + secs(900),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn mic_stopping_during_cooldown_does_not_lift_it_early() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        core.process(DetectorEvent::Outcome(PromptOutcome::Dismissed), base + secs(5));

        // The call ends entirely before the cooldown would've expired.
        core.process(DetectorEvent::MicStopped, base + secs(10));
        // A brand new, unrelated call starts almost immediately after —
        // still within the original 15-minute cooldown window.
        core.process(DetectorEvent::MicStarted, base + secs(11));
        let blocked = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(11) + secs(5),
        );
        assert_eq!(blocked, Action::None);
    }

    // --- SetEnabled(false) forces a return to Watching from every other
    // phase --------------------------------------------------------------
    //
    // `Phase` is private, so each of these pins the reset indirectly: a
    // quick re-enable (well inside the 12s auto-timeout / 900s cooldown
    // windows those phases would otherwise still be blocking on) reprompts
    // as soon as its own fresh 5s debounce elapses — which is only possible
    // if `SetEnabled(false)` actually forced `Watching`, not left the prior
    // phase (`Prompted`/`Cooldown`/`SuppressedUntilMicDrop`) in place.

    #[test]
    fn disabling_while_prompted_forces_watching() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let shown = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert!(matches!(shown, Action::ShowPrompt { .. }));

        // Still `Prompted`, well inside the 12s auto-timeout window —
        // disabling here must reset the phase itself, not just wait it out.
        core.process(DetectorEvent::SetEnabled(false), base + secs(6));
        core.process(DetectorEvent::SetEnabled(true), base + secs(7));

        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(7) + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn disabling_during_cooldown_forces_watching() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        core.process(DetectorEvent::Outcome(PromptOutcome::Dismissed), base + secs(5));

        // Well inside what would otherwise be a 900s cooldown — disabling
        // must clear it outright, not just pause the countdown.
        core.process(DetectorEvent::SetEnabled(false), base + secs(6));
        core.process(DetectorEvent::SetEnabled(true), base + secs(7));

        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(7) + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    #[test]
    fn disabling_while_suppressed_until_mic_drop_forces_watching() {
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        core.process(DetectorEvent::Outcome(PromptOutcome::Accepted), base + secs(5));

        // Mic never drops (the call is still ongoing) — disabling must
        // still lift the suppression itself, without needing a `MicStopped`.
        core.process(DetectorEvent::SetEnabled(false), base + secs(6));
        core.process(DetectorEvent::SetEnabled(true), base + secs(7));

        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(7) + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            }
        );
    }

    // --- a stale/late Outcome is phase-checked, not unconditional --------

    #[test]
    fn outcome_while_watching_is_tolerated_and_does_not_corrupt_state() {
        // No prompt was ever shown — e.g. a stray/duplicate popup_dismiss
        // call, or one that arrives after some other path already resolved
        // things. Must be a harmless no-op: no cooldown, no suppression,
        // still able to prompt normally on its own merits right after.
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        let outcome_result = core.process(DetectorEvent::Outcome(PromptOutcome::Dismissed), base);
        assert_eq!(outcome_result, Action::None);

        core.process(DetectorEvent::MicStarted, base);
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            },
            "a stale Outcome while Watching must not have introduced a cooldown that blocks this fresh, on-its-own-merits prompt"
        );
    }

    #[test]
    fn a_stale_outcome_after_the_cores_own_auto_timeout_already_resolved_it_does_not_extend_the_cooldown() {
        // The core's own PROMPT_AUTO_TIMEOUT fallback (see that constant's
        // docs) can resolve a Prompted phase into Cooldown entirely on its
        // own, independent of any real popup_dismiss/popup_start IPC call
        // ever arriving. If the real outcome (e.g. a `timedOut: true`
        // popup_dismiss racing that same fallback) then arrives *after*
        // that has already happened, it must not retroactively restart a
        // fresh 15-minute cooldown on top of the one already counting down
        // — the phase is no longer `Prompted` by then, so the late Outcome
        // is a no-op rather than pushing `until` further out.
        let base = Instant::now();
        let mut core = DetectorCore::new(true);

        core.process(DetectorEvent::MicStarted, base);
        let shown = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5),
        );
        assert!(matches!(shown, Action::ShowPrompt { .. }));

        // The core notices its own stale Prompted phase and cools down on
        // the very next tick at/after the 12s auto-timeout mark (see
        // `an_unanswered_prompt_auto_times_out_and_then_cools_down` above
        // for the same mechanics) — cooldown now runs from base+17s to
        // base+17s+900s.
        core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(12),
        );

        // The real (now-stale) outcome finally arrives a bit later — must
        // be a no-op: phase is `Cooldown`, not `Prompted`, by this point.
        core.process(DetectorEvent::Outcome(PromptOutcome::TimedOut), base + secs(20));

        // Right at what would have been the *original* cooldown's
        // expiry (base + 17s + 900s) — if the late Outcome had wrongly
        // restarted the cooldown from base+20s instead, this would still
        // be blocked; it isn't, proving the late Outcome changed nothing.
        let action = core.process(
            DetectorEvent::Tick {
                meeting_app_present: Some("Zoom".to_string()),
            },
            base + secs(5) + secs(12) + secs(900),
        );
        assert_eq!(
            action,
            Action::ShowPrompt {
                app_name: "Zoom".to_string()
            },
            "the late, already-stale Outcome must not have pushed the cooldown's expiry further out"
        );
    }
}

// ---------------------------------------------------------------------------
// macOS hardware shims: CoreAudio mic-activity listener + NSWorkspace check
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod macos {
    //! Thin, deliberately minimal unsafe shims — all decision logic lives in
    //! [`super::DetectorCore`]; nothing here does anything but translate a
    //! CoreAudio/AppKit signal into a plain Rust value or channel send.

    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::Arc;

    use objc2_app_kit::NSWorkspace;
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioObjectAddPropertyListener, AudioObjectGetPropertyData, AudioObjectID,
        AudioObjectPropertyAddress, AudioObjectRemovePropertyListener,
    };

    use crate::error::{MinuteError, Result};

    // --- meeting_app_present: NSWorkspace running-app allowlist check ------

    /// Real meeting apps, checked (and named) first — see `find_allowlisted`.
    /// Both current and legacy Teams bundle ids are listed, per the plan.
    /// Webex's bundle id is the one most consistently reported for the
    /// "Webex Meetings" desktop app in the wild; unlike the others this one
    /// wasn't independently re-verified against a live install for this
    /// change, so treat it as the one entry in this table most likely to
    /// need adjusting if it doesn't match in practice.
    const MEETING_APPS: &[(&str, &str)] = &[
        ("us.zoom.xos", "Zoom"),
        ("com.microsoft.teams2", "Microsoft Teams"),
        ("com.microsoft.teams", "Microsoft Teams"),
        ("com.webex.meetingmanager", "Webex"),
        ("com.apple.FaceTime", "FaceTime"),
        ("com.tinyspeck.slackmacgap", "Slack"),
        ("com.hnc.Discord", "Discord"),
    ];

    /// Browsers: a *weak* signal on their own (per the plan) — sufficient
    /// here only because this function is never even called except when the
    /// mic has already been continuously hot for the full debounce window
    /// (see `run_detector_thread`), so the AND with real mic activity is
    /// always already satisfied by the time a browser match matters.
    const BROWSERS: &[(&str, &str)] = &[
        ("com.apple.Safari", "Safari"),
        ("com.google.Chrome", "Chrome"),
        ("company.thebrowser.Browser", "Arc"),
        ("com.microsoft.edgemac", "Microsoft Edge"),
        ("org.mozilla.firefox", "Firefox"),
    ];

    /// Pure matching logic, factored out from the actual `NSWorkspace` call
    /// so it's unit-testable without touching AppKit — see the tests below.
    fn find_allowlisted(running_bundle_ids: &[String]) -> Option<String> {
        MEETING_APPS
            .iter()
            .chain(BROWSERS.iter())
            .find(|(id, _name)| running_bundle_ids.iter().any(|b| b == id))
            .map(|(_id, name)| (*name).to_string())
    }

    /// Checks `NSWorkspace.runningApplications` against the meeting-app/
    /// browser allowlist, returning the friendly name of the first (highest-
    /// priority) match, or `None` if nothing on the allowlist is running.
    /// Real apps are checked before browsers regardless of process order, so
    /// e.g. Zoom-plus-Chrome-both-running reports "Zoom", never "Chrome".
    ///
    /// Deliberately *not* a standing poll — see `run_detector_thread`, which
    /// only calls this while the mic is already known to be hot.
    /// `NSWorkspace.runningApplications` is documented by Apple as safe to
    /// call from a background thread (its result is "returned atomically"),
    /// so this needs no dispatch back to the main thread.
    pub fn meeting_app_present() -> Option<String> {
        let workspace = NSWorkspace::sharedWorkspace();
        let running = workspace.runningApplications();
        let bundle_ids: Vec<String> = running
            .iter()
            .filter_map(|app| app.bundleIdentifier())
            .map(|s| s.to_string())
            .collect();
        find_allowlisted(&bundle_ids)
    }

    // --- MicMonitor: CoreAudio "is the mic in use anywhere" listener -------

    /// One event the [`MicMonitor`] can report.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ShimEvent {
        MicStarted,
        MicStopped,
    }

    fn running_somewhere_address() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    fn default_input_device_address() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    /// Reads the current default input device id from the system object.
    fn current_default_input_device() -> Result<AudioObjectID> {
        let mut device_id: AudioObjectID = 0;
        let mut address = default_input_device_address();
        let mut size = std::mem::size_of::<AudioObjectID>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                kAudioObjectSystemObject as AudioObjectID,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut device_id).cast(),
            )
        };
        if status != 0 {
            return Err(MinuteError::Other(format!(
                "AudioObjectGetPropertyData(kAudioHardwarePropertyDefaultInputDevice) failed: {status}"
            )));
        }
        Ok(device_id)
    }

    /// Reads whether `device_id` is currently "running somewhere" (in use by
    /// any process, including Minute itself — see `DetectorCore`'s
    /// `!minute_recording` term for how the higher-level core distinguishes
    /// that case).
    fn is_running_somewhere(device_id: AudioObjectID) -> Result<bool> {
        let mut value: u32 = 0;
        let mut address = running_somewhere_address();
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast(),
            )
        };
        if status != 0 {
            return Err(MinuteError::Other(format!(
                "AudioObjectGetPropertyData(kAudioDevicePropertyDeviceIsRunningSomewhere) failed: {status}"
            )));
        }
        Ok(value != 0)
    }

    /// Client data shared by both registered listeners (the per-device
    /// "is running somewhere" listener and the system-wide "default input
    /// device changed" listener) — see `MicMonitor`'s docs for the leaked-
    /// `Arc` lifetime this backs.
    struct ListenerCtx {
        tx: Sender<ShimEvent>,
        device_id: AtomicU32,
        last_running: AtomicBool,
    }

    unsafe extern "C-unwind" fn device_is_running_listener(
        object_id: AudioObjectID,
        _num_addresses: u32,
        _addresses: NonNull<AudioObjectPropertyAddress>,
        client_data: *mut c_void,
    ) -> i32 {
        // Safety: `client_data` is always the pointer this module itself
        // registered (see `MicMonitor::start`) — a leaked `Arc<ListenerCtx>`
        // kept alive for exactly as long as this listener stays registered.
        let ctx = unsafe { &*(client_data as *const ListenerCtx) };
        if let Ok(running) = is_running_somewhere(object_id) {
            let was_running = ctx.last_running.swap(running, Ordering::SeqCst);
            if running != was_running {
                let event = if running {
                    ShimEvent::MicStarted
                } else {
                    ShimEvent::MicStopped
                };
                let _ = ctx.tx.send(event);
            }
        }
        0
    }

    unsafe extern "C-unwind" fn default_input_changed_listener(
        _object_id: AudioObjectID,
        _num_addresses: u32,
        _addresses: NonNull<AudioObjectPropertyAddress>,
        client_data: *mut c_void,
    ) -> i32 {
        // Safety: see `device_is_running_listener` above — same pointer,
        // same lifetime contract.
        let ctx = unsafe { &*(client_data as *const ListenerCtx) };
        let Ok(new_device) = current_default_input_device() else {
            return 0;
        };
        let old_device = ctx.device_id.swap(new_device, Ordering::SeqCst);
        if old_device == new_device {
            return 0;
        }

        let mut running_addr = running_somewhere_address();
        unsafe {
            let _ = AudioObjectRemovePropertyListener(
                old_device,
                NonNull::from(&mut running_addr),
                Some(device_is_running_listener),
                client_data,
            );
            let _ = AudioObjectAddPropertyListener(
                new_device,
                NonNull::from(&mut running_addr),
                Some(device_is_running_listener),
                client_data,
            );
        }

        // Re-sync to the new device's actual state and report a transition
        // only if it actually differs from what was last known — a device
        // swap alone (old device idle, new device idle) isn't a mic
        // transition.
        if let Ok(running) = is_running_somewhere(new_device) {
            let was_running = ctx.last_running.swap(running, Ordering::SeqCst);
            if running != was_running {
                let event = if running {
                    ShimEvent::MicStarted
                } else {
                    ShimEvent::MicStopped
                };
                let _ = ctx.tx.send(event);
            }
        }
        0
    }

    /// A live CoreAudio mic-activity listener. Reports `ShimEvent`s over the
    /// `Sender` it was built with until dropped.
    ///
    /// # Soundness of the leaked-`Arc` client-data pointer
    ///
    /// `start` leaks exactly one `Arc<ListenerCtx>` (via `Arc::into_raw`) and
    /// registers that single pointer as the client data for *both*
    /// listeners. `Drop` removes both listeners first (via the Proc-based
    /// `AudioObjectRemovePropertyListener`, whose docs describe an
    /// unconditional unregister — unlike the Block-based API's dispatch-
    /// queue handoff, there's no window where a call already in flight lands
    /// after `Remove` returns) and only then performs exactly one matching
    /// `Arc::from_raw` to reclaim it. That pairing is what makes this sound:
    /// no leak (the one reclaim matches the one leak) and no use-after-free
    /// (no callback can still be pending once the matching `Remove` calls
    /// have both returned, and reclaiming happens strictly after both).
    pub struct MicMonitor {
        ctx_ptr: *const ListenerCtx,
        device_id: AudioObjectID,
    }

    // The raw pointer is only ever dereferenced by the two listener
    // callbacks above (which take their own reference from it) and by
    // `Drop` (which reclaims it once, after both listeners are known gone)
    // — nothing about holding the `MicMonitor` handle itself touches the
    // pointee from another thread concurrently with those. It's `Send` so
    // the detector thread that owns it can be `std::thread::spawn`ed.
    unsafe impl Send for MicMonitor {}

    impl MicMonitor {
        /// Attaches the listener pair: a per-device "is running somewhere"
        /// listener on the current default input device, plus a system-wide
        /// "default input device changed" listener that re-attaches the
        /// former whenever the latter fires (e.g. a Bluetooth headset
        /// connects and becomes the new default input).
        ///
        /// Sends one initial [`ShimEvent`] on `tx` reflecting whatever the
        /// mic's state already is at attach time (e.g. detection was just
        /// turned on mid-call) — without this, a call already in progress
        /// when detection is enabled would never see a `MicStarted` at all,
        /// since CoreAudio only calls the listener on a *transition*.
        ///
        /// ## Known caveat: Bluetooth mics
        /// `kAudioDevicePropertyDeviceIsRunningSomewhere` is documented (and
        /// independently reported on Apple's developer forums) to sometimes
        /// misreport for Bluetooth input devices — it can fail to flip back
        /// to inactive promptly (or at all) after the last consumer stops,
        /// which would surface here as a `MicStarted` that never gets a
        /// matching `MicStopped` until the device itself changes. There is
        /// no known workaround at the CoreAudio layer; this is a documented,
        /// accepted limitation, not a bug in this shim.
        pub fn start(tx: Sender<ShimEvent>) -> Result<Self> {
            let device_id = current_default_input_device()?;
            let initial_running = is_running_somewhere(device_id).unwrap_or(false);

            let ctx = Arc::new(ListenerCtx {
                tx,
                device_id: AtomicU32::new(device_id),
                last_running: AtomicBool::new(initial_running),
            });
            let ctx_ptr = Arc::into_raw(ctx);

            let mut running_addr = running_somewhere_address();
            let mut default_input_addr = default_input_device_address();
            let status = unsafe {
                AudioObjectAddPropertyListener(
                    device_id,
                    NonNull::from(&mut running_addr),
                    Some(device_is_running_listener),
                    ctx_ptr as *mut c_void,
                )
            };
            if status != 0 {
                // Reclaim immediately — nothing was registered, so there's
                // no listener that could still reference `ctx_ptr`.
                unsafe {
                    drop(Arc::from_raw(ctx_ptr));
                }
                return Err(MinuteError::Other(format!(
                    "AudioObjectAddPropertyListener(DeviceIsRunningSomewhere) failed: {status}"
                )));
            }

            let status = unsafe {
                AudioObjectAddPropertyListener(
                    kAudioObjectSystemObject as AudioObjectID,
                    NonNull::from(&mut default_input_addr),
                    Some(default_input_changed_listener),
                    ctx_ptr as *mut c_void,
                )
            };
            if status != 0 {
                unsafe {
                    let _ = AudioObjectRemovePropertyListener(
                        device_id,
                        NonNull::from(&mut running_addr),
                        Some(device_is_running_listener),
                        ctx_ptr as *mut c_void,
                    );
                    drop(Arc::from_raw(ctx_ptr));
                }
                return Err(MinuteError::Other(format!(
                    "AudioObjectAddPropertyListener(DefaultInputDevice) failed: {status}"
                )));
            }

            // Safety: `ctx_ptr` was just produced by `Arc::into_raw` above —
            // still valid, still exclusively ours at this point (nothing has
            // reclaimed it yet).
            let ctx_ref = unsafe { &*ctx_ptr };
            if initial_running {
                let _ = ctx_ref.tx.send(ShimEvent::MicStarted);
            }

            Ok(Self { ctx_ptr, device_id })
        }
    }

    impl Drop for MicMonitor {
        fn drop(&mut self) {
            let mut running_addr = running_somewhere_address();
            let mut default_input_addr = default_input_device_address();
            unsafe {
                let _ = AudioObjectRemovePropertyListener(
                    kAudioObjectSystemObject as AudioObjectID,
                    NonNull::from(&mut default_input_addr),
                    Some(default_input_changed_listener),
                    self.ctx_ptr as *mut c_void,
                );
                let _ = AudioObjectRemovePropertyListener(
                    self.device_id,
                    NonNull::from(&mut running_addr),
                    Some(device_is_running_listener),
                    self.ctx_ptr as *mut c_void,
                );
                // The one matching reclaim for `start`'s one `Arc::into_raw`
                // — see the struct docs for why this ordering (both
                // listeners removed first) is what makes it sound.
                drop(Arc::from_raw(self.ctx_ptr));
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn find_allowlisted_prefers_a_real_meeting_app_over_a_browser() {
            let running = vec!["com.google.Chrome".to_string(), "us.zoom.xos".to_string()];
            assert_eq!(find_allowlisted(&running), Some("Zoom".to_string()));
        }

        #[test]
        fn find_allowlisted_falls_back_to_a_browser_when_thats_all_that_matches() {
            let running = vec!["com.apple.Dock".to_string(), "com.google.Chrome".to_string()];
            assert_eq!(find_allowlisted(&running), Some("Chrome".to_string()));
        }

        #[test]
        fn find_allowlisted_recognizes_both_teams_bundle_ids() {
            assert_eq!(
                find_allowlisted(&["com.microsoft.teams2".to_string()]),
                Some("Microsoft Teams".to_string())
            );
            assert_eq!(
                find_allowlisted(&["com.microsoft.teams".to_string()]),
                Some("Microsoft Teams".to_string())
            );
        }

        #[test]
        fn find_allowlisted_is_deterministic_when_two_real_meeting_apps_are_both_running() {
            // Teams listed *before* Zoom in the running-apps order — proves
            // the result comes from `MEETING_APPS`'s own priority order
            // (Zoom first), not merely from whichever happened to appear
            // first in `NSWorkspace.runningApplications`'s (otherwise
            // unspecified, per Apple's own docs) ordering.
            let running = vec!["com.microsoft.teams2".to_string(), "us.zoom.xos".to_string()];
            assert_eq!(find_allowlisted(&running), Some("Zoom".to_string()));

            // Same two apps, running-list order flipped — still Zoom.
            let running_reversed = vec!["us.zoom.xos".to_string(), "com.microsoft.teams2".to_string()];
            assert_eq!(find_allowlisted(&running_reversed), Some("Zoom".to_string()));
        }

        #[test]
        fn find_allowlisted_none_when_nothing_matches() {
            let running = vec!["com.apple.Dock".to_string(), "com.apple.finder".to_string()];
            assert_eq!(find_allowlisted(&running), None);
        }

        /// Real FFI smoke test — attaches the actual CoreAudio listener
        /// pair on this machine's default input device, waits briefly, then
        /// detaches. Not run by default (needs real hardware/CoreAudio, and
        /// a panic here would mean an actual unsound `unsafe` bug, not a
        /// logic bug — that distinction is why this lives outside the
        /// ordinary `cargo test --lib` run): `cargo test --lib -- --ignored
        /// coreaudio_listener_attaches_and_detaches_without_panic`.
        #[test]
        #[ignore]
        fn coreaudio_listener_attaches_and_detaches_without_panic() {
            let (tx, _rx) = std::sync::mpsc::channel();
            let monitor =
                MicMonitor::start(tx).expect("failed to attach the CoreAudio listener pair");
            std::thread::sleep(std::time::Duration::from_secs(2));
            drop(monitor);
        }
    }
}

#[cfg(target_os = "macos")]
use macos::{MicMonitor, ShimEvent};

/// Non-macOS builds get an inert stand-in so the rest of this module (and
/// `lib.rs`) compiles the same everywhere — meeting detection is a macOS-
/// only feature (the plan's whole API map is macOS-specific), but nothing
/// else in the crate should have to `#[cfg]` around referencing
/// `detect::DetectorHandle`.
#[cfg(not(target_os = "macos"))]
mod macos {
    use std::sync::mpsc::Sender;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ShimEvent {
        MicStarted,
        MicStopped,
    }

    pub struct MicMonitor;

    impl MicMonitor {
        pub fn start(_tx: Sender<ShimEvent>) -> crate::error::Result<Self> {
            Err(crate::error::MinuteError::Other(
                "meeting detection is macOS-only".to_string(),
            ))
        }
    }

    pub fn meeting_app_present() -> Option<String> {
        None
    }
}

#[cfg(not(target_os = "macos"))]
use macos::{MicMonitor, ShimEvent};

// ---------------------------------------------------------------------------
// DetectorHandle — managed Tauri state, thread lifecycle
// ---------------------------------------------------------------------------

/// How often the detector thread wakes on its own (independent of real-time
/// mic events, which interrupt the wait immediately) to: re-check the
/// meeting-app allowlist while the mic is hot, poll the current recording
/// state, and notice a shutdown request. Matches the plan's "a 2s re-check
/// tick while mic stays hot is fine".
///
/// Known, accepted race: recording state is snapshotted at the top of each
/// iteration, so a recording started in the main window during an in-flight
/// wait can be missed for up to one interval — a prompt may fire for a call
/// the user just started recording. Harmless: the frontend's
/// already-recording guard makes `popup_start` a no-op and the pill
/// auto-dismisses.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One message the detector thread's main loop selects over — either a real
/// mic-activity transition (forwarded from the [`MicMonitor`]'s own channel
/// by a small adapter thread — see `start`'s docs) or an externally-reported
/// [`PromptOutcome`] (via [`report_outcome`]). Unifying both into one
/// `mpsc::Receiver` lets the thread's loop keep a single `recv_timeout` call
/// (see `run_detector_thread`) instead of juggling two channels with no
/// built-in `select!` for plain `std::sync::mpsc`.
#[derive(Debug)]
enum ThreadMsg {
    Shim(ShimEvent),
    Outcome(PromptOutcome),
}

struct RunningDetector {
    shutdown: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
    /// Clone of the detector thread's unified message channel sender — the
    /// seam [`report_outcome`] uses to deliver a popup's outcome into the
    /// running `DetectorCore` without either side needing a shared mutex.
    msg_tx: std::sync::mpsc::Sender<ThreadMsg>,
}

/// Managed state: at most one running detector thread. Empty (no thread) is
/// the default and the only state possible while `settings.meetingDetection`
/// is `false` — see the module docs' "zero detector threads" contract.
pub struct DetectorHandle {
    running: Mutex<Option<RunningDetector>>,
}

/// Shared handle to a [`DetectorHandle`] — same shape as every other managed
/// handle in this crate (`SharedStore`, `SharedSettings`, ...).
pub type SharedDetectorHandle = Arc<DetectorHandle>;

/// Creates an empty (not-yet-started), ready-to-`app.manage()` handle.
pub fn open_shared() -> SharedDetectorHandle {
    Arc::new(DetectorHandle {
        running: Mutex::new(None),
    })
}

/// Starts the detector thread if it isn't already running. A no-op if it is
/// (idempotent — `lib.rs`'s `setup` and `set_settings` can both call this
/// without either needing to track whether the other already did).
pub fn start(
    app: AppHandle,
    settings: SharedSettings,
    recorder: SharedRecorderState,
    handle: &SharedDetectorHandle,
) {
    let mut guard = lock(&handle.running);
    if guard.is_some() {
        return;
    }
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = shutdown.clone();
    // Built here (rather than inside `run_detector_thread`) so a clone of
    // the sender half can be stashed on `RunningDetector` for
    // `report_outcome` to use — the thread itself only ever needs the
    // receiver plus its own clone of the sender (for the mic-monitor
    // forwarding adapter — see the thread body).
    let (msg_tx, msg_rx) = std::sync::mpsc::channel::<ThreadMsg>();
    let outcome_tx = msg_tx.clone();
    let thread = std::thread::spawn(move || {
        run_detector_thread(app, settings, recorder, thread_shutdown, msg_tx, msg_rx)
    });
    *guard = Some(RunningDetector {
        shutdown,
        thread,
        msg_tx: outcome_tx,
    });
}

/// Delivers a shown prompt's outcome (Start/dismiss/timeout) into the
/// currently-running detector thread, if any — the seam `popup::popup_start`/
/// `popup::popup_dismiss` use to turn a user's click (or the popup's own
/// 12s auto-dismiss) into the `DetectorCore` transition that actually
/// applies the accepted-suppression/cooldown rule (see `DetectorCore::
/// process`'s `Outcome` arm). A silent no-op if nothing is running (e.g. a
/// stale popup outcome arriving after detection was toggled off, or — since
/// this crosses threads via a plain channel `send` — the vanishingly rare
/// race of the detector thread having just exited) — there is no `DetectorCore`
/// left for it to mean anything to either way.
pub fn report_outcome(handle: &SharedDetectorHandle, outcome: PromptOutcome) {
    if let Some(running) = lock(&handle.running).as_ref() {
        let _ = running.msg_tx.send(ThreadMsg::Outcome(outcome));
    }
}

/// Signals the detector thread to stop and joins it — after this returns,
/// there is genuinely no detector thread running (not merely a paused one;
/// see the module docs). A no-op if nothing is running.
pub fn stop(handle: &SharedDetectorHandle) {
    let running = lock(&handle.running).take();
    if let Some(running) = running {
        running.shutdown.store(true, Ordering::SeqCst);
        let _ = running.thread.join();
    }
}

/// Applies a live settings change: starts the thread if `enabled` and
/// nothing's running, stops it if `!enabled` and something is — called from
/// `set_settings` (see `lib.rs`) right after a `meetingDetection` patch is
/// persisted.
pub fn set_enabled_live(
    app: AppHandle,
    settings: SharedSettings,
    recorder: SharedRecorderState,
    handle: &SharedDetectorHandle,
    enabled: bool,
) {
    if enabled {
        start(app, settings, recorder, handle);
    } else {
        stop(handle);
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingDetectedEvent {
    app_name: String,
}

/// Whether at least one STT catalog entry is installed under the app's data
/// dir right now — mirrors the frontend's own gate (`useModelManager`'s
/// re-gate check, `OnboardingView`'s `hasInstalledStt`: `models.some(m =>
/// m.kind === 'stt' && m.state === 'installed')`) so the backend detector can
/// never disagree with what onboarding/gating has already decided — see
/// [`DetectorEvent::SetSttModelInstalled`]'s docs for the edge this closes.
/// Fails closed (`false`) on any lookup error (app-data-dir unresolvable, a
/// corrupt embedded catalog) rather than failing open: a false negative here
/// only ever costs a suppressed prompt that could have fired; a false
/// positive would let a popup nobody can actually act on slip through during
/// onboarding, which is the exact bug this input exists to close.
fn any_stt_model_installed(app: &AppHandle) -> bool {
    let Ok(models_root) = app.path().app_data_dir() else {
        return false;
    };
    let Ok(entries) = catalog::load_catalog() else {
        return false;
    };
    entries.iter().any(|entry| {
        entry.kind == ModelKind::Stt && catalog::install_state(entry, &models_root) == catalog::InstallState::Installed
    })
}

fn emit_meeting_detected(app: &AppHandle, app_name: &str) {
    let event = MeetingDetectedEvent {
        app_name: app_name.to_string(),
    };
    if let Err(e) = app.emit("meeting-detected", event) {
        log::warn!("failed to emit meeting-detected for {app_name}: {e}");
    }
}

/// The detector thread body: owns a [`MicMonitor`] (real listeners on
/// macOS, an inert stub elsewhere — see the two `macos` module variants
/// above) and a [`DetectorCore`], translating shim events, periodic ticks,
/// and reported prompt outcomes into `Action`s, emitting `meeting-detected`
/// to the frontend AND triggering the popup panel
/// (`popup::show_meeting_prompt`) on `ShowPrompt`.
///
/// `msg_tx`/`msg_rx` are the unified [`ThreadMsg`] channel `start` built —
/// this function's own job with `msg_tx` is only to hand a clone to a small
/// adapter thread that forwards the `MicMonitor`'s raw `ShimEvent`s into it
/// (translating the mic monitor's own narrower channel type into the wider
/// one this loop actually selects over); `report_outcome` (running on
/// whatever thread a Tauri command handler runs on) sends directly into its
/// own clone of the same sender, kept on `RunningDetector` — see `start`'s
/// docs. The adapter thread exits on its own once `_monitor` (owning the
/// `MicMonitor`'s send half) is dropped at the end of this function, closing
/// its `recv()` loop; it's never explicitly joined (a short-lived, harmless
/// leak-until-it-notices-the-close, same shape as every other detached
/// helper thread in this crate — see e.g. `lib.rs`'s audio sweep thread).
///
/// Runs until `shutdown` is set — checked every [`POLL_INTERVAL`], which
/// also doubles as the cadence for polling `recorder`/re-checking the
/// meeting-app allowlist while the mic is hot (see `POLL_INTERVAL`'s docs).
/// A real mic transition or a reported outcome interrupts the wait
/// immediately regardless of this cadence — only the periodic app-presence
/// re-check actually needs the timeout to fire.
fn run_detector_thread(
    app: AppHandle,
    _settings: SharedSettings,
    recorder: SharedRecorderState,
    shutdown: Arc<AtomicBool>,
    msg_tx: std::sync::mpsc::Sender<ThreadMsg>,
    msg_rx: std::sync::mpsc::Receiver<ThreadMsg>,
) {
    let (shim_tx, shim_rx) = std::sync::mpsc::channel::<ShimEvent>();
    let _monitor = match MicMonitor::start(shim_tx) {
        Ok(monitor) => monitor,
        Err(e) => {
            log::warn!("meeting detector thread exiting: failed to start mic monitor: {e}");
            return;
        }
    };

    // Forwards the mic monitor's own `ShimEvent`s into the unified
    // `ThreadMsg` channel this loop actually reads — see this function's
    // docs for why a separate small thread (rather than trying to make
    // `MicMonitor` speak `ThreadMsg` directly) is the simplest way to unify
    // two independently-typed channels without a `select!` macro.
    std::thread::spawn(move || {
        while let Ok(event) = shim_rx.recv() {
            if msg_tx.send(ThreadMsg::Shim(event)).is_err() {
                break;
            }
        }
    });

    let mut core = DetectorCore::new(true);
    let mut mic_active = false;

    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }

        let recording = crate::audio::is_recording_active(&recorder);
        core.process(DetectorEvent::SetMinuteRecording(recording), Instant::now());

        // Same every-iteration polling shape as the recording-state check
        // just above — see `DetectorEvent::SetSttModelInstalled`'s docs for
        // why this needs to be re-checked continuously rather than only at
        // startup (a model can be deleted well after the thread starts).
        let stt_installed = any_stt_model_installed(&app);
        core.process(DetectorEvent::SetSttModelInstalled(stt_installed), Instant::now());

        let action = match msg_rx.recv_timeout(POLL_INTERVAL) {
            Ok(ThreadMsg::Shim(ShimEvent::MicStarted)) => {
                mic_active = true;
                core.process(DetectorEvent::MicStarted, Instant::now())
            }
            Ok(ThreadMsg::Shim(ShimEvent::MicStopped)) => {
                mic_active = false;
                core.process(DetectorEvent::MicStopped, Instant::now())
            }
            Ok(ThreadMsg::Outcome(outcome)) => core.process(DetectorEvent::Outcome(outcome), Instant::now()),
            Err(RecvTimeoutError::Timeout) => {
                if mic_active {
                    let app_present = macos::meeting_app_present();
                    core.process(DetectorEvent::Tick { meeting_app_present: app_present }, Instant::now())
                } else {
                    Action::None
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                // Shouldn't happen in practice — `RunningDetector` holds a
                // live `ThreadMsg` sender (see `start`'s `outcome_tx`) for
                // as long as this thread might be running, so every sender
                // being dropped implies something unexpected already went
                // wrong upstream. Exiting the thread is still the right
                // call if it somehow does: there's nothing left that could
                // ever feed this loop another message.
                log::warn!("meeting detector thread exiting: message channel disconnected");
                break;
            }
        };

        if let Action::ShowPrompt { app_name } = action {
            emit_meeting_detected(&app, &app_name);
            crate::popup::show_meeting_prompt(&app, &app_name);
        }
    }
}

#[cfg(test)]
mod handle_tests {
    //! `report_outcome`'s plumbing — Stage 5 Task 2's "outcome-channel
    //! seam" (see the plan's Task 2 verify list). Doesn't spin up a real
    //! `run_detector_thread`/`MicMonitor` (hardware-dependent, see that
    //! function's own docs) — instead hand-assembles a `RunningDetector`
    //! around a plain channel, the exact same shape `start` wires up, so
    //! `report_outcome`'s "find the running slot, forward the message" logic
    //! is exercised without any CoreAudio/NSWorkspace dependency.
    use super::*;

    #[test]
    fn report_outcome_is_a_no_op_when_nothing_is_running() {
        let handle = open_shared();
        // No detector thread was ever started — must not panic and must not
        // block; there's simply nothing for the outcome to reach.
        report_outcome(&handle, PromptOutcome::Dismissed);
    }

    #[test]
    fn report_outcome_delivers_onto_the_running_detectors_message_channel() {
        let (msg_tx, msg_rx) = std::sync::mpsc::channel::<ThreadMsg>();
        let handle = open_shared();
        *lock(&handle.running) = Some(RunningDetector {
            shutdown: Arc::new(AtomicBool::new(false)),
            // No real detector thread backs this — nothing here ever calls
            // `stop()` (which would join it), so a real thread handle would
            // just leak silently when `handle` drops at the end of this
            // test. An already-finished no-op thread's `JoinHandle` is the
            // honest stand-in: it detaches on drop exactly the same way,
            // without pretending there's live work behind it.
            thread: std::thread::spawn(|| {}),
            msg_tx,
        });

        report_outcome(&handle, PromptOutcome::Accepted);

        match msg_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(ThreadMsg::Outcome(PromptOutcome::Accepted)) => {}
            other => panic!("expected ThreadMsg::Outcome(Accepted), got {other:?}"),
        }
    }

    #[test]
    fn report_outcome_does_not_panic_once_the_running_slot_has_been_cleared() {
        // Mirrors what a real `stop()` leaves behind: the slot goes back to
        // `None`, and a `report_outcome` racing in right after (e.g. a
        // stale popup outcome arriving just as detection was toggled off)
        // must find nothing to deliver to rather than panicking on a stale
        // reference.
        let (msg_tx, _msg_rx) = std::sync::mpsc::channel::<ThreadMsg>();
        let handle = open_shared();
        *lock(&handle.running) = Some(RunningDetector {
            shutdown: Arc::new(AtomicBool::new(false)),
            thread: std::thread::spawn(|| {}),
            msg_tx,
        });
        *lock(&handle.running) = None;

        report_outcome(&handle, PromptOutcome::TimedOut);
    }
}
