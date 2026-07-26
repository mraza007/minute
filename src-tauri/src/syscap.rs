//! System-audio capture (Stage 5 Task 4): ScreenCaptureKit audio-only
//! stream — "record the other side of the call, not just the mic."
//!
//! Same three-piece split as `audio.rs`/`detect.rs`:
//!
//! 1. **Permission/availability state machine** ([`SysAudioAvailability`],
//!    [`resolve_availability`]) — pure, fully unit-tested, zero `unsafe`.
//! 2. **Sample pipeline** ([`bytes_to_f32_le`], [`DecodedAudioBuffer`],
//!    [`downmix_sck_buffers_to_mono`], [`BlockBatcher`]) — also pure and
//!    unit-tested: decoding a `CMSampleBuffer`'s raw audio bytes, downmixing
//!    to mono, and batching into fixed-size blocks, independent of both
//!    ScreenCaptureKit's own types and of `Recorder`'s hardware-facing code.
//!    Reuses `audio::downmix_to_mono`/`audio::LinearResampler` — the exact
//!    two pieces this task's plan calls out for reuse — rather than
//!    reimplementing them; both are already crate-visible (`pub fn`/`pub
//!    struct` inside `audio.rs`'s *private* `mod audio` in `lib.rs`, which
//!    is the same effective visibility a `pub(crate)` marker would give,
//!    just without the redundant keyword — see `audio.rs`'s own items).
//! 3. **Thin macOS glue** (`mod capture`, `#[cfg(target_os = "macos")]`):
//!    [`SysCapture`] — owns a real `SCStream` (via `objc2-screen-capture-kit`,
//!    a plain header-generated Objective-C framework binding — no Swift
//!    toolchain involved, same shape as the already-present
//!    `objc2-app-kit`/`objc2-core-audio`) configured audio-only, wires its
//!    callback through the pure pipeline above, and forwards fixed-size
//!    mono-at-16kHz blocks over a bounded `SyncSender<Arc<Vec<f32>>>` — the
//!    exact channel shape `Recorder`'s mic path already uses (see
//!    `audio.rs`'s `sample_tx`). A non-macOS stub keeps the crate compiling
//!    everywhere, mirroring `detect.rs`'s `MicMonitor` split (this app only
//!    ships for macOS in practice, but nothing else in the crate has to
//!    `#[cfg]` around referencing this module).
//!
//! ## What ScreenCaptureKit actually delivers
//!
//! `SCStreamConfiguration.sampleRate`/`.channelCount` configure the
//! *requested* format (this module asks for 48kHz stereo — Apple's own
//! documented default). What actually arrives per callback is a
//! `CMSampleBuffer` whose `AudioBufferList` (read via
//! `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`) yields one or
//! more `AudioBuffer`s of raw little-endian `Float32` bytes — Apple's own
//! `ScreenCaptureKit`/`CoreMedia` documentation doesn't pin down
//! **interleaving** for a requested 2-channel stream: Core Audio's two
//! possible shapes are (a) one buffer with `mNumberChannels == 2`, samples
//! interleaved L/R/L/R/…, or (b) two buffers each with `mNumberChannels ==
//! 1` (planar/non-interleaved — Core Audio's own canonical internal format,
//! and the shape most independent third-party reports of `SCStream`'s audio
//! output describe). Rather than assume either,
//! [`downmix_sck_buffers_to_mono`] handles both shapes explicitly (see its
//! own docs), and `mod capture`'s `SCStreamOutput` callback logs the
//! actually-observed shape once per session (buffer count +
//! channels-per-buffer) so this is verified from real runtime logs rather
//! than left as a permanent assumption — see this task's e2e test docs for
//! what was actually observed on this machine.
//!
//! ## Feedback prevention: `excludesCurrentProcessAudio`, not app-exclusion
//!
//! The plan called for excluding Minute's own process via
//! `SCContentFilter`'s `excludingApplications` (looking up Minute's own
//! `SCRunningApplication` by bundle id). `SCStreamConfiguration` instead
//! exposes `excludesCurrentProcessAudio` directly — a purpose-built flag for
//! exactly this (Apple's own header doc: prevents feedback loops in
//! recording applications) that needs no bundle-id lookup and can't fail to
//! find "self" in the shareable-content snapshot. Used here instead as a
//! strictly more robust equivalent — same effect, simpler and one fewer
//! failure mode.
//!
//! ## Video: never consumed, deliberately minimized
//!
//! `SCStream` always produces a video track internally even when only audio
//! is wanted (there's no audio-only capture mode in the API) — this module
//! never registers a `Screen`-type output handler (so no frame is ever
//! decoded or copied on this side) and additionally minimizes the
//! configured video work itself: a 2×2 frame size and 1 fps (the smallest
//! practical, rather than 0, in case a real 0×0 size is rejected by some
//! macOS version — untested in this environment, see the module's e2e
//! test docs for why).
//!
//! ## macOS 11/12 launchability
//!
//! `ScreenCaptureKit.framework` doesn't exist before macOS 12.3 (13.0 for
//! audio) — well above this crate's declared 11.0 floor
//! (`tauri.conf.json`'s `minimumSystemVersion`). Objective-C framework
//! bindings like `objc2-screen-capture-kit` link the framework the normal
//! (hard) way; a hard `LC_LOAD_DYLIB` on a framework absent on macOS 11/12
//! would make dyld refuse to launch the *entire app* there, not just
//! gracefully report [`SysAudioAvailability::Unsupported`] here — this is
//! solved on this crate's own side, not by vendoring a dependency: see
//! `build.rs`'s `cargo:rustc-link-arg=-weak_framework` lines (weak-linking
//! `ScreenCaptureKit.framework`, verified via `otool -l` on the actual
//! built binary — see that build script's comment for the full writeup).
//! Every `SCK` symbol this module touches (including class lookups, which
//! themselves fault under weak linking if the framework is genuinely
//! absent) stays behind [`sys_audio_status`]'s runtime availability check
//! — `mod capture` is only ever reached once that reports `Ready`.

use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::audio::downmix_to_mono;

/// Locks a [`Mutex`], recovering from lock poisoning instead of
/// propagating it — same rationale as `store::lock_store`. Used by `mod
/// capture`'s `did_output_sample_buffer` callback (guarding `CallbackState`)
/// once a real recording actually starts system-audio capture (Stage 5 Task
/// 5's `Recorder::start`).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// SysAudioAvailability — pure permission/version state machine
// ---------------------------------------------------------------------------

/// What Minute can honestly report about system-audio capture right now.
///
/// Deliberately **three** states, not four. The plan sketched a possible
/// `PermissionNeeded` vs. `PermissionDenied` split, flagged with a "assess
/// what's actually detectable" — and the honest answer is: not
/// distinguishable. `CGPreflightScreenCaptureAccess()` (the only query
/// primitive available, short of parsing `tccutil`/the private TCC.db,
/// which this app has no business touching) returns a plain `bool` —
/// "currently authorized" or not — with no way to tell "never asked" apart
/// from "the user explicitly denied it". Inventing a fourth state here
/// would just be guessing; `NotGranted` names what's actually knowable
/// (permission needs to be requested/re-requested — one flow either way)
/// without pretending to know which of the two real-world cases it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SysAudioAvailability {
    /// macOS is below the version ScreenCaptureKit audio capture needs
    /// (13.0). Not a permission question at all — asking would be
    /// pointless (and, per `Cargo.toml`'s patch notes, was a genuine
    /// crash-on-launch risk before this crate weak-linked the framework).
    Unsupported,
    /// macOS 13+, but `CGPreflightScreenCaptureAccess()` currently reports
    /// not authorized — either never decided or explicitly denied; see
    /// this enum's own docs for why those two aren't distinguishable.
    NotGranted,
    /// macOS 13+ and Screen Recording is currently authorized.
    /// [`SysCapture::start`] can be attempted (though see
    /// `request_sys_audio_permission`'s docs for a caveat about a
    /// just-granted permission needing an app restart to actually take
    /// effect for a live capture attempt).
    Ready,
}

/// Wire payload for `sys_audio_status`/`request_sys_audio_permission`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysAudioStatus {
    pub availability: SysAudioAvailability,
}

/// Pure decision: given the runtime macOS major version and the current
/// Screen Recording preflight result, what should be reported? Factored out
/// from the two commands below so it's testable without touching
/// `NSProcessInfo`/`CoreGraphics` at all.
pub(crate) fn resolve_availability(macos_major: i64, screen_recording_granted: bool) -> SysAudioAvailability {
    if macos_major < 13 {
        SysAudioAvailability::Unsupported
    } else if screen_recording_granted {
        SysAudioAvailability::Ready
    } else {
        SysAudioAvailability::NotGranted
    }
}

#[cfg(test)]
mod availability_tests {
    use super::*;

    #[test]
    fn below_13_is_unsupported_even_if_granted() {
        assert_eq!(resolve_availability(11, true), SysAudioAvailability::Unsupported);
        assert_eq!(resolve_availability(12, true), SysAudioAvailability::Unsupported);
    }

    #[test]
    fn below_13_is_unsupported_when_not_granted_too() {
        assert_eq!(resolve_availability(11, false), SysAudioAvailability::Unsupported);
    }

    #[test]
    fn exactly_13_and_granted_is_ready() {
        assert_eq!(resolve_availability(13, true), SysAudioAvailability::Ready);
    }

    #[test]
    fn exactly_13_and_not_granted_is_not_granted() {
        assert_eq!(resolve_availability(13, false), SysAudioAvailability::NotGranted);
    }

    #[test]
    fn well_above_13_still_gates_on_permission() {
        assert_eq!(resolve_availability(15, true), SysAudioAvailability::Ready);
        assert_eq!(resolve_availability(15, false), SysAudioAvailability::NotGranted);
    }
}

// ---------------------------------------------------------------------------
// availability_shim — macOS version + Screen Recording TCC (thin, unsafe-free)
// ---------------------------------------------------------------------------

/// `NSProcessInfo`/`CoreGraphics` calls backing [`resolve_availability`]'s
/// two inputs. No `unsafe` at all here — both
/// `objc2_core_graphics::{CGPreflightScreenCaptureAccess,
/// CGRequestScreenCaptureAccess}` and
/// `objc2_foundation::NSProcessInfo::operatingSystemVersion` are safe Rust
/// functions (confirmed by reading both crates' generated bindings; the
/// `unsafe extern "C-unwind"` FFI call is fully contained inside each
/// crate's own `#[inline] pub extern "C-unwind" fn` wrapper).
///
/// `CGPreflightScreenCaptureAccess`/`CGRequestScreenCaptureAccess`
/// themselves are **not** part of ScreenCaptureKit — they're the Screen
/// Recording TCC helpers in CoreGraphics, available since macOS 10.15,
/// years before this crate's 11.0 floor — so calling them unconditionally
/// on every macOS version this app supports is always safe; only actually
/// *capturing* (the `capture` module below) needs the macOS-13 gate.
#[cfg(target_os = "macos")]
mod availability_shim {
    use objc2_foundation::NSProcessInfo;

    pub fn macos_major_version() -> i64 {
        // `NSInteger` (`majorVersion`'s field type) binds to `isize` —
        // always small and non-negative in practice for a real macOS
        // version, so this cast never loses information.
        NSProcessInfo::processInfo().operatingSystemVersion().majorVersion as i64
    }

    pub fn screen_recording_granted() -> bool {
        objc2_core_graphics::CGPreflightScreenCaptureAccess()
    }

    /// Triggers the system's Screen Recording consent prompt if (and only
    /// if) this app has never been asked before; if the user already
    /// granted or denied it, this just returns that existing state without
    /// prompting again — standard, documented `CGRequestScreenCaptureAccess`
    /// behavior, not a Minute-specific choice.
    pub fn request_screen_recording() -> bool {
        objc2_core_graphics::CGRequestScreenCaptureAccess()
    }
}

#[cfg(not(target_os = "macos"))]
mod availability_shim {
    pub fn macos_major_version() -> i64 {
        0
    }
    pub fn screen_recording_granted() -> bool {
        false
    }
    pub fn request_screen_recording() -> bool {
        false
    }
}

fn current_status() -> SysAudioStatus {
    SysAudioStatus {
        availability: resolve_availability(
            availability_shim::macos_major_version(),
            availability_shim::screen_recording_granted(),
        ),
    }
}

/// Reports whether system-audio capture is available right now — see
/// [`SysAudioAvailability`]'s docs for what each state means (and doesn't
/// mean). Never prompts; a read-only status check the frontend can poll
/// (e.g. before showing the "capture system audio" toggle at all).
#[tauri::command]
pub fn sys_audio_status() -> SysAudioStatus {
    current_status()
}

/// Triggers the Screen Recording consent prompt (if it hasn't already been
/// decided — see `availability_shim::request_screen_recording`'s docs) and
/// returns the resulting status.
///
/// **Known, honest caveat — a fresh grant may need an app restart to
/// actually work.** `CGPreflightScreenCaptureAccess` (what this status is
/// built from) re-checks TCC live and can flip to granted immediately, with
/// no restart, in this process. But ScreenCaptureKit's own authorization
/// state for an *already-running* process is a separate, well-documented
/// quirk (widely reported across ScreenCaptureKit-based recording apps):
/// apps that queried shareable content before permission was granted have
/// historically needed a relaunch before `SCStream` will actually start
/// capturing, even once `CGPreflightScreenCaptureAccess` itself already
/// reports `true`. This command cannot paper over that; it reports the
/// honest TCC-level state, and a caller that gets `Ready` back but then has
/// `SysCapture::start` fail anyway should suggest a restart, not treat it
/// as a bug.
#[tauri::command]
pub fn request_sys_audio_permission() -> SysAudioStatus {
    let _granted_immediately = availability_shim::request_screen_recording();
    current_status()
}

// ---------------------------------------------------------------------------
// Sample pipeline: SCK audio bytes -> mono @ 16kHz blocks (pure, testable)
// ---------------------------------------------------------------------------

/// Decodes raw little-endian `Float32` bytes — the format ScreenCaptureKit's
/// `AudioBuffer::data()` delivers (Core Audio's canonical PCM float format;
/// see this module's own docs for how that was confirmed). A trailing
/// group of fewer than 4 bytes (shouldn't happen from a real audio buffer,
/// but cheap to handle without panicking) is dropped rather than padded or
/// misread, mirroring `chunks_exact`'s own documented behavior.
///
pub(crate) fn bytes_to_f32_le(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// One ScreenCaptureKit `AudioBuffer`'s decoded content — `number_channels`
/// plus its already-decoded `f32` samples — deliberately decoupled from
/// that crate's own `AudioBuffer` type so [`downmix_sck_buffers_to_mono`]
/// stays unit-testable with synthetic data, no real capture required.
/// Constructed inside `mod capture`'s `did_output_sample_buffer`, reachable
/// in the ordinary (non-test) build once `Recorder::start` actually starts
/// system-audio capture (Stage 5 Task 5).
pub(crate) struct DecodedAudioBuffer {
    pub number_channels: u16,
    pub samples: Vec<f32>,
}

/// Downmixes a `CMSampleBuffer`'s decoded audio buffers to a single mono
/// channel, handling both shapes Core Audio might hand back for a
/// requested-stereo stream (see this module's docs for why neither is
/// assumed outright):
///
/// - **One buffer** (`number_channels == N`): interleaved — delegates
///   straight to [`downmix_to_mono`], the exact same interleaved-downmix
///   logic `Recorder`'s mic path uses.
/// - **Multiple buffers** (each typically `number_channels == 1`): planar —
///   averaged sample-index-wise across buffers instead. If the buffers
///   happen to carry different lengths (shouldn't happen for buffers drawn
///   from the same sample, but this stays defensive rather than panicking
///   on a mismatch), the shorter length wins — the shared prefix is still
///   correctly averaged, and nothing after it is fabricated.
///
/// Empty input yields empty output.
pub(crate) fn downmix_sck_buffers_to_mono(buffers: &[DecodedAudioBuffer]) -> Vec<f32> {
    match buffers.len() {
        0 => Vec::new(),
        1 => downmix_to_mono(&buffers[0].samples, buffers[0].number_channels),
        n => {
            let len = buffers.iter().map(|b| b.samples.len()).min().unwrap_or(0);
            if len == 0 {
                return Vec::new();
            }
            let n = n as f32;
            (0..len)
                .map(|i| buffers.iter().map(|b| b.samples[i]).sum::<f32>() / n)
                .collect()
        }
    }
}

/// Batches a stream of resampled mono samples into fixed-size blocks —
/// same rationale as `audio.rs`'s `STT_BLOCK_SAMPLES`/`run_writer_thread`
/// batching (a bounded channel's real buffering headroom is block-size ×
/// slot-count, not slot-count alone). Kept as its own small, directly
/// testable type here rather than importing `audio.rs`'s private batching
/// logic (which is inlined into `run_writer_thread`, not a reusable unit) —
/// only `downmix_to_mono`/`LinearResampler`, the plan's named reuse
/// targets, are pulled from there.
pub(crate) struct BlockBatcher {
    block_samples: usize,
    buf: Vec<f32>,
}

impl BlockBatcher {
    /// `block_samples` is clamped to at least 1 — a `0` would otherwise spin
    /// `push` forever draining zero-length blocks.
    pub fn new(block_samples: usize) -> Self {
        Self {
            block_samples: block_samples.max(1),
            buf: Vec::new(),
        }
    }

    /// Feeds newly produced mono samples, returning zero or more full,
    /// `block_samples`-sized blocks in arrival order. Any leftover short of
    /// a full block is retained for the next `push`/`flush` call.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buf.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.buf.len() >= self.block_samples {
            out.push(self.buf.drain(..self.block_samples).collect());
        }
        out
    }

    /// Returns and clears whatever partial block is left, if any — the
    /// tail-flush counterpart to `audio.rs::run_writer_thread`'s trailing-
    /// partial-block handling. Called from `SysCapture::stop`, once the
    /// stream has actually finished stopping (see that method's own docs
    /// for why only then), so a recording's last, not-yet-`SYS_BLOCK_SAMPLES`
    /// stretch of system audio isn't silently lost off the end.
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }
}

#[cfg(test)]
mod pipeline_tests {
    use super::*;

    // --- bytes_to_f32_le ---------------------------------------------------

    #[test]
    fn bytes_to_f32_le_round_trips_known_values() {
        let values: [f32; 3] = [1.0, -0.5, 0.25];
        let mut bytes = Vec::new();
        for v in values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(bytes_to_f32_le(&bytes), values.to_vec());
    }

    #[test]
    fn bytes_to_f32_le_drops_a_trailing_partial_group() {
        let mut bytes = 1.0f32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&[0xAA, 0xBB]); // 2 trailing bytes, not a full f32
        assert_eq!(bytes_to_f32_le(&bytes), vec![1.0]);
    }

    #[test]
    fn bytes_to_f32_le_empty_is_empty() {
        assert_eq!(bytes_to_f32_le(&[]), Vec::<f32>::new());
    }

    // --- downmix_sck_buffers_to_mono ---------------------------------------

    #[test]
    fn single_interleaved_stereo_buffer_downmixes_like_the_mic_path() {
        // Same known L/R pairs as audio.rs's own
        // `downmix_stereo_averages_known_values` test: (1,3)->2, (2,4)->3.
        let buffers = [DecodedAudioBuffer {
            number_channels: 2,
            samples: vec![1.0, 3.0, 2.0, 4.0],
        }];
        assert_eq!(downmix_sck_buffers_to_mono(&buffers), vec![2.0, 3.0]);
    }

    #[test]
    fn single_mono_buffer_is_passthrough() {
        let buffers = [DecodedAudioBuffer {
            number_channels: 1,
            samples: vec![0.1, -0.2, 0.3],
        }];
        assert_eq!(downmix_sck_buffers_to_mono(&buffers), vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn two_planar_mono_buffers_average_index_wise() {
        let buffers = [
            DecodedAudioBuffer {
                number_channels: 1,
                samples: vec![1.0, 2.0],
            },
            DecodedAudioBuffer {
                number_channels: 1,
                samples: vec![3.0, 4.0],
            },
        ];
        assert_eq!(downmix_sck_buffers_to_mono(&buffers), vec![2.0, 3.0]);
    }

    #[test]
    fn planar_buffers_with_mismatched_lengths_use_the_shorter_shared_prefix() {
        let buffers = [
            DecodedAudioBuffer {
                number_channels: 1,
                samples: vec![1.0, 2.0, 999.0],
            },
            DecodedAudioBuffer {
                number_channels: 1,
                samples: vec![3.0, 4.0],
            },
        ];
        assert_eq!(downmix_sck_buffers_to_mono(&buffers), vec![2.0, 3.0]);
    }

    #[test]
    fn no_buffers_is_empty() {
        assert_eq!(downmix_sck_buffers_to_mono(&[]), Vec::<f32>::new());
    }

    // --- BlockBatcher --------------------------------------------------------

    #[test]
    fn push_exact_multiple_yields_full_blocks_with_no_remainder() {
        let mut batcher = BlockBatcher::new(4);
        let blocks = batcher.push(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        assert_eq!(blocks, vec![vec![1.0, 2.0, 3.0, 4.0], vec![5.0, 6.0, 7.0, 8.0]]);
        assert_eq!(batcher.flush(), None);
    }

    #[test]
    fn push_short_of_a_block_yields_nothing_until_flushed() {
        let mut batcher = BlockBatcher::new(4);
        let blocks = batcher.push(&[1.0, 2.0]);
        assert!(blocks.is_empty());
        assert_eq!(batcher.flush(), Some(vec![1.0, 2.0]));
        // Flushing clears it — a second flush has nothing left.
        assert_eq!(batcher.flush(), None);
    }

    #[test]
    fn pushes_across_a_block_boundary_split_over_two_calls() {
        let mut batcher = BlockBatcher::new(4);
        assert!(batcher.push(&[1.0, 2.0]).is_empty());
        let blocks = batcher.push(&[3.0, 4.0, 5.0]);
        assert_eq!(blocks, vec![vec![1.0, 2.0, 3.0, 4.0]]);
        assert_eq!(batcher.flush(), Some(vec![5.0]));
    }

    #[test]
    fn zero_block_samples_is_clamped_to_one_rather_than_spinning_forever() {
        let mut batcher = BlockBatcher::new(0);
        let blocks = batcher.push(&[1.0, 2.0]);
        assert_eq!(blocks, vec![vec![1.0], vec![2.0]]);
    }
}

// ---------------------------------------------------------------------------
// SysCapture — thin macOS glue (SCStream) + non-macOS stub
// ---------------------------------------------------------------------------

/// Sample-count size of each mono block handed to `tx` — mirrors
/// `audio.rs`'s `STT_BLOCK_SAMPLES` (~0.5s at [`TARGET_SAMPLE_RATE`]) for
/// the identical reason: a bounded channel's real buffering headroom is a
/// function of how much audio each slot is worth, not slot count alone.
const SYS_BLOCK_SAMPLES: usize = 8_000;

/// Bounded channel capacity — same ~128s headroom as `audio.rs`'s
/// `STT_CHANNEL_CAPACITY`. Generous on purpose relative to
/// `run_writer_thread_with_system`'s own real drain rate (it pulls via
/// non-blocking `try_recv` once per mic chunk, not on a fixed schedule) —
/// see that function's docs for the separate, tighter bound
/// (`SYS_BUF_MAX_LEAD_SAMPLES`) on how much of what's drained is actually
/// allowed to survive into the mix after a stall.
const SYS_CHANNEL_CAPACITY: usize = 256;

/// How often a *sustained* run of failures gets logged again, rather than
/// either spamming on every single occurrence or going silent after the
/// first — mirrors `audio.rs`'s `STT_DROP_LOG_INTERVAL` cadence exactly
/// (same rationale: see that constant's docs). Shared by both of this
/// module's own drop-cadence sites: [`try_send_sys_block`]'s channel-full
/// counter and `mod capture::extract_audio_buffers`'s extraction-failure
/// counter.
const SYS_DROP_LOG_INTERVAL: u64 = 50;

/// Requested (not necessarily exactly what's delivered — see the module
/// docs) audio format. 48kHz stereo: `SCStreamConfiguration`'s own
/// documented Apple default. Used inside `mod capture::SysCapture::start`.
const SYS_AUDIO_SAMPLE_RATE_HZ: i32 = 48_000;
const SYS_AUDIO_CHANNELS: i32 = 2;

/// The sender/receiver pair [`channel`] returns — named so clippy's
/// `type_complexity` lint (and every reader) gets a label instead of a bare
/// nested-generic tuple at every call site.
pub type SysAudioChannel = (SyncSender<Arc<Vec<f32>>>, std::sync::mpsc::Receiver<Arc<Vec<f32>>>);

/// Creates the bounded `Arc<Vec<f32>>` channel [`SysCapture::start`] sends
/// blocks over — the same shape `Recorder::start`'s `sample_tx` uses (see
/// `audio.rs`), so `run_writer_thread_with_system` (Stage 5 Task 5) can
/// consume both sources identically. Exposed as its own function (rather
/// than leaving every caller to spell out the type + capacity) since the
/// channel's *shape* is this task's actual contract, per the plan.
pub fn channel() -> SysAudioChannel {
    std::sync::mpsc::sync_channel(SYS_CHANNEL_CAPACITY)
}

/// Tries to forward one accumulated block onto `tx`. Bounded + `try_send`,
/// drop-on-full — identical discipline to `audio.rs`'s
/// `try_send_stt_block` (see that function's docs for the full rationale):
/// a slow/stalled/nonexistent consumer must never make the realtime SCK
/// callback thread block.
fn try_send_sys_block(tx: &SyncSender<Arc<Vec<f32>>>, block: Vec<f32>, dropped: &mut u64) {
    match tx.try_send(Arc::new(block)) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            *dropped += 1;
            if *dropped % SYS_DROP_LOG_INTERVAL == 0 {
                log::warn!("sys-audio channel full — dropped {dropped} ~0.5s blocks so far");
            }
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

#[cfg(target_os = "macos")]
mod capture {
    //! Real `SCStream`-backed capture engine, built directly on objc2's
    //! header-generated `ScreenCaptureKit`/`CoreMedia`/`CoreAudioTypes`
    //! bindings (`objc2-screen-capture-kit` et al. — plain Objective-C
    //! framework bindings, the same shape as the already-present
    //! `objc2-app-kit`/`objc2-core-audio`, no Swift toolchain involved at
    //! all). Deliberately thin: every byte of actual decode/downmix/
    //! resample/batch logic lives in this file's pure pipeline section
    //! above — this module's own job is limited to configuring the stream,
    //! implementing the `SCStreamOutput` protocol, and lifecycle
    //! (start/stop).
    //!
    //! ## Why not the `screencapturekit` crate
    //!
    //! An earlier version of this module used the `screencapturekit` crate
    //! (a Swift-Package-Manager-based wrapper). Reverted: its build script
    //! requires a full Xcode.app install to compile at all (confirmed on
    //! this machine — Command Line Tools alone fail at the Swift manifest
    //! compile step), which broke `cargo build`/`cargo test` for the whole
    //! crate on any machine (or CI runner) without one. Everything in this
    //! module compiles with Command Line Tools alone.
    //!
    //! ## Async APIs, made synchronous
    //!
    //! `getShareableContentWithCompletionHandler`/`startCaptureWithCompletionHandler`/
    //! `stopCaptureWithCompletionHandler` are all completion-handler-based
    //! (their callback can run on a different thread than the caller).
    //! [`first_display`]/[`SysCapture::start`]/[`SysCapture::stop`] each wrap
    //! the relevant call in an `mpsc` channel (capacity 1 — bounded) and a
    //! [`SCK_COMPLETION_TIMEOUT`]-bounded `recv_timeout` (not an unbounded
    //! `recv` — a wedged/never-firing completion handler must not hang these
    //! calls forever) to give this module's callers the same synchronous
    //! `Result`-return shape the rest of this crate (and `audio.rs`'s
    //! `Recorder`) uses.

    use std::mem::size_of;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::SyncSender;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
    use objc2_core_foundation::CFRetained;
    use objc2_core_media::{
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, CMBlockBuffer, CMSampleBuffer,
        CMTime,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
        SCStreamOutput, SCStreamOutputType, SCWindow,
    };

    use super::{
        bytes_to_f32_le, downmix_sck_buffers_to_mono, lock, resolve_availability, try_send_sys_block,
        availability_shim, BlockBatcher, DecodedAudioBuffer, SysAudioAvailability, SYS_AUDIO_CHANNELS,
        SYS_AUDIO_SAMPLE_RATE_HZ, SYS_BLOCK_SAMPLES, SYS_DROP_LOG_INTERVAL,
    };
    use crate::audio::{LinearResampler, TARGET_SAMPLE_RATE};
    use crate::error::{MinuteError, Result};

    /// How long [`first_display`]/[`block_on_error_completion`] wait for
    /// ScreenCaptureKit's completion handler before giving up — a wedged or
    /// never-firing callback (a real, if rare, failure mode for an XPC-
    /// backed system framework) must not hang these calls forever.
    const SCK_COMPLETION_TIMEOUT: Duration = Duration::from_secs(5);

    /// Logs an extraction failure, but only every [`SYS_DROP_LOG_INTERVAL`]
    /// occurrences (starting with the very first) — a misbehaving stream
    /// producing bad buffers at the callback's own realtime rate must not
    /// spam the log on every single one. Mirrors [`try_send_sys_block`]'s
    /// identical cadence discipline for the channel-full case.
    fn log_extraction_failure(extraction_failures: &mut u64, reason: &str) {
        *extraction_failures += 1;
        if *extraction_failures % SYS_DROP_LOG_INTERVAL == 1 {
            log::warn!(
                "system-audio buffer extraction failed ({extraction_failures} time(s) so far): \
                 {reason}"
            );
        }
    }

    /// Reads the audio buffers out of `sample`'s underlying
    /// `AudioBufferList` (`CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`,
    /// exposed here as `audio_buffer_list_with_retained_block_buffer`) into
    /// this crate's pipeline-neutral [`DecodedAudioBuffer`] shape.
    ///
    /// ## The two-call protocol this function relies on
    ///
    /// An earlier version of this function tried a single call with an
    /// oversized (8-channels-worth) stack buffer and no retained block
    /// buffer, reasoning that "big enough" should be sufficient. Confirmed
    /// wrong empirically, against real `SCStream` audio callbacks (not
    /// simulated): that shape reproducibly fails with `-12737`
    /// `kCMSampleBufferError_ArrayTooSmall` on every single callback, even
    /// though the buffer is *larger* than what's actually needed. Probing
    /// further pinned down the real, undocumented contract:
    /// - An **exact**-size `buffer_list_out` is required — not merely
    ///   "big enough". The needed size (the `AudioBufferList` header plus
    ///   `N` `AudioBuffer` *descriptors* — typically a few dozen bytes,
    ///   **not** the actual audio sample data, which lives elsewhere and is
    ///   only pointed to) is learned via a first probe call with a null
    ///   `buffer_list_out`.
    /// - A non-null `block_buffer_out` is **required**, not optional
    ///   despite the type signature allowing null: omitting it (even with
    ///   an otherwise correctly, exactly-sized list buffer) reproducibly
    ///   fails with `-12731` `kCMSampleBufferError_RequiredParameterMissing`.
    ///   The returned `CMBlockBuffer` is `+1`/"Create rule" retained (hence
    ///   [`CFRetained::from_raw`]) and is what actually backs the
    ///   `AudioBuffer` entries' `mData` pointers — it's kept alive for the
    ///   rest of this function (released automatically when it drops) so
    ///   those pointers stay valid while their bytes are copied out.
    /// - `kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment` is
    ///   passed as the `flags` argument, matching Apple's own sample code
    ///   for this call (e.g. the `AudioCap` reference project).
    ///
    /// `AudioBufferList` is *also* the classic Core Audio variable-length-
    /// array C struct: its Rust binding declares `mBuffers: [AudioBuffer;
    /// 1]` (storage for exactly one entry), but the real struct can carry
    /// more — the actual buffer count lives in `mNumberBuffers`, with
    /// entries packed contiguously starting at `mBuffers`' own offset,
    /// re-derived here via `mem::offset_of!` pointer arithmetic — the
    /// standard, documented way to handle this C idiom from Rust.
    ///
    /// Returns `None` on any unexpected result — a malformed buffer must
    /// never panic the SCK callback thread. Failures are logged, but rate-
    /// limited — see [`log_extraction_failure`].
    fn extract_audio_buffers(
        sample: &CMSampleBuffer,
        extraction_failures: &mut u64,
    ) -> Option<Vec<DecodedAudioBuffer>> {
        // Step 1: probe for the exact byte size `AudioBufferList` (header +
        // N `AudioBuffer` descriptors) needs — a null `buffer_list_out`
        // means nothing is written, so `buffer_list_size` (0) and
        // `block_buffer_out` (null) are irrelevant for this call; its own
        // returned `OSStatus` is intentionally ignored (probing a size this
        // way is documented, in Apple's own sample code, to report
        // `kCMSampleBufferError_ArrayTooSmall`-shaped statuses even on
        // success) — `size_needed` being populated is the actual signal.
        let mut size_needed: usize = 0;
        // SAFETY: every out-param here is either null (nothing should be
        // written) or a valid `&mut` (`size_needed`).
        let _ = unsafe {
            sample.audio_buffer_list_with_retained_block_buffer(
                &mut size_needed,
                std::ptr::null_mut(),
                0,
                None,
                None,
                0,
                std::ptr::null_mut(),
            )
        };
        let mbuffers_offset = std::mem::offset_of!(AudioBufferList, mBuffers);
        if size_needed < mbuffers_offset + size_of::<AudioBuffer>() {
            log_extraction_failure(
                extraction_failures,
                &format!("size probe reported an implausibly small {size_needed} bytes"),
            );
            return None;
        }

        // Step 2: the real call — an exactly-`size_needed`-sized buffer,
        // the alignment flag, and a non-null `block_buffer_out` (see this
        // function's own doc comment for why all three are load-bearing).
        let mut raw = vec![0u8; size_needed];
        let list_ptr = raw.as_mut_ptr().cast::<AudioBufferList>();
        let mut block_buffer_ptr: *mut CMBlockBuffer = std::ptr::null_mut();
        let mut size_needed_confirm: usize = 0;
        // SAFETY: `list_ptr` points into `raw`, exactly `size_needed` bytes
        // (the `buffer_list_size` passed below), which stays alive for the
        // rest of this function. `block_buffer_ptr` receives a `+1`-
        // retained `CMBlockBuffer` on success, adopted into a `CFRetained`
        // immediately below.
        let status = unsafe {
            sample.audio_buffer_list_with_retained_block_buffer(
                &mut size_needed_confirm,
                list_ptr,
                size_needed,
                None,
                None,
                kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                &mut block_buffer_ptr,
            )
        };
        if status != 0 {
            log_extraction_failure(
                extraction_failures,
                &format!(
                    "CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer failed: status \
                     {status}"
                ),
            );
            return None;
        }

        // SAFETY: `status == noErr` (checked above) is this function's own
        // documented guarantee of a `+1`-retained `CMBlockBuffer` written to
        // `block_buffer_ptr` — adopting it here (rather than leaking it)
        // means it's released automatically when `_block_buffer` drops at
        // the end of this function, after every buffer's bytes have been
        // copied out.
        let _block_buffer = NonNull::new(block_buffer_ptr).map(|ptr| unsafe { CFRetained::from_raw(ptr) });

        // SAFETY: `status == noErr` guarantees `list_ptr` was filled in,
        // including its leading `mNumberBuffers` field.
        let num_buffers = unsafe { (*list_ptr).mNumberBuffers } as usize;
        if num_buffers == 0 {
            log_extraction_failure(extraction_failures, "buffer list reported 0 buffers");
            return None;
        }

        // SAFETY: see this function's own doc comment — `num_buffers`
        // contiguous `AudioBuffer` entries live at `mBuffers`' offset,
        // guaranteed by the successful, exactly-sized call above.
        let buffers_ptr = unsafe { raw.as_ptr().add(mbuffers_offset).cast::<AudioBuffer>() };
        let buffers = unsafe { std::slice::from_raw_parts(buffers_ptr, num_buffers) };

        Some(
            buffers
                .iter()
                .map(|buffer| {
                    let samples = if buffer.mDataByteSize == 0 || buffer.mData.is_null() {
                        Vec::new()
                    } else {
                        // SAFETY: `_block_buffer` (kept alive above) backs
                        // this memory for the rest of this function; Core
                        // Media guarantees `mData` points to
                        // `mDataByteSize` valid bytes for a successfully
                        // filled-in `AudioBuffer`.
                        let bytes = unsafe {
                            std::slice::from_raw_parts(
                                buffer.mData.cast::<u8>(),
                                buffer.mDataByteSize as usize,
                            )
                        };
                        bytes_to_f32_le(bytes)
                    };
                    DecodedAudioBuffer {
                        number_channels: buffer.mNumberChannels as u16,
                        samples,
                    }
                })
                .collect(),
        )
    }

    /// Per-callback mutable state for [`SysAudioHandler`] — see that type's
    /// docs for why this is one `Mutex<CallbackState>` rather than a lock
    /// per field.
    struct CallbackState {
        resampler: LinearResampler,
        batcher: BlockBatcher,
        dropped: u64,
        /// Running count of [`extract_audio_buffers`] failures — logged
        /// every [`SYS_DROP_LOG_INTERVAL`] occurrences (see that
        /// function's own docs), the same cadence discipline as `dropped`
        /// above.
        extraction_failures: u64,
        /// Whether [`SysAudioHandler`]'s callback has already logged the
        /// delivered buffer shape once (sample rate/channel layout) — see
        /// that callback's own docs. A field (not a `once_cell`/`Once`)
        /// since this state is already per-instance and already behind a
        /// lock; a global `Once` would wrongly persist across separate
        /// `SysCapture` sessions within the same process.
        format_logged: bool,
    }

    struct HandlerIvars {
        tx: SyncSender<Arc<Vec<f32>>>,
        state: Mutex<CallbackState>,
        /// Stage 5 Task 5: shared with `audio::Recorder`'s own mic-callback
        /// pause flag (`SharedState::paused`) so pausing a recording pauses
        /// system-audio capture too — see `audio::Recorder::start`'s "Pause
        /// pauses both sources" design note. Checked first thing in the
        /// callback below, mirroring `audio::build_stream`'s own cpal
        /// callback exactly: skip entirely (no decode/mix work, no
        /// forwarded block) while paused.
        paused: Arc<AtomicBool>,
    }

    define_class!(
        // SAFETY: `NSObject` has no subclassing requirements, and
        // `SysAudioHandler` does not implement `Drop`.
        #[unsafe(super(NSObject))]
        #[ivars = HandlerIvars]
        struct SysAudioHandler;

        unsafe impl NSObjectProtocol for SysAudioHandler {}

        unsafe impl SCStreamOutput for SysAudioHandler {
            /// Realtime audio callback: decode → downmix → resample →
            /// batch → forward, entirely via this file's pure, unit-tested
            /// pipeline functions (see the module docs) — this method
            /// itself does no signal processing, only FFI-boundary
            /// decoding and gluing the pipeline stages together.
            ///
            /// Logs the delivered buffer shape exactly once per session
            /// (buffer count + channels-per-buffer, alongside this
            /// module's own requested sample rate/channel count) — Apple's
            /// own `ScreenCaptureKit`/`CoreMedia` docs never pin down
            /// whether a requested-stereo stream arrives as one
            /// interleaved buffer or two planar ones (see this file's
            /// module docs' "What ScreenCaptureKit actually delivers"
            /// section); [`super::downmix_sck_buffers_to_mono`] already
            /// handles both, but logging the actually-observed shape once
            /// documents it honestly for whoever reads the logs later,
            /// rather than leaving it as an unverified assumption forever.
            //
            // `#[allow(non_snake_case)]`: this method's name must match
            // `SCStreamOutput`'s own trait method name exactly (derived by
            // `objc2`'s header-translator from the Objective-C selector
            // `stream:didOutputSampleBuffer:ofType:`, the same
            // underscore-joined-camelCase convention every generated
            // binding in this dependency tree already uses, e.g.
            // `initWithDisplay_excludingWindows` above) — it isn't a name
            // this code gets to choose.
            #[allow(non_snake_case)]
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            fn stream_didOutputSampleBuffer_ofType(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                of_type: SCStreamOutputType,
            ) {
                if of_type != SCStreamOutputType::Audio {
                    return;
                }
                if self.ivars().paused.load(Ordering::Relaxed) {
                    return;
                }

                let mut state = lock(&self.ivars().state);
                let Some(decoded) = extract_audio_buffers(sample_buffer, &mut state.extraction_failures)
                else {
                    return;
                };
                let mono = downmix_sck_buffers_to_mono(&decoded);
                if mono.is_empty() {
                    return;
                }

                if !state.format_logged {
                    state.format_logged = true;
                    let channels_per_buffer: Vec<u16> =
                        decoded.iter().map(|b| b.number_channels).collect();
                    log::info!(
                        "system-audio format observed: {} buffer(s), channels-per-buffer \
                         {channels_per_buffer:?} (requested {SYS_AUDIO_SAMPLE_RATE_HZ}Hz / \
                         {SYS_AUDIO_CHANNELS} channel(s))",
                        decoded.len(),
                    );
                }

                let resampled = state.resampler.resample(&mono);
                if resampled.is_empty() {
                    return;
                }
                let blocks = state.batcher.push(&resampled);
                for block in blocks {
                    try_send_sys_block(&self.ivars().tx, block, &mut state.dropped);
                }
            }
        }
    );

    impl SysAudioHandler {
        fn new(tx: SyncSender<Arc<Vec<f32>>>, paused: Arc<AtomicBool>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(HandlerIvars {
                tx,
                state: Mutex::new(CallbackState {
                    resampler: LinearResampler::new(SYS_AUDIO_SAMPLE_RATE_HZ as u32, TARGET_SAMPLE_RATE),
                    batcher: BlockBatcher::new(SYS_BLOCK_SAMPLES),
                    dropped: 0,
                    extraction_failures: 0,
                    format_logged: false,
                }),
                paused,
            });
            // SAFETY: `NSObject::init` has no preconditions beyond a freshly
            // `alloc`'d instance, which `set_ivars` returns.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// A retained `SCDisplay`, asserted `Send` for exactly one narrow,
    /// documented purpose: carrying the single display result of
    /// `getShareableContentWithCompletionHandler`'s completion block (which
    /// ScreenCaptureKit invokes on its own internal queue, not necessarily
    /// the thread that registered it) back to the thread blocked waiting
    /// on it in [`first_display`]. `SCDisplay` is an immutable content-
    /// metadata snapshot (id/dimensions), not a live stream or UI object
    /// with thread affinity — the entire point of this completion-handler
    /// API shape is that the result is handed across a queue boundary by
    /// design. Not generic — this exists for exactly this one call site,
    /// not as a general-purpose "make anything Send" escape hatch — never
    /// used for anything beyond this one hand-off, and never returned from
    /// any public API of this module.
    struct SendableRetained(Retained<SCDisplay>);
    // SAFETY: see the doc comment above.
    unsafe impl Send for SendableRetained {}

    /// Blocks the calling thread (up to [`SCK_COMPLETION_TIMEOUT`]) until
    /// `getShareableContentWithCompletionHandler`'s completion block fires
    /// (see the module docs' "Async APIs, made synchronous" section),
    /// returning the first available display.
    fn first_display() -> Result<Retained<SCDisplay>> {
        let (tx, rx) =
            std::sync::mpsc::sync_channel::<std::result::Result<SendableRetained, String>>(1);
        let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: both are the raw pointer pair
            // `getShareableContentWithCompletionHandler` hands to its
            // completion block; each is either null or valid for the
            // duration of this call, per Apple's documented contract.
            let result = if let Some(error) = unsafe { error.as_ref() } {
                Err(error.localizedDescription().to_string())
            } else if let Some(content) = unsafe { content.as_ref() } {
                // SAFETY: `content` is a valid `SCShareableContent` (just
                // checked above); `displays()` has no further preconditions.
                match unsafe { content.displays() }.firstObject() {
                    Some(display) => Ok(SendableRetained(display)),
                    None => Err("no displays available to build a content filter".to_string()),
                }
            } else {
                Err("getShareableContentWithCompletionHandler returned neither content nor an \
                     error"
                    .to_string())
            };
            let _ = tx.send(result);
        });
        // SAFETY: `block` is a valid block; ScreenCaptureKit copies its own
        // reference internally per the standard Cocoa completion-handler
        // contract, so it's sound for `block` to be dropped once this
        // function returns (which only happens after `rx.recv_timeout`
        // below has already observed the completion firing, or timed out).
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&block) };

        let result = rx.recv_timeout(SCK_COMPLETION_TIMEOUT).map_err(|_| {
            MinuteError::Other(
                "ScreenCaptureKit did not respond — try toggling system audio off and on"
                    .to_string(),
            )
        })?;
        result.map(|wrapped| wrapped.0).map_err(|e| {
            MinuteError::Other(format!(
                "failed to query shareable content (Screen Recording permission may need an app \
                 restart to take effect — see request_sys_audio_permission's docs): {e}"
            ))
        })
    }

    /// Blocks (up to [`SCK_COMPLETION_TIMEOUT`]) on a `(completionHandler:
    /// ^(NSError *))`-shaped async call — the same synchronous-wrapper
    /// shape [`first_display`] uses, factored out since
    /// `startCaptureWithCompletionHandler`/`stopCaptureWithCompletionHandler`
    /// both have this exact signature. `register` is handed the block to
    /// pass into the real SCK call; its return value is ignored (the block
    /// itself, not `register`'s return, is how the result comes back).
    fn block_on_error_completion(
        register: impl FnOnce(&RcBlock<dyn Fn(*mut NSError)>),
    ) -> std::result::Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Option<String>>(1);
        let block = RcBlock::new(move |error: *mut NSError| {
            // SAFETY: `error` is the pointer SCK's completion handler hands
            // back, valid (or null) for the duration of this call.
            let msg = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            let _ = tx.send(msg);
        });
        register(&block);
        match rx.recv_timeout(SCK_COMPLETION_TIMEOUT) {
            Ok(None) => Ok(()),
            Ok(Some(msg)) => Err(msg),
            Err(_) => {
                Err("ScreenCaptureKit did not respond — try toggling system audio off and on"
                    .to_string())
            }
        }
    }

    /// A live system-audio capture session: owns the real `SCStream` (plus
    /// the dispatch queue and output handler it needs kept alive) for as
    /// long as this handle lives. `start`/`stop`'s real caller is
    /// `audio::Recorder::start`/`RecorderHandle::stop` (Stage 5 Task 5),
    /// alongside this module's own `#[ignore]`d e2e test.
    pub struct SysCapture {
        stream: Retained<SCStream>,
        // Never read after construction — kept purely so the dispatch queue
        // `stream`'s callback runs on stays alive for as long as `stream`
        // itself does (dropping it early would be a use-after-free risk for
        // the callback, not merely dead weight). A genuine, permanent RAII-
        // only field, not leftover scaffolding.
        #[allow(dead_code)]
        queue: dispatch2::DispatchRetained<DispatchQueue>,
        handler: Retained<SysAudioHandler>,
    }

    // SAFETY: once configured, `SCStream` is designed to be started/
    // stopped/queried from any thread — its entire public API surface past
    // construction is completion-handler-based async calls, exactly the
    // pattern Cocoa uses when a type has no main-thread affinity (contrast
    // with e.g. `NSView`, which objc2 bindings mark `MainThreadOnly`
    // instead). `queue`/`handler` are already `Send` on their own (dispatch
    // objects are unconditionally `Send`+`Sync`; `SysAudioHandler` derives
    // both automatically per `define_class!`'s thread-safety rules, since
    // its ivars are `Send`+`Sync` and its superclass is plain `NSObject`)
    // — `stream` is the only field this impl actually needs to vouch for.
    unsafe impl Send for SysCapture {}

    impl SysCapture {
        /// Starts capturing system audio, downmixing/resampling to 16kHz
        /// mono and forwarding ~0.5s blocks over `tx` — see the module docs
        /// for the full pipeline. Fails fast (never panics, never crashes)
        /// when availability isn't [`SysAudioAvailability::Ready`], rather
        /// than letting an avoidable case surface as a confusing
        /// `SCShareableContent`/`SCStream` error — see this crate's
        /// module docs' "NEVER crash on denial" requirement.
        ///
        /// `paused`: shared with the owning recording's mic-callback pause
        /// flag (Stage 5 Task 5 — see `HandlerIvars::paused`'s docs) so a
        /// paused recording pauses system-audio capture too, not just the
        /// mic. A caller with no mic side to share a flag with (this
        /// module's own e2e test) can simply pass a fresh, never-toggled
        /// `Arc::new(AtomicBool::new(false))`.
        pub fn start(tx: SyncSender<Arc<Vec<f32>>>, paused: Arc<AtomicBool>) -> Result<Self> {
            let availability = resolve_availability(
                availability_shim::macos_major_version(),
                availability_shim::screen_recording_granted(),
            );
            match availability {
                SysAudioAvailability::Unsupported => {
                    return Err(MinuteError::Other(
                        "system audio capture requires macOS 13 or later".to_string(),
                    ))
                }
                SysAudioAvailability::NotGranted => {
                    return Err(MinuteError::Other(
                        "system audio capture needs Screen Recording permission".to_string(),
                    ))
                }
                SysAudioAvailability::Ready => {}
            }

            let display = first_display()?;

            let excluded: Retained<NSArray<SCWindow>> = NSArray::from_slice(&[]);
            // SAFETY: `SCContentFilter::alloc()` is a fresh, uninitialized
            // instance; `initWithDisplay:excludingWindows:` is the correct
            // (and only) designated initializer for this filter shape.
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &excluded,
                )
            };

            // SAFETY: `new` has no preconditions beyond ordinary
            // `+alloc]init]`-style construction.
            let config = unsafe { SCStreamConfiguration::new() };
            // SAFETY: plain property setters on a freshly-constructed
            // configuration object — no preconditions beyond `config`
            // being valid, which it is.
            unsafe {
                // Video is never consumed (no `Screen`-type output handler
                // registered below) — 2x2 @ 1fps is the smallest practical
                // footprint for the internal video track `SCStream` always
                // produces (there is no audio-only capture mode), rather
                // than 0x0 (untested whether every supported macOS version
                // accepts a zero-size configuration). See the module docs'
                // "Video: never consumed, deliberately minimized" section.
                config.setWidth(2);
                config.setHeight(2);
                config.setMinimumFrameInterval(CMTime::new(1, 1));
                config.setCapturesAudio(true);
                config.setSampleRate(SYS_AUDIO_SAMPLE_RATE_HZ as isize);
                config.setChannelCount(SYS_AUDIO_CHANNELS as isize);
                // Prevents feedback if Minute ever plays audio of its own —
                // see the module docs' "Feedback prevention" section for
                // why this (not `SCContentFilter` app-exclusion) is used.
                config.setExcludesCurrentProcessAudio(true);
            }

            let handler = SysAudioHandler::new(tx, paused);
            // A dedicated serial queue for the audio callback — passing
            // `None` here would deliver on the main dispatch queue, which
            // this app's UI thread also services; a dedicated queue keeps
            // the realtime audio callback off of (and never blocked
            // behind) UI work, matching `audio.rs`'s own mic-callback
            // discipline of never doing meaningful work on a shared/UI
            // thread.
            let queue = DispatchQueue::new("dev.minute.sysaudio", None);

            // SAFETY: `SCStream::alloc()` is a fresh instance;
            // `initWithFilter:configuration:delegate:` is its designated
            // initializer. `delegate: None` — this module doesn't need
            // stream-lifecycle callbacks (stopped-with-error, etc.) today;
            // `stop()`/dropping this handle are the only stop paths.
            let stream = unsafe {
                SCStream::initWithFilter_configuration_delegate(
                    SCStream::alloc(),
                    &filter,
                    &config,
                    None,
                )
            };

            // SAFETY: `queue` outlives this call (stored on `Self` below);
            // `handler` is a valid, fully-initialized `SCStreamOutput`
            // conformer.
            unsafe {
                stream.addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*handler),
                    SCStreamOutputType::Audio,
                    Some(&queue),
                )
            }
            .map_err(|e| {
                MinuteError::Other(format!(
                    "failed to add system-audio stream output: {}",
                    e.localizedDescription()
                ))
            })?;

            // SAFETY: `stream` is a valid, fully-configured `SCStream`.
            block_on_error_completion(|block| unsafe {
                stream.startCaptureWithCompletionHandler(Some(block))
            })
            .map_err(|msg| MinuteError::Other(format!("failed to start system-audio capture: {msg}")))?;

            Ok(Self {
                stream,
                queue,
                handler,
            })
        }

        /// Stops the stream gracefully: blocks (up to
        /// [`SCK_COMPLETION_TIMEOUT`]) for ScreenCaptureKit's own async stop
        /// to complete, surfacing (logging) any error — the path to prefer
        /// whenever there's time to wait for it.
        ///
        /// Not the *only* teardown path — simply dropping a [`SysCapture`]
        /// without calling this first also asks ScreenCaptureKit to stop,
        /// via this type's own [`Drop`] impl. That backstop exists
        /// precisely *because* releasing the underlying `Retained<SCStream>`
        /// alone is **not** documented by Apple to guarantee the stream's
        /// XPC-backed capture session (and the OS's own recording
        /// indicator) actually stops — dropping the last Objective-C
        /// reference and *asking ScreenCaptureKit to stop* are two
        /// different things, and only the latter is what this method (and
        /// `Drop`) actually do.
        pub fn stop(self) {
            // SAFETY: `self.stream` is a valid `SCStream` that was
            // successfully started in `start`.
            let result = block_on_error_completion(|block| unsafe {
                self.stream.stopCaptureWithCompletionHandler(Some(block))
            });
            if let Err(msg) = result {
                log::warn!("failed to cleanly stop system-audio capture (tearing down anyway): {msg}");
            }

            // Flush the trailing partial (not-yet-`SYS_BLOCK_SAMPLES`) block
            // the last callback invocation left batched but unsent — safe
            // only now, after the stop completion above has already fired
            // (or timed out): `SCStreamOutput`'s callback must not fire
            // again past that point, so nothing else can race this read of
            // `CallbackState`. Mirrors `audio.rs::run_writer_thread`'s own
            // post-loop trailing-block flush — without this, up to
            // `SYS_BLOCK_SAMPLES` (~0.5s) of system audio right at the end
            // of every recording would be silently dropped instead of
            // reaching the mixer.
            let mut state = lock(&self.handler.ivars().state);
            if let Some(block) = state.batcher.flush() {
                try_send_sys_block(&self.handler.ivars().tx, block, &mut state.dropped);
            }
        }
    }

    /// Unconditional teardown backstop: fires a best-effort, fire-and-
    /// forget stop request whenever a [`SysCapture`] is dropped without an
    /// explicit [`SysCapture::stop`] call first (e.g. a panic unwind
    /// through `audio::Recorder`'s own caller). Deliberately does **not** block —
    /// unlike `stop()`'s [`block_on_error_completion`], `Drop` can run in
    /// arbitrary contexts (including mid-panic-unwind), where blocking on
    /// an XPC round trip would itself be a hazard — so this passes `None`
    /// as the completion handler: it asks ScreenCaptureKit to stop and
    /// moves on without waiting to learn whether it succeeded. See
    /// `stop()`'s own doc comment for why this exists at all: releasing
    /// `self.stream`'s last Objective-C reference alone is not documented
    /// to guarantee the underlying capture session actually stops, and
    /// leaving the OS's own recording indicator running with no code path
    /// left to turn it off would be a real, user-visible bug.
    impl Drop for SysCapture {
        fn drop(&mut self) {
            // SAFETY: `self.stream` is a valid `SCStream` for as long as
            // `self` is alive, which it is here.
            unsafe { self.stream.stopCaptureWithCompletionHandler(None) };
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod capture {
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc::SyncSender;
    use std::sync::Arc;

    use crate::error::{MinuteError, Result};

    pub struct SysCapture;

    impl SysCapture {
        pub fn start(_tx: SyncSender<Arc<Vec<f32>>>, _paused: Arc<AtomicBool>) -> Result<Self> {
            Err(MinuteError::Other(
                "system audio capture is macOS-only".to_string(),
            ))
        }

        pub fn stop(self) {}
    }
}

// `audio::Recorder::start`'s system-audio branch (Stage 5 Task 5) is this
// type's real caller now — see that function's docs.
pub use capture::SysCapture;

// ---------------------------------------------------------------------------
// e2e: real ScreenCaptureKit capture (manual only)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Starts a real `SysCapture`, plays `tests/fixtures/hello.wav` (the
    /// same 16kHz-mono fixture `stt.rs`'s own e2e test uses) through the
    /// system's default output via `afplay`, and asserts non-silent 16kHz
    /// mono samples actually arrived (RMS above a small epsilon).
    ///
    /// Skips (with a clear `eprintln!`, not a hard failure) when
    /// availability isn't `Ready` — that's expected on an unprimed CI/dev
    /// machine (no Screen Recording grant yet) and is exactly the state
    /// [`sys_audio_status`]'s own state machine already covers via ordinary
    /// unit tests; this test's job is only to prove the *full* real-capture
    /// path on a machine that has actually granted permission.
    ///
    /// There's a second, distinct way this test can honestly fail even with
    /// `Ready` availability and a stream that starts without error: if
    /// `mod capture::extract_audio_buffers` can't actually decode the
    /// `CMSampleBuffer`s the callback receives (an `SCStream` audio session
    /// that starts cleanly but never yields usable samples is a real,
    /// previously-hit failure mode here — see that function's own doc
    /// comment for the exact two-call parameterization it took to fix, and
    /// the specific `OSStatus` codes a wrong one reproducibly hits). If this
    /// test ever fails again with `Ready` availability, a clean start, but
    /// `collected.is_empty()`, that (extraction silently never succeeding),
    /// not a permission problem, is the first thing to check — the
    /// `system-audio buffer extraction failed` warning (rate-limited via
    /// `SYS_DROP_LOG_INTERVAL`) is the diagnostic to look for.
    ///
    /// Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     real_system_audio_capture_delivers_samples -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn real_system_audio_capture_delivers_samples() {
        let status = current_status();
        if status.availability != SysAudioAvailability::Ready {
            eprintln!(
                "skipping: sys_audio_status() = {:?} (needs Screen Recording permission granted \
                 to this test binary — run request_sys_audio_permission or grant it manually in \
                 System Settings, then re-run)",
                status.availability
            );
            return;
        }

        let (tx, rx) = channel();
        let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let capture =
            SysCapture::start(tx, paused).expect("SysCapture::start failed despite Ready availability");

        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hello.wav");
        assert!(fixture.exists(), "expected fixture at {fixture:?}");
        let mut afplay = std::process::Command::new("afplay")
            .arg(&fixture)
            .spawn()
            .expect("failed to spawn afplay");

        let deadline = Instant::now() + Duration::from_secs(4);
        let mut collected: Vec<f32> = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(block) => collected.extend_from_slice(&block),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = afplay.wait();
        capture.stop();

        eprintln!("collected {} samples ({:.2}s at 16kHz)", collected.len(), collected.len() as f64 / 16_000.0);
        assert!(!collected.is_empty(), "expected at least one system-audio block to arrive");

        let rms = (collected.iter().map(|s| s * s).sum::<f32>() / collected.len() as f32).sqrt();
        eprintln!("RMS = {rms}");
        assert!(rms > 1e-4, "expected non-silent audio, got RMS {rms}");
    }
}
