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
//!    [`SysCapture`] — owns a real `screencapturekit::SCStream` configured
//!    audio-only, wires its callback through the pure pipeline above, and
//!    forwards fixed-size mono-at-16kHz blocks over a bounded
//!    `SyncSender<Arc<Vec<f32>>>` — the exact channel shape `Recorder`'s mic
//!    path already uses (see `audio.rs`'s `sample_tx`). A non-macOS stub
//!    keeps the crate compiling everywhere, mirroring `detect.rs`'s
//!    `MicMonitor` split (this app only ships for macOS in practice, but
//!    nothing else in the crate has to `#[cfg]` around referencing this
//!    module).
//!
//! ## What ScreenCaptureKit actually delivers (verified against the
//! `screencapturekit` crate's own source and bundled examples — its public
//! docs don't pin this down anywhere)
//!
//! `SCStreamConfiguration::with_sample_rate`/`with_channel_count` configure
//! the *requested* format (this module asks for 48kHz stereo — the crate's
//! own documented default and every one of its examples' choice). What
//! actually arrives per callback is a `CMSampleBuffer` whose
//! `audio_buffer_list()` yields one or more `AudioBuffer`s of raw
//! little-endian `Float32` bytes (confirmed by reading
//! `examples/16_full_metal_app/capture.rs` upstream, the one place in the
//! whole crate — including its own doc comments — that actually decodes an
//! audio buffer's bytes: `data.chunks_exact(4).map(f32::from_le_bytes)`).
//! What's genuinely *not* pinned down anywhere (crate source, its own
//! examples, or its docs) is **interleaving**: Core Audio's two possible
//! shapes for a requested 2-channel stream are (a) one buffer with
//! `number_channels == 2`, samples interleaved L/R/L/R/…, or (b) two
//! buffers each with `number_channels == 1` (planar/non-interleaved — Core
//! Audio's own canonical internal format, and the shape every independent
//! third-party report of `SCStream`'s audio output describes). Rather than
//! assume either, [`downmix_sck_buffers_to_mono`] handles both shapes
//! explicitly — see its own docs.
//!
//! ## Feedback prevention: `excludesCurrentProcessAudio`, not app-exclusion
//!
//! The plan called for excluding Minute's own process via
//! `SCContentFilter`'s `excludingApplications` (looking up Minute's own
//! `SCRunningApplication` by bundle id). `SCStreamConfiguration` instead
//! exposes `excludesCurrentProcessAudio` directly — a purpose-built flag for
//! exactly this ("prevents feedback loops in recording applications" per
//! the crate's own doc comment) that needs no bundle-id lookup and can't
//! fail to find "self" in the shareable-content snapshot. Used here instead
//! as a strictly more robust equivalent — same effect, simpler and one
//! fewer failure mode.
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
//! ## A load-time risk this task's dependency addition uncovered (fixed,
//! not just noted — see `Cargo.toml`'s `[patch.crates-io]` comment)
//!
//! `screencapturekit`'s own `build.rs` (and its transitive `apple-metal`
//! dependency's) link `ScreenCaptureKit.framework`/`MetalFX.framework`
//! unconditionally via a plain hard framework link. Both frameworks are
//! macOS-13+-only, which sits above this crate's declared 11.0 floor — a
//! hard link would make dyld refuse to launch the *entire app* on macOS
//! 11/12, not just gracefully report [`SysAudioAvailability::Unsupported`]
//! here. Both crates are vendored with a one-line fix (weak-link instead)
//! rather than left as a latent regression; see `Cargo.toml` for the full
//! writeup and the empirical proof the fix actually changes the emitted
//! Mach-O load command type.

use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::audio::downmix_to_mono;

/// `#[allow(dead_code)]`: its only ordinary-build caller is `mod capture`'s
/// `did_output_sample_buffer`, itself only reachable once something calls
/// `SysCapture::start` — see [`DecodedAudioBuffer`]'s docs for the full
/// pending-Task-5 rationale this shares.
#[allow(dead_code)]
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
/// quirk: apps that queried shareable content before permission was granted
/// have historically needed a relaunch before `SCStream` will actually
/// start capturing, even once `CGPreflightScreenCaptureAccess` itself
/// already reports `true` (the `screencapturekit` crate's own bundled
/// Tauri example tells users exactly this: "Enable the app… Restart the
/// app" — see its `examples/22_tauri_app/README.md`). This command cannot
/// paper over that; it reports the honest TCC-level state, and a caller
/// that gets `Ready` back but then has `SysCapture::start` fail anyway
/// should suggest a restart, not treat it as a bug.
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
/// `#[allow(dead_code)]` — see [`DecodedAudioBuffer`]'s docs for why.
#[allow(dead_code)]
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
///
/// `#[allow(dead_code)]`: real construction only happens inside `mod
/// capture`'s `did_output_sample_buffer`, which nothing in the ordinary
/// (non-test) build graph calls yet — `SysCapture::start`'s only caller
/// today is the `#[ignore]`d e2e test below, pending Task 5's mixer —
/// matching `stt::transcribe_samples`'s identical shape/rationale.
#[allow(dead_code)]
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
///
/// `#[allow(dead_code)]` — see [`DecodedAudioBuffer`]'s docs for why (same
/// pending-Task-5 reason); exercised directly by this module's own
/// `pipeline_tests` regardless.
#[allow(dead_code)]
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
///
/// `#[allow(dead_code)]` — see [`DecodedAudioBuffer`]'s docs for why.
#[allow(dead_code)]
pub(crate) struct BlockBatcher {
    block_samples: usize,
    buf: Vec<f32>,
}

// The struct itself is `#[allow(dead_code)]`'d above; its inherent methods
// need their own matching allow — the struct-level attribute doesn't cover
// a separate `impl` block.
#[allow(dead_code)]
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
    /// partial-block handling, for whoever calls `SysCapture::stop`.
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
///
/// `#[allow(dead_code)]` — see [`DecodedAudioBuffer`]'s docs for why.
#[allow(dead_code)]
const SYS_BLOCK_SAMPLES: usize = 8_000;

/// Bounded channel capacity — same ~128s headroom as `audio.rs`'s
/// `STT_CHANNEL_CAPACITY`. Generous on purpose: Task 5's mixer consumer
/// doesn't exist yet, so there's no real drain-rate to size against —
/// revisit once one does.
const SYS_CHANNEL_CAPACITY: usize = 256;

/// Requested (not necessarily exactly what's delivered — see the module
/// docs) audio format. 48kHz stereo: the `screencapturekit` crate's own
/// documented default and every one of its examples' choice.
///
/// `#[allow(dead_code)]` on both — see [`DecodedAudioBuffer`]'s docs for why
/// (only used inside `mod capture::SysCapture::start`).
#[allow(dead_code)]
const SYS_AUDIO_SAMPLE_RATE_HZ: i32 = 48_000;
#[allow(dead_code)]
const SYS_AUDIO_CHANNELS: i32 = 2;

/// The sender/receiver pair [`channel`] returns — named so clippy's
/// `type_complexity` lint (and every reader) gets a label instead of a bare
/// nested-generic tuple at every call site.
pub type SysAudioChannel = (SyncSender<Arc<Vec<f32>>>, std::sync::mpsc::Receiver<Arc<Vec<f32>>>);

/// Creates the bounded `Arc<Vec<f32>>` channel [`SysCapture::start`] sends
/// blocks over — the same shape `Recorder::start`'s `sample_tx` uses (see
/// `audio.rs`), so Task 5's eventual mixer can consume both sources
/// identically. Exposed as its own function (rather than leaving every
/// caller to spell out the type + capacity) since the channel's *shape* is
/// this task's actual contract, per the plan — its consumer arrives later.
///
/// `#[allow(dead_code)]` — see [`DecodedAudioBuffer`]'s docs for why; used
/// today by this module's own `#[ignore]`d e2e test.
#[allow(dead_code)]
pub fn channel() -> SysAudioChannel {
    std::sync::mpsc::sync_channel(SYS_CHANNEL_CAPACITY)
}

/// Tries to forward one accumulated block onto `tx`. Bounded + `try_send`,
/// drop-on-full — identical discipline to `audio.rs`'s
/// `try_send_stt_block` (see that function's docs for the full rationale):
/// a slow/stalled/nonexistent consumer must never make the realtime SCK
/// callback thread block.
///
/// `#[allow(dead_code)]` — see [`DecodedAudioBuffer`]'s docs for why.
#[allow(dead_code)]
fn try_send_sys_block(tx: &SyncSender<Arc<Vec<f32>>>, block: Vec<f32>, dropped: &mut u64) {
    match tx.try_send(Arc::new(block)) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            *dropped += 1;
            if *dropped % 50 == 0 {
                log::warn!("sys-audio channel full — dropped {dropped} ~0.5s blocks so far");
            }
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

#[cfg(target_os = "macos")]
mod capture {
    //! Real `SCStream`-backed capture engine. Deliberately thin: every byte
    //! of actual decode/downmix/resample/batch logic lives in this file's
    //! pure pipeline section above — this module's own job is limited to
    //! configuring the stream, adapting its callback shape, and lifecycle
    //! (start/stop).

    use std::sync::mpsc::SyncSender;
    use std::sync::{Arc, Mutex};

    use screencapturekit::prelude::*;

    use super::{
        bytes_to_f32_le, downmix_sck_buffers_to_mono, lock, resolve_availability, try_send_sys_block,
        availability_shim, BlockBatcher, DecodedAudioBuffer, SysAudioAvailability, SYS_AUDIO_CHANNELS,
        SYS_AUDIO_SAMPLE_RATE_HZ, SYS_BLOCK_SAMPLES,
    };
    use crate::audio::{LinearResampler, TARGET_SAMPLE_RATE};
    use crate::error::{MinuteError, Result};

    /// The `SCStreamOutputTrait` implementation wired to `SCStream`'s Audio
    /// output. Holds only what the realtime callback needs: the resampler
    /// (stateful — carries fractional position across calls, see
    /// `LinearResampler`'s docs), the block batcher, a running dropped-block
    /// counter, and the outgoing channel. `Mutex`-wrapped per-field (rather
    /// than one big `Mutex<Inner>`) is unnecessary here — a single
    /// `Mutex<CallbackState>` is simpler and no less correct, since
    /// `ScreenCaptureKit` serialises Audio-type callbacks per its own
    /// dispatch queue in practice (this crate's own `SCStream` doc comment:
    /// "independent dispatch queues" — plural, one *per output type*, not
    /// per callback) — but `SCStreamOutputTrait` still requires `Sync`
    /// regardless (see that trait's docs), so a lock is required either way.
    ///
    /// Both this and [`SysAudioHandler`] are `#[allow(dead_code)]`: neither
    /// is constructed anywhere the ordinary (non-test) build can reach yet
    /// — `SysCapture::start` (which builds both) has no caller until Task
    /// 5's mixer exists; same pending-Task-5 rationale as the outer
    /// `syscap` module's `DecodedAudioBuffer`/`BlockBatcher`/`channel`/`lock`.
    #[allow(dead_code)]
    struct CallbackState {
        resampler: LinearResampler,
        batcher: BlockBatcher,
        dropped: u64,
    }

    #[allow(dead_code)]
    struct SysAudioHandler {
        tx: SyncSender<Arc<Vec<f32>>>,
        state: Mutex<CallbackState>,
    }

    impl SCStreamOutputTrait for SysAudioHandler {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }
            let Some(buffer_list) = sample.audio_buffer_list() else {
                return;
            };
            let decoded: Vec<DecodedAudioBuffer> = buffer_list
                .iter()
                .map(|buffer| DecodedAudioBuffer {
                    number_channels: buffer.number_channels as u16,
                    samples: bytes_to_f32_le(buffer.data()),
                })
                .collect();
            let mono = downmix_sck_buffers_to_mono(&decoded);
            if mono.is_empty() {
                return;
            }

            let mut state = lock(&self.state);
            let resampled = state.resampler.resample(&mono);
            if resampled.is_empty() {
                return;
            }
            let blocks = state.batcher.push(&resampled);
            for block in blocks {
                try_send_sys_block(&self.tx, block, &mut state.dropped);
            }
        }
    }

    /// A live system-audio capture session: owns the real `SCStream` for as
    /// long as this handle lives.
    ///
    /// `#[allow(dead_code)]` on the struct and its `impl` below: pending
    /// Task 5's mixer, this crate's only caller of `start`/`stop` today is
    /// this module's own `#[ignore]`d e2e test — same rationale as every
    /// other item this module docs' `DecodedAudioBuffer` entry explains.
    #[allow(dead_code)]
    pub struct SysCapture {
        stream: SCStream,
    }

    #[allow(dead_code)]
    impl SysCapture {
        /// Starts capturing system audio, downmixing/resampling to 16kHz
        /// mono and forwarding ~0.5s blocks over `tx` — see the module docs
        /// for the full pipeline. Fails fast (never panics, never crashes)
        /// when availability isn't [`SysAudioAvailability::Ready`], rather
        /// than letting an avoidable case surface as a confusing
        /// `SCShareableContent`/`SCStream` error — see this crate's
        /// module docs' "NEVER crash on denial" requirement.
        pub fn start(tx: SyncSender<Arc<Vec<f32>>>) -> Result<Self> {
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

            let content = SCShareableContent::get().map_err(|e| {
                MinuteError::Other(format!(
                    "failed to query shareable content (Screen Recording permission may need an \
                     app restart to take effect — see request_sys_audio_permission's docs): {e}"
                ))
            })?;
            let displays = content.displays();
            let display = displays.first().ok_or_else(|| {
                MinuteError::Other("no displays available to build a content filter".to_string())
            })?;

            let filter = SCContentFilter::create()
                .with_display(display)
                .with_excluding_windows(&[])
                .build();

            // Video is never consumed (no Screen output handler registered
            // below) — 2x2 @ 1fps is the smallest practical footprint for
            // the internal video track SCStream always produces, rather
            // than 0x0 (untested whether every supported macOS version
            // accepts a zero-size configuration). See the module docs'
            // "Video: never consumed, deliberately minimized" section.
            let config = SCStreamConfiguration::new()
                .with_width(2)
                .with_height(2)
                .with_fps(1)
                .with_captures_audio(true)
                .with_sample_rate(SYS_AUDIO_SAMPLE_RATE_HZ)
                .with_channel_count(SYS_AUDIO_CHANNELS)
                .with_excludes_current_process_audio(true);

            let handler = SysAudioHandler {
                tx,
                state: Mutex::new(CallbackState {
                    resampler: LinearResampler::new(SYS_AUDIO_SAMPLE_RATE_HZ as u32, TARGET_SAMPLE_RATE),
                    batcher: BlockBatcher::new(SYS_BLOCK_SAMPLES),
                    dropped: 0,
                }),
            };

            let mut stream = SCStream::new(&filter, &config);
            stream.add_output_handler(handler, SCStreamOutputType::Audio);
            stream
                .start_capture()
                .map_err(|e| MinuteError::Other(format!("failed to start system-audio capture: {e}")))?;

            Ok(Self { stream })
        }

        /// Stops the stream cleanly. Not the only teardown path — simply
        /// dropping a [`SysCapture`] without calling this is also safe:
        /// `SCStream`'s own `Drop` releases the underlying stream and
        /// context unconditionally (see that type's doc comment on its
        /// `Drop` impl), so an app-exit/panic path that never gets to call
        /// `stop()` explicitly still tears down soundly. This method is the
        /// *graceful* path (blocks briefly for `ScreenCaptureKit`'s own
        /// async stop to complete) — worth taking when there's time to.
        pub fn stop(self) {
            if let Err(e) = self.stream.stop_capture() {
                log::warn!("failed to cleanly stop system-audio capture (tearing down anyway): {e}");
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod capture {
    use std::sync::mpsc::SyncSender;
    use std::sync::Arc;

    use crate::error::{MinuteError, Result};

    pub struct SysCapture;

    impl SysCapture {
        pub fn start(_tx: SyncSender<Arc<Vec<f32>>>) -> Result<Self> {
            Err(MinuteError::Other(
                "system audio capture is macOS-only".to_string(),
            ))
        }

        pub fn stop(self) {}
    }
}

// Not yet consumed anywhere else in the crate — Task 5's mic+system mixer
// (`Recorder`'s eventual second source) is this type's real caller. Kept
// `pub` and re-exported now regardless, same "the channel shape is the
// contract" reasoning the plan calls out for this task, and the same
// "land the seam now, wire the caller later" shape as `detect.rs`'s
// `#[allow(dead_code)] DetectorEvent::SetEnabled` variant.
#[allow(unused_imports)]
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
    /// path on a machine that has actually granted permission. Run
    /// manually:
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
        let capture = SysCapture::start(tx).expect("SysCapture::start failed despite Ready availability");

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
