//! Chunked whisper-rs transcription worker streaming segments to the frontend.
//!
//! Pure, unit-tested building blocks ([`Chunker`], [`dedupe_segments`]) are
//! factored out from the hardware/model-facing [`SttWorker`] the same way
//! `audio.rs` separates `downmix_to_mono`/`LinearResampler`/`WavWriter` from
//! `Recorder` — see that module's header comment for the rationale.

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

/// One transcription-ready window handed back by [`Chunker::push`]/`flush`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkOut {
    pub samples: Vec<f32>,
    /// Stream position (seconds since the start of the recording) of
    /// `samples[0]`.
    pub start_offset_secs: f64,
}

/// Accumulates streamed f32 samples (16 kHz mono, or whatever `sample_rate`
/// is configured for) into fixed-size, overlapping transcription windows.
///
/// Each emitted window is `window_secs` long; consecutive windows share
/// `overlap_secs` of tail/head audio so words spoken right at a chunk
/// boundary still land fully inside at least one window's high-confidence
/// interior — `dedupe_segments` is what later drops the duplicate copy
/// whisper produces for that shared region.
pub struct Chunker {
    window_samples: usize,
    overlap_samples: usize,
    /// Minimum leftover length `flush` will hand back — anything shorter is
    /// judged not worth a whisper call and is discarded.
    min_flush_samples: usize,
    sample_rate: u32,
    /// Samples accumulated since the last emitted window's tail was
    /// retained (or since construction, for the very first window).
    buffer: Vec<f32>,
    /// Absolute stream-sample position of `buffer[0]`.
    buffer_start_sample: u64,
}

impl Chunker {
    pub fn new(window_secs: f32, overlap_secs: f32, sample_rate: u32) -> Self {
        let window_samples = (window_secs * sample_rate as f32).round() as usize;
        let overlap_samples = (overlap_secs * sample_rate as f32).round() as usize;
        let min_flush_samples = (0.5 * sample_rate as f32).round() as usize;
        Self {
            window_samples,
            overlap_samples,
            min_flush_samples,
            sample_rate,
            buffer: Vec::new(),
            buffer_start_sample: 0,
        }
    }

    fn samples_to_secs(&self, samples: u64) -> f64 {
        samples as f64 / self.sample_rate as f64
    }

    /// Appends `samples` to the internal buffer and, if that fills a full
    /// window, returns it — retaining the trailing `overlap_secs` worth of
    /// samples as the start of the next window.
    ///
    /// A single call only ever returns at most one window. If `samples` is
    /// large enough to complete more than one window at once, call `push`
    /// again with an empty slice to drain the rest (the [`SttWorker`] loop
    /// does exactly this).
    pub fn push(&mut self, samples: &[f32]) -> Option<ChunkOut> {
        self.buffer.extend_from_slice(samples);
        if self.buffer.len() < self.window_samples {
            return None;
        }

        let window = self.buffer[..self.window_samples].to_vec();
        let start_offset_secs = self.samples_to_secs(self.buffer_start_sample);

        let keep_from = self.window_samples - self.overlap_samples;
        self.buffer_start_sample += keep_from as u64;
        self.buffer.drain(..keep_from);

        Some(ChunkOut {
            samples: window,
            start_offset_secs,
        })
    }

    /// Hands back whatever's left in the buffer as a final (non-overlapping)
    /// window, provided it's at least the minimum flush duration (0.5s) —
    /// shorter tails are discarded as not worth transcribing. Either way,
    /// the buffer is cleared: `flush` is a terminal operation for a stream.
    pub fn flush(&mut self) -> Option<ChunkOut> {
        if self.buffer.len() < self.min_flush_samples {
            self.buffer.clear();
            return None;
        }
        let start_offset_secs = self.samples_to_secs(self.buffer_start_sample);
        let samples = std::mem::take(&mut self.buffer);
        Some(ChunkOut {
            samples,
            start_offset_secs,
        })
    }
}

// ---------------------------------------------------------------------------
// dedupe_segments
// ---------------------------------------------------------------------------

/// One transcribed segment, in whatever coordinate space the caller
/// specifies (chunk-relative for whisper's raw output, absolute after
/// [`dedupe_segments`] has converted it).
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Converts `new_segments` (whisper's raw output, timed relative to the
/// start of the chunk that produced them) to absolute stream time by adding
/// `chunk_start_secs`, then keeps only the ones whose midpoint falls after
/// `already_emitted_until` — i.e. drops segments whisper re-transcribed
/// purely because they fell inside the previous window's overlap tail.
///
/// A segment landing exactly on the boundary (`midpoint == already_emitted_until`)
/// is dropped, not kept — `already_emitted_until` is itself the end of an
/// already-emitted segment, so a new segment centered exactly there would be
/// a duplicate of it, not a fresh one.
///
/// **Accepted loss mode:** a segment is an atomic unit here — one that
/// genuinely *straddles* the overlap boundary (starts inside the already-
/// emitted region but continues meaningfully past it) is dropped in its
/// *entirety* if its midpoint still falls inside that region, rather than
/// being split at the boundary and having its tail kept. In practice this
/// can lose real words, but the loss is bounded: it can only happen to
/// whisper's re-transcription of the shared `OVERLAP_SECS` (1s) region
/// itself, so at most ~1s of audio per chunk boundary is at risk, and only
/// when whisper happens to group it into one segment whose midpoint lands
/// on the "already emitted" side. Splitting segments at the boundary
/// instead would require token-level timestamps, which isn't implemented
/// here — revisit if this shows up as real "missing words" complaints.
/// Every drop is logged at `debug` level (text + absolute times) below so
/// such reports are debuggable after the fact.
pub fn dedupe_segments(
    new_segments: &[Segment],
    chunk_start_secs: f64,
    already_emitted_until: f64,
) -> Vec<Segment> {
    new_segments
        .iter()
        .filter_map(|seg| {
            let start = chunk_start_secs + seg.start;
            let end = chunk_start_secs + seg.end;
            let midpoint = (start + end) / 2.0;
            if midpoint > already_emitted_until {
                Some(Segment {
                    start,
                    end,
                    text: seg.text.clone(),
                })
            } else {
                log::debug!(
                    "stt: dropped overlap-region segment {start:.2}-{end:.2}s \
                     (already emitted until {already_emitted_until:.2}s): {:?}",
                    seg.text
                );
                None
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// transcribe_samples / SttWorker (hardware/model-facing — thin, not unit-tested
// beyond the pure pieces above; exercised for real by the `#[ignore]`d e2e test)
// ---------------------------------------------------------------------------

use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::audio::TARGET_SAMPLE_RATE;
use crate::error::{MinuteError, Result};
use crate::store::{lock_store, SharedStore, StoredSegment};

/// The chunking window/overlap used by `SttWorker` — 8s windows with a 1s
/// overlap tail, per the plan's tuning.
const WINDOW_SECS: f32 = 8.0;
const OVERLAP_SECS: f32 = 1.0;

/// Placeholder speaker label — diarization is out of scope for Stage 2;
/// every segment is attributed to this one constant "speaker" for now.
const SPEAKER_PLACEHOLDER: &str = "Speaker 1";

/// Redirects whisper.cpp/GGML's own logging (which otherwise prints
/// directly to stdout regardless of `FullParams::set_print_*` — those only
/// cover whisper.cpp's higher-level progress/timestamp printing, not its
/// low-level per-token debug tracing) into the `log` crate via whisper-rs's
/// `log_backend` feature. Safe/cheap to call on every model load — the
/// underlying `whisper_rs::install_logging_hooks` is a `std::sync::Once`
/// internally and only takes effect the first call.
fn ensure_whisper_logging_redirected() {
    whisper_rs::install_logging_hooks();
}

/// Runs whisper's default full-transcription params against `state`,
/// suppressing all of whisper.cpp's own stdout/stderr printing, and
/// converts its raw (chunk-relative, centisecond) segment output into
/// [`Segment`]s (seconds).
fn run_full_and_extract(state: &mut WhisperState, samples: &[f32]) -> Result<Vec<Segment>> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // Auto-detect the spoken language rather than assuming English. This is
    // re-detected independently per window (no state carried across
    // windows), so it can visibly flip mid-recording on genuinely
    // ambiguous audio — accepted deliberately, since it's what makes
    // code-switching (a meeting that shifts between languages) work at
    // all; revisit if users report it flapping on audio that isn't actually
    // multilingual.
    params.set_language(Some("auto"));
    // Keep whisper.cpp's own logging off stdout — this runs on a
    // background thread and the app already has its own `log` pipeline.
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Suppress non-speech tokens (e.g. `[BLANK_AUDIO]`-style artifacts) —
    // matches the plan's "suppress non-speech tokens default" note.
    params.set_suppress_nst(true);

    state
        .full(params, samples)
        .map_err(|e| MinuteError::Other(format!("whisper inference failed: {e}")))?;

    let n_segments = state.full_n_segments();
    let mut segments = Vec::with_capacity(n_segments.max(0) as usize);
    for i in 0..n_segments {
        let Some(seg) = state.get_segment(i) else {
            continue;
        };
        let text = seg
            .to_str_lossy()
            .map(|c| c.trim().to_string())
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        segments.push(Segment {
            // Centiseconds (10s of ms) -> seconds.
            start: seg.start_timestamp() as f64 / 100.0,
            end: seg.end_timestamp() as f64 / 100.0,
            text,
        });
    }
    Ok(segments)
}

/// One-shot helper: loads a whisper model from `model_path`, runs a full
/// transcription over `samples`, and returns its segments (chunk-relative
/// timestamps — the caller is responsible for offsetting/deduping, same as
/// `SttWorker`'s per-window loop, which shares [`run_full_and_extract`]
/// with this function rather than reloading the model on every window).
///
/// Used directly by the `#[ignore]`d e2e test (`real_model_transcribes_speech`)
/// so it can exercise real whisper inference without spinning up the full
/// worker thread/channel/event machinery — its only caller outside `#[cfg(test)]`
/// code, hence `#[allow(dead_code)]` on ordinary (non-test) builds, matching
/// `download::feed_chunks_checking_cancel`'s same shape.
#[allow(dead_code)]
pub fn transcribe_samples(model_path: &Path, samples: &[f32]) -> Result<Vec<Segment>> {
    ensure_whisper_logging_redirected();
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| MinuteError::Other(format!("failed to load whisper model: {e}")))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| MinuteError::Other(format!("failed to create whisper state: {e}")))?;
    run_full_and_extract(&mut state, samples)
}

/// `stt-status` event's lifecycle state: `loading` (model load in
/// progress) -> `ready` (loaded, actively consuming chunks) -> `finalizing`
/// (recording stopped, worker draining/flushing its tail window before its
/// thread is joined — see `stop_recording`) is the normal happy path;
/// `error` can be emitted at any point a fatal or per-window failure
/// occurs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SttStatusState {
    Loading,
    Ready,
    Finalizing,
    Error,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatusPayload {
    pub note_id: String,
    pub state: SttStatusState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentPayload {
    pub note_id: String,
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Events an [`SttWorker`] emits — captured directly by tests via an
/// injected closure, or wired to real Tauri events via [`tauri_emit`].
#[derive(Debug, Clone, PartialEq)]
pub enum SttEvent {
    TranscriptSegment(TranscriptSegmentPayload),
    SttStatus(SttStatusPayload),
}

/// Builds the real emit closure used outside tests: serializes each
/// [`SttEvent`] to its wire event name (`transcript-segment` /
/// `stt-status`, both already camelCase per the payload structs' `serde`
/// attributes) and emits it, warning (not panicking) on failure — same
/// convention as `audio::emit_recording_state` / `download::emit_progress`.
pub fn tauri_emit(app: AppHandle) -> impl Fn(SttEvent) + Send + 'static {
    move |event| match event {
        SttEvent::TranscriptSegment(payload) => {
            let note_id = payload.note_id.clone();
            if let Err(e) = app.emit("transcript-segment", payload) {
                log::warn!("failed to emit transcript-segment for {note_id}: {e}");
            }
        }
        SttEvent::SttStatus(payload) => {
            let note_id = payload.note_id.clone();
            if let Err(e) = app.emit("stt-status", payload) {
                log::warn!("failed to emit stt-status for {note_id}: {e}");
            }
        }
    }
}

/// Everything an [`SttWorker`] needs beyond the model path and sample
/// channel: where to persist segments, which note they belong to, and how
/// to notify the outside world. `emit` is an injected closure (rather than
/// a hard Tauri dependency) so tests can capture emitted events directly —
/// see the module docs.
pub struct WorkerCtx {
    pub note_id: String,
    pub store: SharedStore,
    pub emit: Box<dyn Fn(SttEvent) + Send + 'static>,
}

/// Spawned thread that owns a `WhisperContext`/`WhisperState`, consumes
/// streamed sample chunks, and turns them into persisted + emitted
/// transcript segments.
pub struct SttWorker;

impl SttWorker {
    /// Spawns the worker thread. Returns immediately; the model itself
    /// loads on the spawned thread (loading a multi-hundred-MB ggml model
    /// on the caller's thread — a Tauri command handler — would stall
    /// `start_recording`'s response).
    pub fn spawn(
        model_path: std::path::PathBuf,
        sample_rx: Receiver<Arc<Vec<f32>>>,
        ctx: WorkerCtx,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || run_worker(model_path, sample_rx, ctx))
    }
}

/// Runs one transcription window through `state` (the actual whisper
/// inference), then hands its raw segments off to
/// [`handle_window_segments`] for dedupe/persist/emit. A per-window
/// inference failure is logged + reported via an `stt-status` error event
/// but is not treated as fatal — the worker keeps consuming subsequent
/// chunks (fatal errors are model-load/state-creation failures only, which
/// `run_worker` handles before this function is ever called).
fn process_window(
    state: &mut WhisperState,
    window: &ChunkOut,
    ctx: &WorkerCtx,
    emitted_until: &mut f64,
) {
    let raw_segments = match run_full_and_extract(state, &window.samples) {
        Ok(segments) => segments,
        Err(e) => {
            log::warn!(
                "whisper inference failed for note {} window at {:.1}s: {e}",
                ctx.note_id,
                window.start_offset_secs
            );
            (ctx.emit)(SttEvent::SttStatus(SttStatusPayload {
                note_id: ctx.note_id.clone(),
                state: SttStatusState::Error,
                error: Some(e.to_string()),
            }));
            return;
        }
    };

    handle_window_segments(&raw_segments, window.start_offset_secs, emitted_until, ctx);
}

/// Bookkeeping half of window processing, split out from [`process_window`]
/// so it's unit-testable without a real `WhisperContext`/inference: dedupes
/// `raw_segments` (whisper's raw, chunk-relative output) against
/// `*emitted_until` via [`dedupe_segments`], then for every kept segment
/// persists it via `ctx.store.append_segment` and emits
/// `SttEvent::TranscriptSegment`, in order. Advances `*emitted_until` to
/// the *maximum* end time among kept segments (not simply the last one
/// processed — whisper's segments are normally end-time-ordered, but nothing
/// here assumes that).
fn handle_window_segments(
    raw_segments: &[Segment],
    chunk_start_secs: f64,
    emitted_until: &mut f64,
    ctx: &WorkerCtx,
) {
    let kept = dedupe_segments(raw_segments, chunk_start_secs, *emitted_until);
    for seg in kept {
        if seg.end > *emitted_until {
            *emitted_until = seg.end;
        }

        let stored = StoredSegment {
            speaker: SPEAKER_PLACEHOLDER.to_string(),
            start: seg.start,
            end: seg.end,
            text: seg.text.clone(),
        };
        if let Err(e) = lock_store(&ctx.store).append_segment(&ctx.note_id, stored) {
            log::warn!(
                "failed to persist transcript segment for note {}: {e}",
                ctx.note_id
            );
        }

        (ctx.emit)(SttEvent::TranscriptSegment(TranscriptSegmentPayload {
            note_id: ctx.note_id.clone(),
            speaker: SPEAKER_PLACEHOLDER.to_string(),
            start: seg.start,
            end: seg.end,
            text: seg.text,
        }));
    }
}

/// The worker thread's body: load the model once, then loop consuming
/// sample chunks until the channel closes (recording stopped), flush the
/// final partial window, and log a realtime-factor summary.
///
/// On a model load/state-creation failure (the only failures treated as
/// fatal), emits `stt-status` error once and then just drains `sample_rx`
/// to completion without processing anything — so the channel never fills
/// up and blocks the writer thread's `try_send`, but no further transcript
/// segments are produced for this recording.
fn run_worker(model_path: std::path::PathBuf, sample_rx: Receiver<Arc<Vec<f32>>>, ctx: WorkerCtx) {
    ensure_whisper_logging_redirected();

    (ctx.emit)(SttEvent::SttStatus(SttStatusPayload {
        note_id: ctx.note_id.clone(),
        state: SttStatusState::Loading,
        error: None,
    }));

    let load_start = Instant::now();
    let whisper_ctx =
        match WhisperContext::new_with_params(&model_path, WhisperContextParameters::default()) {
            Ok(ctx) => ctx,
            Err(e) => {
                log::warn!("failed to load whisper model {model_path:?}: {e}");
                (ctx.emit)(SttEvent::SttStatus(SttStatusPayload {
                    note_id: ctx.note_id.clone(),
                    state: SttStatusState::Error,
                    error: Some(e.to_string()),
                }));
                while sample_rx.recv().is_ok() {}
                return;
            }
        };

    let mut state = match whisper_ctx.create_state() {
        Ok(state) => state,
        Err(e) => {
            log::warn!("failed to create whisper state for {model_path:?}: {e}");
            (ctx.emit)(SttEvent::SttStatus(SttStatusPayload {
                note_id: ctx.note_id.clone(),
                state: SttStatusState::Error,
                error: Some(e.to_string()),
            }));
            while sample_rx.recv().is_ok() {}
            return;
        }
    };

    log::info!(
        "stt worker for note {}: loaded {model_path:?} in {:?}",
        ctx.note_id,
        load_start.elapsed()
    );
    (ctx.emit)(SttEvent::SttStatus(SttStatusPayload {
        note_id: ctx.note_id.clone(),
        state: SttStatusState::Ready,
        error: None,
    }));

    let mut chunker = Chunker::new(WINDOW_SECS, OVERLAP_SECS, TARGET_SAMPLE_RATE);
    let mut emitted_until = 0.0f64;
    let mut total_audio_secs = 0.0f64;
    let transcribe_start = Instant::now();

    while let Ok(chunk) = sample_rx.recv() {
        total_audio_secs += chunk.len() as f64 / TARGET_SAMPLE_RATE as f64;

        // A single received chunk could (in principle) complete more than
        // one window at once — drain every window it completes, not just
        // the first, by re-calling `push` with an empty slice until it
        // stops returning one. See `Chunker::push`'s docs.
        let mut window = chunker.push(&chunk);
        while let Some(w) = window {
            process_window(&mut state, &w, &ctx, &mut emitted_until);
            window = chunker.push(&[]);
        }
    }

    if let Some(w) = chunker.flush() {
        process_window(&mut state, &w, &ctx, &mut emitted_until);
    }

    let elapsed = transcribe_start.elapsed().as_secs_f64();
    let realtime_factor = if elapsed > 0.0 {
        total_audio_secs / elapsed
    } else {
        0.0
    };
    log::info!(
        "stt worker for note {}: processed {total_audio_secs:.1}s of audio in {elapsed:.1}s \
         (realtime factor {realtime_factor:.2}x)",
        ctx.note_id
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // --- Chunker ------------------------------------------------------------

    const SR: u32 = 16_000;

    fn samples(n: usize, fill: f32) -> Vec<f32> {
        vec![fill; n]
    }

    #[test]
    fn push_uneven_chunks_summing_to_window_emits_one_chunk_at_offset_zero() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);

        // 3s + 2s + 3s = 8s, pushed in uneven pieces.
        assert!(chunker.push(&samples(3 * SR as usize, 0.1)).is_none());
        assert!(chunker.push(&samples(2 * SR as usize, 0.2)).is_none());
        let out = chunker.push(&samples(3 * SR as usize, 0.3)).unwrap();

        assert_eq!(out.samples.len(), 8 * SR as usize);
        assert_eq!(out.start_offset_secs, 0.0);
    }

    #[test]
    fn second_window_starts_at_7s_offset_due_to_1s_overlap() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        let first = chunker.push(&samples(8 * SR as usize, 0.1));
        assert!(first.is_some());

        // Window step is window_secs - overlap_secs = 7s of *new* samples.
        let second = chunker.push(&samples(7 * SR as usize, 0.2)).unwrap();

        assert_eq!(second.samples.len(), 8 * SR as usize);
        assert_eq!(second.start_offset_secs, 7.0);
    }

    #[test]
    fn sequential_windows_offsets_are_0_7_14() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        let mut offsets = Vec::new();

        // First push completes the initial 8s window (offset 0); each
        // subsequent 7s push (the window step = window_secs - overlap_secs)
        // completes exactly one more window, 7s later each time.
        if let Some(out) = chunker.push(&samples(8 * SR as usize, 0.1)) {
            offsets.push(out.start_offset_secs);
        }
        for _ in 0..2 {
            if let Some(out) = chunker.push(&samples(7 * SR as usize, 0.1)) {
                offsets.push(out.start_offset_secs);
            }
        }

        assert_eq!(offsets, vec![0.0, 7.0, 14.0]);
    }

    #[test]
    fn push_returns_none_until_window_is_full() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        assert!(chunker.push(&samples(4 * SR as usize, 0.1)).is_none());
        assert!(chunker.push(&samples(3 * SR as usize, 0.1)).is_none());
    }

    #[test]
    fn flush_returns_tail_with_correct_offset() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        // First full window at offset 0.
        chunker.push(&samples(8 * SR as usize, 0.1)).unwrap();
        // 2s of new audio after that -> buffer is 1s overlap + 2s new = 3s,
        // starting at stream position 7s.
        assert!(chunker.push(&samples(2 * SR as usize, 0.2)).is_none());

        let flushed = chunker.flush().unwrap();
        assert_eq!(flushed.samples.len(), 3 * SR as usize);
        assert_eq!(flushed.start_offset_secs, 7.0);
    }

    #[test]
    fn flush_below_minimum_duration_returns_none() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        // 0.25s < the 0.5s minimum flush duration.
        chunker.push(&samples(SR as usize / 4, 0.1));
        assert!(chunker.flush().is_none());
    }

    #[test]
    fn flush_with_nothing_buffered_returns_none() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        assert!(chunker.flush().is_none());
    }

    #[test]
    fn flush_exactly_at_minimum_duration_returns_some() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        chunker.push(&samples(SR as usize / 2, 0.1));
        let flushed = chunker.flush();
        assert!(flushed.is_some());
        assert_eq!(flushed.unwrap().samples.len(), SR as usize / 2);
    }

    #[test]
    fn flush_after_flush_is_none_buffer_was_cleared() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        chunker.push(&samples(SR as usize, 0.1));
        assert!(chunker.flush().is_some());
        assert!(chunker.flush().is_none());
    }

    #[test]
    fn large_push_spanning_multiple_windows_drains_via_repeated_push() {
        let mut chunker = Chunker::new(8.0, 1.0, SR);
        // 16s in one call: should be able to drain two windows via a
        // follow-up push(&[]).
        let first = chunker.push(&samples(16 * SR as usize, 0.1));
        assert!(first.is_some());
        assert_eq!(first.unwrap().start_offset_secs, 0.0);

        let second = chunker.push(&[]);
        assert!(second.is_some());
        assert_eq!(second.unwrap().start_offset_secs, 7.0);
    }

    // --- dedupe_segments ------------------------------------------------------

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.to_string(),
        }
    }

    #[test]
    fn dedupe_drops_segment_fully_inside_already_emitted_overlap() {
        // Chunk starts at absolute 7s; a segment at chunk-relative 0.0-0.5s
        // (absolute 7.0-7.5s, midpoint 7.25s) is a re-transcription of
        // audio already emitted up through 8.0s from the previous window.
        let segments = vec![seg(0.0, 0.5, "the lazy")];
        let kept = dedupe_segments(&segments, 7.0, 8.0);
        assert!(kept.is_empty());
    }

    #[test]
    fn dedupe_keeps_fresh_segment_past_already_emitted() {
        // Chunk starts at absolute 7s; a segment at chunk-relative
        // 2.0-3.0s (absolute 9.0-10.0s, midpoint 9.5s) is past the
        // previously emitted 8.0s boundary.
        let segments = vec![seg(2.0, 3.0, "brand new words")];
        let kept = dedupe_segments(&segments, 7.0, 8.0);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].start, 9.0);
        assert_eq!(kept[0].end, 10.0);
        assert_eq!(kept[0].text, "brand new words");
    }

    #[test]
    fn dedupe_boundary_midpoint_exactly_equal_is_dropped() {
        // Chunk starts at 0s; segment 7.5-8.5s has midpoint exactly 8.0 —
        // exactly equal to already_emitted_until, so it must be dropped
        // (not kept) per the ">" (not ">=") rule.
        let segments = vec![seg(7.5, 8.5, "boundary")];
        let kept = dedupe_segments(&segments, 0.0, 8.0);
        assert!(kept.is_empty());
    }

    #[test]
    fn dedupe_converts_chunk_relative_to_absolute_time() {
        let segments = vec![seg(1.0, 2.0, "hello")];
        let kept = dedupe_segments(&segments, 14.0, 8.0);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].start, 15.0);
        assert_eq!(kept[0].end, 16.0);
    }

    #[test]
    fn dedupe_empty_input_returns_empty() {
        let kept = dedupe_segments(&[], 0.0, 0.0);
        assert!(kept.is_empty());
    }

    #[test]
    fn dedupe_first_chunk_with_zero_already_emitted_keeps_everything_after_zero() {
        let segments = vec![seg(0.0, 1.0, "first"), seg(1.0, 2.0, "second")];
        let kept = dedupe_segments(&segments, 0.0, 0.0);
        assert_eq!(kept.len(), 2);
    }

    // --- handle_window_segments ----------------------------------------------

    /// Builds a `WorkerCtx` over a fresh tempdir-backed `SharedStore` (with
    /// one note already created, so `append_segment`'s note directory
    /// exists) plus an `emit` closure that pushes every event into `events`
    /// for the test to inspect afterward. Returns `(ctx, events)` — kept as
    /// a `TestGuard`-style tuple rather than a struct since every caller
    /// destructures it immediately.
    fn test_ctx() -> (
        WorkerCtx,
        String,
        Arc<Mutex<Vec<SttEvent>>>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::open_shared(dir.path().to_path_buf());
        let note_id = lock_store(&store)
            .create_note_now("Test note", "whisper-small")
            .unwrap()
            .id;

        let events: Arc<Mutex<Vec<SttEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = events.clone();
        let ctx = WorkerCtx {
            note_id: note_id.clone(),
            store,
            emit: Box::new(move |event| events_for_emit.lock().unwrap().push(event)),
        };
        (ctx, note_id, events, dir)
    }

    fn stored_segments(ctx: &WorkerCtx) -> Vec<StoredSegment> {
        lock_store(&ctx.store)
            .get_note(&ctx.note_id)
            .unwrap()
            .1
            .segments
    }

    #[test]
    fn handle_window_segments_persists_and_emits_kept_segments_in_order() {
        let (ctx, note_id, events, _dir) = test_ctx();
        let mut emitted_until = 0.0f64;

        let raw = vec![seg(0.0, 1.0, "hello"), seg(1.0, 2.0, "world")];
        handle_window_segments(&raw, 0.0, &mut emitted_until, &ctx);

        assert_eq!(emitted_until, 2.0);

        let stored = stored_segments(&ctx);
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].text, "hello");
        assert_eq!(stored[0].speaker, SPEAKER_PLACEHOLDER);
        assert_eq!((stored[0].start, stored[0].end), (0.0, 1.0));
        assert_eq!(stored[1].text, "world");
        assert_eq!((stored[1].start, stored[1].end), (1.0, 2.0));

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        match &events[0] {
            SttEvent::TranscriptSegment(payload) => {
                assert_eq!(payload.note_id, note_id);
                assert_eq!(payload.speaker, SPEAKER_PLACEHOLDER);
                assert_eq!(payload.text, "hello");
                assert_eq!((payload.start, payload.end), (0.0, 1.0));
            }
            other => panic!("expected TranscriptSegment, got {other:?}"),
        }
        match &events[1] {
            SttEvent::TranscriptSegment(payload) => assert_eq!(payload.text, "world"),
            other => panic!("expected TranscriptSegment, got {other:?}"),
        }
    }

    #[test]
    fn handle_window_segments_drops_overlap_straddling_segment_persists_nothing() {
        let (ctx, _note_id, events, _dir) = test_ctx();
        // already_emitted_until = 8.0 (from a previous window); this
        // chunk starts at 7.0s, and its one segment (chunk-relative
        // 0.0-0.5s -> absolute 7.0-7.5s, midpoint 7.25s) falls inside the
        // already-emitted overlap region, so `dedupe_segments` drops it
        // whole (see its doc comment's "accepted loss mode") — this test
        // exercises that the drop propagates through as "nothing
        // persisted, nothing emitted, emitted_until unchanged"; the
        // corresponding `log::debug!` firing for the drop is exercised by
        // `dedupe_segments` directly and isn't independently asserted here
        // (no test-log-capture harness in this codebase).
        let mut emitted_until = 8.0f64;

        let raw = vec![seg(0.0, 0.5, "the lazy")];
        handle_window_segments(&raw, 7.0, &mut emitted_until, &ctx);

        assert_eq!(emitted_until, 8.0, "emitted_until must not move");
        assert!(stored_segments(&ctx).is_empty());
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn handle_window_segments_emitted_until_advances_to_max_kept_end_not_last_processed() {
        let (ctx, _note_id, _events, _dir) = test_ctx();
        // Very negative starting point so both segments are trivially
        // kept regardless of overlap logic.
        let mut emitted_until = -100.0f64;

        // Deliberately out of end-time order: the second (later-processed)
        // segment ends *before* the first one does, so naively taking
        // "the last processed segment's end" would wrongly leave
        // emitted_until at 2.0 instead of the true max, 5.0.
        let raw = vec![seg(0.0, 5.0, "A"), seg(1.0, 2.0, "B")];
        handle_window_segments(&raw, 0.0, &mut emitted_until, &ctx);

        assert_eq!(emitted_until, 5.0);
        assert_eq!(stored_segments(&ctx).len(), 2);
    }

    #[test]
    fn handle_window_segments_partial_overlap_drop_keeps_the_fresh_segment() {
        let (ctx, _note_id, _events, _dir) = test_ctx();
        let mut emitted_until = 8.0f64;

        // Chunk starts at 7.0s: first segment straddles the overlap and is
        // dropped (as above), second is past it and kept.
        let raw = vec![seg(0.0, 0.5, "dropped"), seg(2.0, 3.0, "brand new words")];
        handle_window_segments(&raw, 7.0, &mut emitted_until, &ctx);

        assert_eq!(emitted_until, 10.0);
        let stored = stored_segments(&ctx);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].text, "brand new words");
    }

    // --- e2e: real model, real audio (manual only) --------------------------

    /// Reads a 16-bit PCM mono WAV file into f32 samples in `[-1.0, 1.0]`
    /// (the same range `Recorder`'s pipeline produces).
    fn read_wav_as_f32(path: &Path) -> Vec<f32> {
        let mut reader = hound::WavReader::open(path).expect("failed to open wav fixture");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 16_000, "fixture must be 16 kHz");
        assert_eq!(spec.channels, 1, "fixture must be mono");
        reader
            .samples::<i16>()
            .map(|s| s.expect("failed to read wav sample") as f32 / i16::MAX as f32)
            .collect()
    }

    /// Requires `ggml-small.bin` to already be installed (downloaded in
    /// Task 4's network smoke test) at the real app-data models directory.
    /// Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     real_model_transcribes_speech -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn real_model_transcribes_speech() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let model_path = std::path::PathBuf::from(&home)
            .join("Library/Application Support/dev.minute.app/models/whisper/ggml-small.bin");
        assert!(
            model_path.exists(),
            "expected whisper-small model at {model_path:?} (run Task 4's \
             real_download_of_whisper_small test first)"
        );

        let fixture_path =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hello.wav");
        let samples = read_wav_as_f32(&fixture_path);
        eprintln!(
            "fixture: {:.2}s of audio ({} samples)",
            samples.len() as f64 / SR as f64,
            samples.len()
        );

        // Run through the Chunker too (per the task spec), even though this
        // short a clip fits in a single flushed window rather than a full
        // 8s push-triggered one.
        let mut chunker = Chunker::new(WINDOW_SECS, OVERLAP_SECS, TARGET_SAMPLE_RATE);
        let mut windows = Vec::new();
        if let Some(w) = chunker.push(&samples) {
            windows.push(w);
        }
        if let Some(w) = chunker.flush() {
            windows.push(w);
        }
        assert!(!windows.is_empty(), "expected at least one window");

        let start = Instant::now();
        let mut full_transcript = String::new();
        for window in &windows {
            let segments =
                transcribe_samples(&model_path, &window.samples).expect("transcription failed");
            for seg in &segments {
                full_transcript.push_str(&seg.text);
                full_transcript.push(' ');
            }
        }
        let elapsed = start.elapsed();
        let audio_secs = samples.len() as f64 / SR as f64;
        let realtime_factor = audio_secs / elapsed.as_secs_f64();

        eprintln!("transcript: {full_transcript:?}");
        eprintln!(
            "transcribed {audio_secs:.2}s of audio in {elapsed:?} (realtime factor {realtime_factor:.2}x)"
        );

        assert!(!full_transcript.trim().is_empty(), "transcript was empty");
        assert!(
            full_transcript.to_lowercase().contains("fox"),
            "expected transcript to contain \"fox\", got: {full_transcript:?}"
        );
    }
}
