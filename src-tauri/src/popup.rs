//! Stage 5 Task 2: the "meeting detected" pill — a small, always-on-top,
//! non-activating window that pops up top-center of whatever display the
//! mouse is on when [`crate::detect::DetectorCore`] decides to show a
//! prompt, and two commands (`popup_start`/`popup_dismiss`) the popup's own
//! frontend (`src/popup/`) calls to resolve it.
//!
//! ## Why `tauri-nspanel`
//! A plain Tauri `always_on_top` window still activates the app and can get
//! buried under (or fight z-order with) a fullscreen call — Tauri's own
//! always-on-top-over-fullscreen support has open bugs (tauri-apps/tauri
//! #11488, #5566; see the research doc this stage's plan cites). The fix on
//! macOS is an actual `NSPanel` with the `nonactivatingPanel` style mask
//! (never activates the owning app, even when clicked) plus
//! `canJoinAllSpaces | fullScreenAuxiliary` collection behavior (renders
//! over a fullscreen app's own Space instead of being banished to a
//! different one) — `tauri-nspanel` is a thin, actively-maintained wrapper
//! over exactly that ObjC surface, so this module leans on it rather than
//! hand-rolling the class-swap dance itself.
//!
//! `tauri-nspanel` isn't published on crates.io (confirmed against the
//! crates.io API directly before adding it — no such crate exists there);
//! upstream ships it as a git-only crate instead. `Cargo.toml` pins an exact
//! commit on its `v2.1` branch (the one built against Tauri 2 — the older
//! `v2` branch predates it) rather than floating on the branch HEAD, the
//! same "never float on a moving target" rule this crate's other pinned
//! macOS dependencies already follow.
//!
//! ## What's actually verified here vs. only testable in a signed release
//! `panel.show()` (see `ensure_window`/`show_meeting_prompt`) calls
//! `orderFrontRegardless` under the hood — confirmed by reading
//! `tauri-nspanel`'s own macro-generated `Panel::show` impl — which is
//! exactly the "make visible without activating/keying the window" call
//! this feature needs, and the `nonactivating_panel` style mask plus
//! `can_join_all_spaces`/`full_screen_auxiliary` collection behavior calls
//! below are set unconditionally every time the panel is created. What this
//! module's automated tests (there are none — see below) and an ordinary
//! `cargo test`/dev-build run can **not** independently confirm is the
//! *visual* end-to-end claim the plan's research doc flags as a known open
//! area: that the panel actually renders on top of another app's real
//! fullscreen Space in a signed, notarized release build. That's the stage
//! gate's (Task 6) manual matrix item, not something this task can respect
//! its own "TDD hard-first" convention for — there is no pure decision logic
//! in here to unit-test in the first place, only NSPanel/AppKit plumbing
//! (see the module-level "kept thin" note below).
//!
//! ## Kept thin, deliberately
//! Unlike `detect.rs`'s `DetectorCore`, there is no pure decision core to
//! pull out of this module — window creation, positioning, and show/hide
//! are all real AppKit side effects with no meaningful "logic" to test in
//! isolation (the one real decision — *whether* to prompt at all — already
//! lives entirely in `DetectorCore`, upstream of this module ever being
//! called). This module's own Rust tests are limited to what `detect.rs`'s
//! `handle_tests` already covers (the outcome-channel seam `popup_start`/
//! `popup_dismiss` drive); the frontend pill's *content* logic (countdown,
//! button wiring, keyboard handling) is unit-tested on the TypeScript side
//! instead (`src/popup/Pill.test.tsx`), where it's actually pure enough to
//! test cheaply.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::detect::{self, PromptOutcome, SharedDetectorHandle};

/// Window/panel label — also the frontend's own `meeting-popup-payload`
/// listen target (`app.emit_to(PANEL_LABEL, ...)` in `deliver_prompt`).
pub const PANEL_LABEL: &str = "meeting-popup";

/// Logical pixel size of the pill window — height matches the plan's
/// "~380×72"; width was widened from the plan's original 380 to 470 after
/// confirming the subtitle's ellipsis (see `src/popup/Pill.tsx`) genuinely
/// clipped real copy ("Another app is using the microphone", "Microsoft
/// Teams is using the microphone") at 380. Keep this in lockstep with
/// `Pill.tsx`'s own `width` — that inline style is sized for exactly this
/// window, not a general-purpose layout.
const PANEL_WIDTH: f64 = 470.0;
const PANEL_HEIGHT: f64 = 72.0;

/// Logical-pixel gap between the top of the target display's work area
/// (i.e. below the menu bar, not the raw screen edge) and the pill's own
/// top edge.
const TOP_MARGIN: f64 = 16.0;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingPopupPayload {
    app_name: String,
}

/// Shows (creating once, then reusing for the rest of the app's lifetime)
/// the meeting-detected pill for `app_name`, positioned top-center of
/// whichever display currently has the mouse cursor. Called by
/// `detect::run_detector_thread` on every `Action::ShowPrompt` — see that
/// function's docs.
#[cfg(target_os = "macos")]
pub fn show_meeting_prompt(app: &AppHandle, app_name: &str) {
    macos::show_meeting_prompt(app, app_name)
}

#[cfg(not(target_os = "macos"))]
pub fn show_meeting_prompt(_app: &AppHandle, _app_name: &str) {
    // Meeting detection (and therefore its popup) is macOS-only — see
    // detect.rs's module docs. `run_detector_thread` itself never runs on
    // other platforms (its `MicMonitor::start` stub always errors out
    // immediately), so this is never actually reached there either; it
    // exists purely so the crate compiles the same on every target, same
    // rationale as `detect.rs`'s own non-macOS `mod macos` stub.
}

/// Hides the popup panel, if one currently exists — a no-op if
/// `show_meeting_prompt` was never called (nothing was ever created) or the
/// panel is already hidden. Used by `popup_start`/`popup_dismiss` below.
#[cfg(target_os = "macos")]
fn hide(app: &AppHandle) {
    macos::hide(app)
}

#[cfg(not(target_os = "macos"))]
fn hide(_app: &AppHandle) {}

/// Resolves the currently-shown prompt as "Start recording": hides the
/// panel, reports [`PromptOutcome::Accepted`] to the detector (see
/// `detect::report_outcome` — this is what actually applies the "no prompt
/// again until the mic drops" suppression), brings the main window forward,
/// and emits `meeting-popup-start` for the main frontend to react to.
///
/// ## Why an event, not calling `start_recording` from here
/// The obvious-looking alternative — have this command call
/// `audio::start_recording` directly, server-side — was deliberately
/// rejected. `useAppState`'s `startRec` (the *only* place the main window's
/// `view` actually navigates to `'recording'`) does that navigation itself,
/// synchronously in its own `ipc.startRecording(...).then(...)` callback; it
/// is **not** driven by listening for a `recording-state` event (that event
/// only ever updates the already-showing recording view's elapsed/paused
/// fields — see `useAppState`'s `onRecordingState` handler). So a
/// server-side `start_recording` call here would start the *backend*
/// recording fine, but the main window's `view` would never move off
/// whatever screen it was already showing — the user would see the popup
/// vanish and... nothing else happen, until they happened to notice the
/// title bar's REC pill.
///
/// It also can't honestly enforce the plan's "no STT model installed ->
/// don't record, open onboarding instead" rule from here: `start_recording`
/// itself has no such guard (it happily records with no live transcript if
/// the resolved model isn't installed — see `audio::
/// spawn_stt_worker_if_model_installed`), and the actual "is a model
/// installed" gate the rest of the app already has
/// (`hasInstalledStt`/`view === 'onboarding'` in `useAppState`'s initial
/// load effect) only exists as frontend state today, not a backend command.
/// Re-deriving that same check here (re-reading the catalog + settings, an
/// almost-verbatim copy of `spawn_stt_worker_if_model_installed`'s own
/// install-state lookup) would be a second, easy-to-drift copy of a check
/// that already lives correctly on the frontend.
///
/// So instead: this command does only what's genuinely backend-only work
/// (resolve the detector outcome, un-hide the main window) and emits one
/// plain event; `useAppState`'s `meeting-popup-start` listener (Task 2's
/// frontend half) re-runs the exact same `startRec()` a normal button click
/// would, if a model is installed, or navigates to onboarding with an
/// honest message otherwise — reusing the one already-tested decision
/// instead of duplicating it on this side of the IPC boundary.
#[tauri::command]
pub fn popup_start(app: AppHandle, detector: State<SharedDetectorHandle>) -> Result<(), String> {
    hide(&app);
    detect::report_outcome(&detector, PromptOutcome::Accepted);

    if let Some(main) = app.get_webview_window("main") {
        // Best-effort: a failure here (window already gone, an already-
        // torn-down webview during shutdown) shouldn't stop the outcome
        // from having already been reported above, nor stop the
        // `meeting-popup-start` event below from still going out.
        if let Err(e) = main.show() {
            log::warn!("popup_start: failed to show the main window: {e}");
        }
        if let Err(e) = main.set_focus() {
            log::warn!("popup_start: failed to focus the main window: {e}");
        }
    }

    app.emit("meeting-popup-start", ())
        .map_err(|e| format!("failed to emit meeting-popup-start: {e}"))
}

/// Resolves the currently-shown prompt as dismissed — either the quiet ×
/// (`timed_out: false`) or the popup's own 12s auto-dismiss timer
/// (`timed_out: true`); either way `DetectorCore` applies the same 15-minute
/// cooldown (see `PromptOutcome::Dismissed`/`TimedOut`'s shared handling in
/// `DetectorCore::process`), so the only thing that actually differs here is
/// which variant gets reported.
#[tauri::command]
pub fn popup_dismiss(app: AppHandle, detector: State<SharedDetectorHandle>, timed_out: bool) -> Result<(), String> {
    hide(&app);
    let outcome = if timed_out {
        PromptOutcome::TimedOut
    } else {
        PromptOutcome::Dismissed
    };
    detect::report_outcome(&detector, outcome);
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    //! The real NSPanel plumbing — see the module-level docs above for why
    //! this stays free of anything worth unit-testing.

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder};
    use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

    use super::{MeetingPopupPayload, PANEL_HEIGHT, PANEL_LABEL, PANEL_WIDTH, TOP_MARGIN};

    // Non-activating: `can_become_key_window: true` alongside the
    // `nonactivating_panel` style mask set below is the actual combination
    // that lets the pill's buttons (and, if the user clicks into it, the
    // Enter/Escape handlers — see `src/popup/Pill.tsx`'s docs for that
    // caveat) receive keyboard input *without* the panel activating Minute
    // or stealing focus from whatever fullscreen app is running — this is
    // the standard non-activating-panel recipe (Spotlight-style overlays
    // use the same shape), not a contradiction. `can_become_main_window:
    // false` keeps it from ever being mistaken for the app's main window by
    // anything that asks AppKit for one.
    tauri_panel! {
        panel!(MeetingPopupPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true
            }
        })
    }

    /// Tracks whether the popup webview's very first page load has finished
    /// — see `show_meeting_prompt`'s docs for the race this exists to close
    /// (emitting `meeting-popup-payload` before the popup's own
    /// `useEffect`-registered listener has mounted would silently lose the
    /// event; Tauri does not buffer events for a not-yet-listening
    /// webview). `pending` is the one request (if any) that arrived before
    /// that first load finished, delivered by `on_page_load` the instant it
    /// does.
    #[derive(Default)]
    struct PopupState {
        ready: AtomicBool,
        pending: Mutex<Option<String>>,
    }

    fn lock_pending(state: &PopupState) -> std::sync::MutexGuard<'_, Option<String>> {
        state.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn show_meeting_prompt(app: &AppHandle, app_name: &str) {
        let window = match ensure_window(app) {
            Ok(window) => window,
            Err(e) => {
                log::warn!("meeting popup: failed to create/reuse the popup window: {e}");
                return;
            }
        };

        position_top_center_at_cursor(app, &window);

        let state = app.state::<PopupState>();
        if state.ready.load(Ordering::SeqCst) {
            deliver_prompt(app, app_name);
        } else {
            // First-ever popup of this session and its page hasn't finished
            // loading yet — stash the request; `on_page_load` below
            // delivers it (and shows the panel) the moment the page's own
            // `meeting-popup-payload` listener is actually mounted, rather
            // than risking the emit landing before anything is listening.
            *lock_pending(&state) = Some(app_name.to_string());
        }
    }

    pub fn hide(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
            panel.hide();
        }
    }

    /// Emits the payload to the (already-loaded) popup webview and shows the
    /// panel — the "deliver" half of `show_meeting_prompt`, split out so
    /// both the ready-immediately path and `on_page_load`'s deferred path
    /// funnel through the exact same two steps.
    fn deliver_prompt(app: &AppHandle, app_name: &str) {
        let payload = MeetingPopupPayload {
            app_name: app_name.to_string(),
        };
        if let Err(e) = app.emit_to(PANEL_LABEL, "meeting-popup-payload", payload) {
            log::warn!("meeting popup: failed to emit meeting-popup-payload: {e}");
        }
        if let Ok(panel) = app.get_webview_panel(PANEL_LABEL) {
            // `Panel::show`'s implementation is `orderFrontRegardless` (see
            // the module-level docs' "what's verified" section) — this is
            // the actual "don't steal focus" behavior, not merely a naming
            // convention on tauri-nspanel's part.
            panel.show();
        } else {
            log::warn!("meeting popup: panel handle missing right after ensure_window — should be unreachable");
        }
    }

    /// Creates the popup window+panel once and reuses it for the rest of
    /// the app's lifetime; a no-op (returns the existing window) on every
    /// call after the first.
    fn ensure_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
        if let Some(window) = app.get_webview_window(PANEL_LABEL) {
            return Ok(window);
        }

        app.manage(PopupState::default());

        let window = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("popup.html".into()))
            .title("Meeting detected")
            .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
            .decorations(false)
            .transparent(true)
            // The pill's own CSS box-shadow (see src/popup/Pill.tsx) is what
            // should actually show — a native window shadow would draw a
            // plain rectangle behind the transparent margins around the
            // pill's rounded shape, which reads as a bug, not a design
            // choice.
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .on_page_load(|webview, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    on_popup_ready(webview.app_handle());
                }
            })
            .build()?;

        let panel = window.to_panel::<MeetingPopupPanel>()?;
        panel.set_level(PanelLevel::Floating.value());
        // `nonactivating_panel`: never activates Minute, even if the user
        // clicks into the pill — see this module's `MeetingPopupPanel`
        // config docs above for why that's still compatible with the pill's
        // buttons (and best-effort keyboard handling) actually working.
        panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
        // `full_screen_auxiliary` + `can_join_all_spaces`: renders over a
        // fullscreen call's own Space instead of getting shuffled to a
        // separate one — see the module-level docs' Tauri #11488/#5566
        // note for what's genuinely still only release-build-verifiable
        // about this.
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces()
                .into(),
        );

        Ok(window)
    }

    /// `on_page_load`'s `PageLoadEvent::Finished` hook: marks the popup
    /// ready and, if a `show_meeting_prompt` call arrived before this fired
    /// (see `show_meeting_prompt`'s `pending` branch), delivers it now.
    fn on_popup_ready(app: &AppHandle) {
        let state = app.state::<PopupState>();
        state.ready.store(true, Ordering::SeqCst);
        // Split into its own `let` (rather than `if let Some(app_name) =
        // lock_pending(&state).take() { ... }`) so the `MutexGuard`
        // temporary — which, through `State`'s `Deref`, ends up borrowing
        // from `state` — is dropped at the end of this statement instead of
        // having its lifetime extended across the whole `if` block, which
        // `state` (a plain local binding) doesn't outlive.
        let pending = lock_pending(&state).take();
        if let Some(app_name) = pending {
            deliver_prompt(app, &app_name);
        }
    }

    /// Positions `window` top-center of whichever display currently has the
    /// mouse cursor, falling back to the primary monitor if the cursor's
    /// position can't be read or doesn't resolve to a monitor (e.g. a
    /// display was just unplugged) — multi-display handling the plan calls
    /// for. Uses Tauri's own `cursor_position`/`monitor_from_point`
    /// (`AppHandle` methods, backed by the same platform APIs the plan's
    /// research doc suggested reaching for directly via raw `objc2`
    /// `NSScreen`/`NSEvent` mouseLocation) rather than dropping to `objc2`
    /// here too — Tauri's own monitor API already returns exactly the
    /// physical-pixel position/size/work-area/scale-factor this needs, so
    /// there's nothing the raw AppKit call would buy beyond what's already
    /// unsafe-free.
    fn position_top_center_at_cursor(app: &AppHandle, window: &tauri::WebviewWindow) {
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());

        let Some(monitor) = monitor else {
            log::warn!("meeting popup: no monitor found to position against — leaving at its default position");
            return;
        };

        let scale = monitor.scale_factor();
        let work_area = monitor.work_area();
        let panel_width_px = PANEL_WIDTH * scale;
        let x = work_area.position.x as f64 + (work_area.size.width as f64 - panel_width_px) / 2.0;
        let y = work_area.position.y as f64 + TOP_MARGIN * scale;

        if let Err(e) = window.set_position(Position::Physical(PhysicalPosition::new(x as i32, y as i32))) {
            log::warn!("meeting popup: failed to position the popup window: {e}");
        }
    }
}
