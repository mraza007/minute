//! Mic capture, downmix/resample to 16 kHz mono, and incremental WAV writing.
//!
//! Pure, unit-tested building blocks ([`downmix_to_mono`], [`LinearResampler`],
//! [`WavWriter`], [`ElapsedTracker`]) are factored out from the hardware-facing
//! [`Recorder`]/[`RecorderHandle`] pair the same way `download.rs` separates
//! its pure filesystem/throttling helpers from `execute_download`'s real
//! network I/O — see that module's header comment for the rationale.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample as _;
use tauri::{AppHandle, Emitter, State};

use crate::error::{MinuteError, Result};
use crate::store::{lock_store, NoteMeta, SharedStore};

/// Target sample rate every note's `audio.wav` (and the STT sample stream)
/// is normalized to, regardless of the input device's native rate.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

// ---------------------------------------------------------------------------
// downmix_to_mono
// ---------------------------------------------------------------------------

/// Averages interleaved multi-channel samples down to a single mono channel.
/// `channels <= 1` is treated as already-mono and returned as-is. A trailing
/// partial frame (`samples.len()` not a multiple of `channels` — shouldn't
/// happen from a real cpal callback, but cheap to handle) is averaged over
/// however many samples it actually has rather than dropped or panicking.
pub fn downmix_to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return samples.to_vec();
    }
    samples
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

// ---------------------------------------------------------------------------
// LinearResampler
// ---------------------------------------------------------------------------

/// Streaming linear-interpolation resampler from `from_hz` to `to_hz`.
///
/// Carries its fractional input position (and the last sample of the
/// previous call) across calls to `resample`, so feeding a signal through in
/// several chunks produces the same output as feeding it through in one
/// shot — see the chunked-vs-one-shot equivalence test below for the
/// contract this is built to satisfy.
pub struct LinearResampler {
    from_hz: u32,
    to_hz: u32,
    /// Position of the next output sample, in input-sample index units,
    /// relative to the start of the *next* `resample` call's slice. `-1.0`
    /// would mean "exactly at the last sample of the previous chunk";
    /// `0.0` means "exactly at the first sample of the next chunk". Always
    /// `>= -1.0` between calls.
    pos: f64,
    /// The last sample of the most recently processed chunk, used as the
    /// virtual "index -1" sample so interpolation can span a chunk
    /// boundary. Unused (and irrelevant) until `pos` first goes negative.
    last_sample: f32,
}

impl LinearResampler {
    pub fn new(from_hz: u32, to_hz: u32) -> Self {
        Self {
            from_hz,
            to_hz,
            pos: 0.0,
            last_sample: 0.0,
        }
    }

    /// Resamples `mono` and returns the newly produced output samples.
    /// Safe to call repeatedly with successive chunks of one continuous
    /// stream; each call's leftover fractional position carries into the
    /// next.
    pub fn resample(&mut self, mono: &[f32]) -> Vec<f32> {
        let n = mono.len();
        if n == 0 || self.from_hz == 0 || self.to_hz == 0 {
            return Vec::new();
        }

        let ratio = self.from_hz as f64 / self.to_hz as f64;
        let mut out = Vec::new();
        let mut pos = self.pos;

        loop {
            let idx = pos.floor();
            let idx_i = idx as i64;
            if idx_i + 1 >= n as i64 {
                break;
            }
            let frac = (pos - idx) as f32;
            let a = if idx_i < 0 {
                self.last_sample
            } else {
                mono[idx_i as usize]
            };
            let b = mono[(idx_i + 1) as usize];
            out.push(a + (b - a) * frac);
            pos += ratio;
        }

        self.pos = pos - n as f64;
        self.last_sample = mono[n - 1];
        out
    }
}

// ---------------------------------------------------------------------------
// WavWriter
// ---------------------------------------------------------------------------

/// Incremental 16 kHz mono 16-bit PCM WAV writer, wrapping `hound`.
pub struct WavWriter {
    inner: Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>,
    total_samples: u64,
}

impl WavWriter {
    /// Creates a new WAV file at `path` with a fixed 16 kHz / mono / 16-bit
    /// PCM header — the format every note's `audio.wav` is stored in,
    /// independent of the input device's native format.
    pub fn create(path: &Path) -> Result<Self> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: TARGET_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let inner = hound::WavWriter::create(path, spec)
            .map_err(|e| MinuteError::Other(format!("failed to create wav file: {e}")))?;
        Ok(Self {
            inner: Some(inner),
            total_samples: 0,
        })
    }

    /// Clamps each sample to `[-1.0, 1.0]` and appends it as 16-bit PCM.
    pub fn append(&mut self, samples_f32: &[f32]) -> Result<()> {
        let writer = self
            .inner
            .as_mut()
            .ok_or_else(|| MinuteError::Other("append called after finalize".to_string()))?;
        for &sample in samples_f32 {
            let clamped = sample.clamp(-1.0, 1.0);
            let quantized = (clamped * i16::MAX as f32).round() as i16;
            writer
                .write_sample(quantized)
                .map_err(|e| MinuteError::Other(format!("failed to write wav sample: {e}")))?;
        }
        self.total_samples += samples_f32.len() as u64;
        Ok(())
    }

    /// Flushes and closes the file, returning the total number of samples
    /// written.
    pub fn finalize(mut self) -> Result<u64> {
        let writer = self
            .inner
            .take()
            .ok_or_else(|| MinuteError::Other("finalize called twice".to_string()))?;
        writer
            .finalize()
            .map_err(|e| MinuteError::Other(format!("failed to finalize wav file: {e}")))?;
        Ok(self.total_samples)
    }
}

// ---------------------------------------------------------------------------
// ElapsedTracker
// ---------------------------------------------------------------------------

/// Tracks wall-clock elapsed time excluding paused spans. Every method
/// takes `now: Instant` explicitly (rather than reading a system clock
/// itself) so its accounting is unit-testable with synthetic timestamps —
/// same shape as `download::ProgressThrottle`.
pub struct ElapsedTracker {
    started_at: Option<Instant>,
    /// Total duration of all *completed* pause spans.
    paused_total: Duration,
    /// Start of the current in-flight pause span, if paused right now.
    paused_since: Option<Instant>,
}

impl ElapsedTracker {
    pub fn new() -> Self {
        Self {
            started_at: None,
            paused_total: Duration::ZERO,
            paused_since: None,
        }
    }

    /// (Re)starts the tracker at `now`, resetting any prior accounting.
    pub fn start(&mut self, now: Instant) {
        self.started_at = Some(now);
        self.paused_total = Duration::ZERO;
        self.paused_since = None;
    }

    /// Begins a pause span at `now`. Idempotent — a second `pause()` call
    /// while already paused doesn't reset the span's start time.
    pub fn pause(&mut self, now: Instant) {
        if self.paused_since.is_none() {
            self.paused_since = Some(now);
        }
    }

    /// Ends the current pause span at `now`, folding it into the total
    /// paused duration. A no-op if not currently paused.
    pub fn resume(&mut self, now: Instant) {
        if let Some(paused_at) = self.paused_since.take() {
            self.paused_total += now.saturating_duration_since(paused_at);
        }
    }

    /// Milliseconds elapsed since `start`, excluding every paused span
    /// (completed ones, plus the in-flight one if still paused at `now`).
    /// `0` if never started.
    pub fn elapsed_ms(&self, now: Instant) -> u64 {
        let Some(started_at) = self.started_at else {
            return 0;
        };
        let total = now.saturating_duration_since(started_at);
        let in_flight_pause = self
            .paused_since
            .map(|paused_at| now.saturating_duration_since(paused_at))
            .unwrap_or(Duration::ZERO);
        let paused = self.paused_total + in_flight_pause;
        total.saturating_sub(paused).as_millis() as u64
    }
}

impl Default for ElapsedTracker {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Recorder / RecorderHandle (hardware — thin, not unit-tested)
// ---------------------------------------------------------------------------

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// State shared between the cpal audio callback (running on cpal's own
/// realtime thread) and the control-plane `RecorderHandle` (driven from
/// Tauri commands).
struct SharedState {
    wav_writer: Mutex<Option<WavWriter>>,
    tracker: Mutex<ElapsedTracker>,
    paused: AtomicBool,
    /// cpal's data/error callbacks can't return a `Result` — errors raised
    /// from inside them (a write failure, a device error) are stashed here
    /// (and `log::warn!`'d at the call site) instead, for a caller to
    /// surface later via `RecorderHandle::last_error`.
    last_error: Mutex<Option<String>>,
}

/// Builds a cpal input stream over sample type `T`, wiring its data
/// callback to: skip entirely while paused, else downmix -> resample ->
/// (a) forward the chunk to `sample_tx` (Task 6's `SttWorker` consumes
/// this; until then the channel just queues, see `ActiveRecording`) and
/// (b) append it to the shared WAV writer.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    shared: Arc<SharedState>,
    sample_tx: Sender<Vec<f32>>,
    mut resampler: LinearResampler,
) -> Result<cpal::Stream>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let err_shared = shared.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if shared.paused.load(Ordering::Relaxed) {
                    return;
                }
                let floats: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
                let mono = downmix_to_mono(&floats, channels);
                let resampled = resampler.resample(&mono);
                if resampled.is_empty() {
                    return;
                }
                // Receiver is held (unused) in `ActiveRecording` until Task
                // 6 wires the STT worker to drain it — `send` never fails
                // from a dropped receiver in the meantime.
                let _ = sample_tx.send(resampled.clone());
                if let Some(writer) = lock(&shared.wav_writer).as_mut() {
                    if let Err(e) = writer.append(&resampled) {
                        log::warn!("failed to append recorded samples to wav: {e}");
                        *lock(&shared.last_error) = Some(e.to_string());
                    }
                }
            },
            move |err| {
                log::warn!("cpal input stream error: {err}");
                *lock(&err_shared.last_error) = Some(err.to_string());
            },
            None,
        )
        .map_err(|e| MinuteError::Other(format!("failed to build input stream: {e}")))
}

/// Factory namespace for starting a recording — see [`Recorder::start`].
/// (Zero-sized; the returned [`RecorderHandle`] is the actual owner of the
/// cpal stream and recording state.)
pub struct Recorder;

/// A live recording in progress: owns the cpal stream (kept alive for as
/// long as this handle lives) and exposes pause/resume/stop.
pub struct RecorderHandle {
    stream: cpal::Stream,
    shared: Arc<SharedState>,
    wav_path: PathBuf,
}

impl Recorder {
    /// Opens the default input device, starts capturing at its native
    /// rate/format, and writes into `note_dir/audio.wav` (16 kHz mono
    /// 16-bit PCM, resampled from whatever the device provides). Each
    /// downmixed+resampled chunk is also cloned onto `sample_tx` for Task
    /// 6's live transcription worker.
    pub fn start(note_dir: PathBuf, sample_tx: Sender<Vec<f32>>) -> Result<RecorderHandle> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| MinuteError::Other("no input device available".to_string()))?;
        let supported = device
            .default_input_config()
            .map_err(|e| MinuteError::Other(format!("no default input config: {e}")))?;
        let sample_format = supported.sample_format();
        let channels = supported.channels();
        let from_hz = supported.sample_rate();
        let config: cpal::StreamConfig = supported.into();

        std::fs::create_dir_all(&note_dir)?;
        let wav_path = note_dir.join("audio.wav");
        let wav_writer = WavWriter::create(&wav_path)?;

        let shared = Arc::new(SharedState {
            wav_writer: Mutex::new(Some(wav_writer)),
            tracker: Mutex::new(ElapsedTracker::new()),
            paused: AtomicBool::new(false),
            last_error: Mutex::new(None),
        });
        lock(&shared.tracker).start(Instant::now());

        let resampler = LinearResampler::new(from_hz, TARGET_SAMPLE_RATE);

        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_stream::<f32>(
                &device,
                &config,
                channels,
                shared.clone(),
                sample_tx,
                resampler,
            )?,
            cpal::SampleFormat::I16 => build_stream::<i16>(
                &device,
                &config,
                channels,
                shared.clone(),
                sample_tx,
                resampler,
            )?,
            cpal::SampleFormat::U16 => build_stream::<u16>(
                &device,
                &config,
                channels,
                shared.clone(),
                sample_tx,
                resampler,
            )?,
            other => {
                return Err(MinuteError::Other(format!(
                    "unsupported input sample format: {other:?}"
                )))
            }
        };

        stream
            .play()
            .map_err(|e| MinuteError::Other(format!("failed to start input stream: {e}")))?;

        Ok(RecorderHandle {
            stream,
            shared,
            wav_path,
        })
    }
}

impl RecorderHandle {
    /// Pauses capture: the audio callback starts dropping incoming samples
    /// (stream stays alive/open) and the elapsed-time tracker stops
    /// counting from this instant.
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::SeqCst);
        lock(&self.shared.tracker).pause(Instant::now());
    }

    /// Resumes capture after a `pause()`.
    pub fn resume(&self) {
        self.shared.paused.store(false, Ordering::SeqCst);
        lock(&self.shared.tracker).resume(Instant::now());
    }

    /// Current elapsed recording time (excluding paused spans), in
    /// milliseconds.
    pub fn elapsed_ms(&self) -> u64 {
        lock(&self.shared.tracker).elapsed_ms(Instant::now())
    }

    /// The most recent stream/write error observed by the audio callback,
    /// if any (see `SharedState::last_error`).
    pub fn last_error(&self) -> Option<String> {
        lock(&self.shared.last_error).clone()
    }

    /// Stops capture and finalizes the WAV file. Drops the cpal stream
    /// first, so the audio callback is guaranteed to never fire again
    /// before the WAV writer underneath it is finalized.
    pub fn stop(self) -> Result<(f64, PathBuf)> {
        drop(self.stream);

        let elapsed_ms = lock(&self.shared.tracker).elapsed_ms(Instant::now());

        let writer = lock(&self.shared.wav_writer)
            .take()
            .ok_or_else(|| MinuteError::Other("recorder already finalized".to_string()))?;
        writer.finalize()?;

        Ok((elapsed_ms as f64 / 1000.0, self.wav_path))
    }
}

// ---------------------------------------------------------------------------
// RecorderState (managed) + Tauri commands
// ---------------------------------------------------------------------------

/// The one active recording, if any — held in [`SharedRecorderState`].
struct ActiveRecording {
    note_id: String,
    handle: RecorderHandle,
    /// Held so `sample_tx.send` in the audio callback never fails; drained
    /// by Task 6's `SttWorker` (not yet wired). Never read here.
    #[allow(dead_code)]
    sample_rx: Receiver<Vec<f32>>,
    /// The 1s `recording-state` ticker spawned in `start_recording`,
    /// aborted in `stop_recording`.
    tick_handle: tokio::task::JoinHandle<()>,
}

/// Managed state: at most one active recording at a time.
///
/// Private constructor + a `pub(crate)` factory returning the shared handle
/// — same shape as `store::Store`/`store::open_shared`.
pub struct RecorderState {
    active: Option<ActiveRecording>,
}

/// Shared handle to a [`RecorderState`] — see the module docs on
/// `store::SharedStore` for the general pattern this mirrors.
pub type SharedRecorderState = Arc<Mutex<RecorderState>>;

/// Creates an empty, ready-to-`app.manage()` recorder state.
pub(crate) fn open_shared() -> SharedRecorderState {
    Arc::new(Mutex::new(RecorderState { active: None }))
}

fn lock_recorder_state(state: &SharedRecorderState) -> MutexGuard<'_, RecorderState> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStateEvent {
    note_id: String,
    state: &'static str,
    elapsed: f64,
}

fn emit_recording_state(app: &AppHandle, note_id: &str, state: &'static str, elapsed_secs: f64) {
    let event = RecordingStateEvent {
        note_id: note_id.to_string(),
        state,
        elapsed: elapsed_secs,
    };
    if let Err(e) = app.emit("recording-state", event) {
        log::warn!("failed to emit recording-state for {note_id}: {e}");
    }
}

/// Starts a new recording: creates a note via the store (title "New
/// recording", hardcoded model id until Task 8 wires real settings),
/// starts the `Recorder` writing into that note's `audio.wav`, and spawns
/// the 1s ticker that keeps emitting `recording-state` while active.
/// Returns the new note's id.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    store: State<'_, SharedStore>,
    recorder: State<'_, SharedRecorderState>,
) -> std::result::Result<String, String> {
    if lock_recorder_state(&recorder).active.is_some() {
        return Err("a recording is already in progress".to_string());
    }

    // TODO(task8): use the user's selected STT model id once settings.json
    // exists. Hardcoded for now.
    let model_id = "whisper-small";
    let meta = lock_store(&store)
        .create_note_now("New recording", model_id)
        .map_err(|e| e.to_string())?;
    let note_dir = lock_store(&store).note_dir(&meta.id);

    let (sample_tx, sample_rx) = std::sync::mpsc::channel();
    let handle = Recorder::start(note_dir, sample_tx).map_err(|e| e.to_string())?;

    let note_id = meta.id.clone();
    let tick_app = app.clone();
    let tick_note_id = note_id.clone();
    let tick_shared = handle.shared.clone();
    let tick_handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        // The first tick fires immediately; skip it so it doesn't race the
        // `emit_recording_state` call already made below for the initial
        // "recording" state.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let paused = tick_shared.paused.load(Ordering::SeqCst);
            let elapsed_ms = lock(&tick_shared.tracker).elapsed_ms(Instant::now());
            let state = if paused { "paused" } else { "recording" };
            emit_recording_state(&tick_app, &tick_note_id, state, elapsed_ms as f64 / 1000.0);
        }
    });

    lock_recorder_state(&recorder).active = Some(ActiveRecording {
        note_id: note_id.clone(),
        handle,
        sample_rx,
        tick_handle,
    });

    emit_recording_state(&app, &note_id, "recording", 0.0);
    Ok(note_id)
}

/// Pauses the active recording. Errors if none is active.
#[tauri::command]
pub fn pause_recording(
    app: AppHandle,
    recorder: State<SharedRecorderState>,
) -> std::result::Result<(), String> {
    let guard = lock_recorder_state(&recorder);
    let active = guard
        .active
        .as_ref()
        .ok_or_else(|| "no active recording".to_string())?;
    active.handle.pause();
    let note_id = active.note_id.clone();
    let elapsed_secs = active.handle.elapsed_ms() as f64 / 1000.0;
    drop(guard);
    emit_recording_state(&app, &note_id, "paused", elapsed_secs);
    Ok(())
}

/// Resumes the active (paused) recording. Errors if none is active.
#[tauri::command]
pub fn resume_recording(
    app: AppHandle,
    recorder: State<SharedRecorderState>,
) -> std::result::Result<(), String> {
    let guard = lock_recorder_state(&recorder);
    let active = guard
        .active
        .as_ref()
        .ok_or_else(|| "no active recording".to_string())?;
    active.handle.resume();
    let note_id = active.note_id.clone();
    let elapsed_secs = active.handle.elapsed_ms() as f64 / 1000.0;
    drop(guard);
    emit_recording_state(&app, &note_id, "recording", elapsed_secs);
    Ok(())
}

/// Stops the active recording: aborts the ticker, stops the `Recorder`
/// (finalizing the WAV file), finalizes the note in the store (status
/// `transcribed`, speakers 1 — Task 6 revisits status; diarization is out
/// of scope for Stage 2), and emits a final `stopped` `recording-state`.
/// Errors if none is active.
#[tauri::command]
pub fn stop_recording(
    app: AppHandle,
    store: State<SharedStore>,
    recorder: State<SharedRecorderState>,
) -> std::result::Result<NoteMeta, String> {
    let active = lock_recorder_state(&recorder)
        .active
        .take()
        .ok_or_else(|| "no active recording".to_string())?;

    active.tick_handle.abort();

    if let Some(err) = active.handle.last_error() {
        log::warn!(
            "recording {} encountered a stream error before stopping: {err}",
            active.note_id
        );
    }

    let note_id = active.note_id;
    let (duration_sec, _wav_path) = active.handle.stop().map_err(|e| e.to_string())?;

    let meta = lock_store(&store)
        .finalize_note(&note_id, duration_sec, 1)
        .map_err(|e| e.to_string())?;

    emit_recording_state(&app, &note_id, "stopped", duration_sec);
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- downmix_to_mono -----------------------------------------------

    #[test]
    fn downmix_stereo_averages_known_values() {
        // Left/right pairs: (1, 3) -> 2, (2, 4) -> 3.
        let samples = [1.0, 3.0, 2.0, 4.0];
        let mono = downmix_to_mono(&samples, 2);
        assert_eq!(mono, vec![2.0, 3.0]);
    }

    #[test]
    fn downmix_mono_is_passthrough() {
        let samples = [0.1, 0.2, -0.3, 0.5];
        let mono = downmix_to_mono(&samples, 1);
        assert_eq!(mono, samples.to_vec());
    }

    #[test]
    fn downmix_three_channel_averages_each_frame() {
        let samples = [3.0, 6.0, 9.0, 1.0, 2.0, 3.0];
        let mono = downmix_to_mono(&samples, 3);
        assert_eq!(mono, vec![6.0, 2.0]);
    }

    #[test]
    fn downmix_zero_channels_treated_as_mono() {
        let samples = [0.5, -0.5];
        let mono = downmix_to_mono(&samples, 0);
        assert_eq!(mono, samples.to_vec());
    }

    // --- LinearResampler --------------------------------------------------

    #[test]
    fn resample_48k_to_16k_length_ratio_one_shot() {
        let mut resampler = LinearResampler::new(48_000, 16_000);
        let input = vec![0.0f32; 48_000];
        let output = resampler.resample(&input);
        // Ratio 3:1 -> ~16000 output samples.
        let expected = 16_000i64;
        assert!(
            (output.len() as i64 - expected).abs() <= 2,
            "expected ~{expected} samples, got {}",
            output.len()
        );
    }

    #[test]
    fn resample_48k_to_16k_length_ratio_chunked_matches_one_shot_within_tolerance() {
        let total = 48_000usize;
        let input = vec![0.0f32; total];

        let mut one_shot = LinearResampler::new(48_000, 16_000);
        let one_shot_out = one_shot.resample(&input);

        let mut chunked = LinearResampler::new(48_000, 16_000);
        let mut chunked_len = 0usize;
        for chunk in input.chunks(4_001) {
            chunked_len += chunked.resample(chunk).len();
        }

        assert!(
            (chunked_len as i64 - one_shot_out.len() as i64).abs() <= 2,
            "chunked len {chunked_len} vs one-shot len {}",
            one_shot_out.len()
        );
    }

    #[test]
    fn resample_sine_wave_no_nan_and_amplitude_preserved() {
        let from_hz = 48_000.0f64;
        let freq = 440.0f64;
        let n = 48_000usize;
        let input: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f64::consts::PI * freq * (i as f64) / from_hz).sin() as f32)
            .collect();

        let mut resampler = LinearResampler::new(48_000, 16_000);
        let output = resampler.resample(&input);

        assert!(output.iter().all(|s| !s.is_nan()));
        let peak = output.iter().fold(0.0f32, |acc, &s| acc.max(s.abs()));
        assert!(
            (0.95..=1.05).contains(&peak),
            "expected peak near 1.0, got {peak}"
        );
    }

    #[test]
    fn resample_chunked_vs_one_shot_exact_for_uneven_chunks() {
        let n = 10_000usize;
        let input: Vec<f32> = (0..n)
            .map(|i| ((i as f32) * 0.001).sin())
            .collect();

        let mut one_shot = LinearResampler::new(44_100, 16_000);
        let one_shot_out = one_shot.resample(&input);

        let mut chunked = LinearResampler::new(44_100, 16_000);
        let mut chunked_out = Vec::new();
        for chunk in input.chunks(3_333) {
            chunked_out.extend(chunked.resample(chunk));
        }

        assert_eq!(
            chunked_out.len(),
            one_shot_out.len(),
            "chunked and one-shot output lengths differ"
        );
        for (a, b) in chunked_out.iter().zip(one_shot_out.iter()) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
    }

    #[test]
    fn resample_identity_when_rates_match() {
        // With matching rates every emitted sample is a frac=0 direct copy
        // of its input sample. A single one-shot call always holds back the
        // final input sample (it's needed as the upper interpolation bound
        // for a would-be next chunk, per the streaming contract) — feeding
        // one extra trailing sample through a second call flushes it, which
        // is what a real cpal callback stream naturally does.
        let mut resampler = LinearResampler::new(16_000, 16_000);
        let input = vec![0.1, 0.2, 0.3, -0.4, 0.5];
        let output = resampler.resample(&input);
        assert_eq!(output.len(), input.len() - 1);
        for (a, b) in output.iter().zip(input.iter()) {
            assert!((a - b).abs() < 1e-6);
        }

        let flush = resampler.resample(&[0.5]);
        assert_eq!(flush, vec![0.5]);
    }

    // --- WavWriter ----------------------------------------------------------

    #[test]
    fn wav_writer_round_trips_ramp_within_one_lsb() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");

        let mut writer = WavWriter::create(&path).unwrap();
        let ramp: Vec<f32> = (0..1000)
            .map(|i| -1.0 + 2.0 * (i as f32) / 999.0)
            .collect();
        writer.append(&ramp).unwrap();
        let total = writer.finalize().unwrap();
        assert_eq!(total, ramp.len() as u64);

        let mut reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.bits_per_sample, 16);

        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(samples.len(), ramp.len());
        for (input, got) in ramp.iter().zip(samples.iter()) {
            let expected = (input.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            assert!(
                (*got as i32 - expected as i32).abs() <= 1,
                "expected {expected}, got {got}"
            );
        }
    }

    #[test]
    fn wav_writer_clamps_out_of_range_samples() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");

        let mut writer = WavWriter::create(&path).unwrap();
        writer.append(&[2.0, -2.0, 0.0]).unwrap();
        writer.finalize().unwrap();

        let mut reader = hound::WavReader::open(&path).unwrap();
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(samples, vec![i16::MAX, -i16::MAX, 0]);
    }

    #[test]
    fn wav_writer_append_after_finalize_is_impossible_at_compile_time() {
        // `finalize` takes `self` by value, so the type system itself
        // prevents calling `append` afterward — nothing to assert at
        // runtime; this test documents the guarantee.
    }

    // --- ElapsedTracker -------------------------------------------------------

    #[test]
    fn elapsed_tracker_start_plus_1000ms() {
        let base = Instant::now();
        let mut tracker = ElapsedTracker::new();
        tracker.start(base);
        assert_eq!(tracker.elapsed_ms(base + Duration::from_millis(1000)), 1000);
    }

    #[test]
    fn elapsed_tracker_pause_and_resume_excludes_paused_span() {
        let base = Instant::now();
        let mut tracker = ElapsedTracker::new();
        tracker.start(base);

        // Recording runs to +1000ms, then pauses.
        tracker.pause(base + Duration::from_millis(1000));
        // Paused for 500ms, then resumes.
        tracker.resume(base + Duration::from_millis(1500));
        // Runs another 250ms.
        let now = base + Duration::from_millis(1750);

        assert_eq!(tracker.elapsed_ms(now), 1250);
    }

    #[test]
    fn elapsed_tracker_double_pause_is_idempotent() {
        let base = Instant::now();
        let mut tracker = ElapsedTracker::new();
        tracker.start(base);

        tracker.pause(base + Duration::from_millis(1000));
        // A second pause() call shortly after must not reset the pause
        // span's start time.
        tracker.pause(base + Duration::from_millis(1200));
        tracker.resume(base + Duration::from_millis(1500));

        // Paused span should be measured from 1000ms (first pause), i.e.
        // 500ms paused, not from 1200ms (300ms paused).
        let now = base + Duration::from_millis(1500);
        assert_eq!(tracker.elapsed_ms(now), 1000);
    }

    #[test]
    fn elapsed_tracker_still_paused_excludes_ongoing_pause_at_query_time() {
        let base = Instant::now();
        let mut tracker = ElapsedTracker::new();
        tracker.start(base);
        tracker.pause(base + Duration::from_millis(1000));

        // Query while still paused, 300ms into the pause.
        let now = base + Duration::from_millis(1300);
        assert_eq!(tracker.elapsed_ms(now), 1000);
    }

    #[test]
    fn elapsed_tracker_never_started_reports_zero() {
        let tracker = ElapsedTracker::new();
        assert_eq!(tracker.elapsed_ms(Instant::now()), 0);
    }
}
