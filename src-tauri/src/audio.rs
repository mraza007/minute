//! Mic capture, downmix/resample to 16 kHz mono, and incremental WAV writing.
//!
//! Pure, unit-tested building blocks ([`downmix_to_mono`], [`LinearResampler`],
//! [`WavWriter`], [`ElapsedTracker`]) are factored out from the hardware-facing
//! [`Recorder`]/[`RecorderHandle`] pair the same way `download.rs` separates
//! its pure filesystem/throttling helpers from `execute_download`'s real
//! network I/O — see that module's header comment for the rationale.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample as _;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::catalog::{self, InstallState};
use crate::error::{MinuteError, Result};
use crate::store::{lock_store, NoteMeta, SharedStore};
use crate::stt::{self, SttEvent, SttStatusPayload, SttStatusState, WorkerCtx};

/// Size (in samples, at [`TARGET_SAMPLE_RATE`]) of each block the writer
/// thread batches downmixed/resampled audio into before forwarding it to
/// the `SttWorker` — ~0.5s. cpal delivers callbacks in ~10-20ms bursts;
/// forwarding those raw makes each channel slot worth only ~10-20ms of
/// audio, so a channel sized in "slots" alone buys almost no real time
/// headroom no matter how large its capacity. Batching into ~0.5s blocks
/// first means [`STT_CHANNEL_CAPACITY`] slots are worth ~0.5s each instead.
const STT_BLOCK_SAMPLES: usize = 8_000;

/// Capacity of the bounded channel forwarding ~0.5s audio blocks from the
/// writer thread to the `SttWorker` — see `run_writer_thread`'s docs for
/// why this is bounded (unlike the cpal callback -> writer thread channel,
/// which stays unbounded). At `STT_BLOCK_SAMPLES` per slot, 256 slots is
/// ~128s of buffered audio headroom (a few MB of `Arc`'d `f32`s) —
/// comfortably absorbing the `SttWorker`'s one-time model load (1-3s) and
/// steady-state per-window inference (roughly 1-2s per 8s window on
/// typical Apple Silicon, per the e2e test's measured realtime factor).
/// Drops only kick in under a *sustained* slower-than-realtime stretch,
/// which is the designed degradation: gaps in the live transcript rather
/// than a stalled recording.
const STT_CHANNEL_CAPACITY: usize = 256;

/// Log a warning every this many consecutive dropped STT blocks, rather
/// than once per drop (which could spam the log heavily during a sustained
/// slow patch) or only once ever (which would hide an ongoing problem).
const STT_DROP_LOG_INTERVAL: u64 = 50;

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
///
/// Note: the `channels <= 1` branch still heap-allocates a full copy via
/// `to_vec()` rather than returning a zero-copy `Cow::Borrowed` — kept this
/// way so the signature stays the simple, directly-tested `-> Vec<f32>`
/// rather than threading a `Cow` (and its lifetime) through every call site
/// and test assertion. Not a real hot-path concern in practice: the
/// audio-callback caller immediately feeds this into `LinearResampler::
/// resample`, which always allocates its own fresh `Vec` right afterward
/// regardless, so this copy is one of several unavoidable per-callback
/// allocations rather than an isolated one worth complicating the API for.
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
/// realtime thread), the dedicated writer thread, and the control-plane
/// `RecorderHandle` (driven from Tauri commands).
///
/// Deliberately holds no `WavWriter` — the writer thread owns that
/// exclusively (see `run_writer_thread`), so the realtime audio callback
/// never touches a mutex guarding filesystem state.
struct SharedState {
    tracker: Mutex<ElapsedTracker>,
    paused: AtomicBool,
    /// cpal's data/error callbacks can't return a `Result` — errors raised
    /// from inside them (a device error) are stashed here (and
    /// `log::warn!`'d at the call site) instead, for a caller to surface
    /// later via `RecorderHandle::last_error`. The writer thread also
    /// stashes its own append/finalize errors here for the same reason.
    last_error: Mutex<Option<String>>,
}

/// Builds a cpal input stream over sample type `T`. Its data callback is
/// realtime-safe: skip entirely while paused, else convert -> downmix ->
/// resample -> send the chunk (wrapped once in an `Arc` so it can be
/// shared with the STT path without copying) into `writer_tx`. No locks
/// beyond the `paused` atomic, no filesystem I/O, no unbounded blocking —
/// `run_writer_thread` on a dedicated OS thread owns the WAV file and does
/// all of that off this thread.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    shared: Arc<SharedState>,
    writer_tx: Sender<Arc<Vec<f32>>>,
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
                // `writer_tx`'s only reader is the writer thread's plain
                // `mpsc::Receiver` (unbounded) — this never blocks. It's
                // dropped (ending the writer thread's loop) when `stream`
                // is dropped in `RecorderHandle::stop`.
                let _ = writer_tx.send(Arc::new(resampled));
            },
            move |err| {
                log::warn!("cpal input stream error: {err}");
                *lock(&err_shared.last_error) = Some(err.to_string());
            },
            None,
        )
        .map_err(|e| MinuteError::Other(format!("failed to build input stream: {e}")))
}

/// Tries to forward one accumulated audio block to the `SttWorker` via
/// `stt_tx`. Bounded + `try_send` rather than `send`: a slow or stalled
/// `SttWorker` (e.g. still loading the model, or a burst of inference on a
/// slower machine) must never make recording/WAV-writing block on it — the
/// recording is the thing that must never stall. When the channel is full
/// (the worker has fallen behind by more than `STT_CHANNEL_CAPACITY`'s
/// ~128s of headroom — a sustained slower-than-realtime stretch, not a
/// momentary blip), the block is dropped (the transcript gets a gap; the
/// WAV file is unaffected, since `writer.append` already ran before this is
/// called) and a running drop counter is logged every `STT_DROP_LOG_INTERVAL`
/// drops rather than on every single one. A `Disconnected` error (no
/// `SttWorker` running at all — e.g. the model wasn't installed, so
/// `start_recording` never spawned one) is silently ignored.
fn try_send_stt_block(stt_tx: &SyncSender<Arc<Vec<f32>>>, block: Vec<f32>, dropped: &mut u64) {
    match stt_tx.try_send(Arc::new(block)) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            *dropped += 1;
            if *dropped % STT_DROP_LOG_INTERVAL == 0 {
                let approx_secs =
                    *dropped as f64 * (STT_BLOCK_SAMPLES as f64 / TARGET_SAMPLE_RATE as f64);
                log::warn!(
                    "stt channel full — dropped {dropped} ~0.5s audio blocks so far \
                     (~{approx_secs:.1}s of audio; transcript will have gaps; recording/wav \
                     continue unaffected)"
                );
            }
        }
        Err(TrySendError::Disconnected(_)) => {}
    }
}

/// Drains `chunk_rx`, appending each chunk to `writer` immediately (so WAV
/// durability never depends on the STT side), while separately batching
/// the same samples into `STT_BLOCK_SAMPLES`-sized (~0.5s) blocks and
/// forwarding *those* — via [`try_send_stt_block`] — to the `SttWorker`.
/// Runs on a dedicated OS thread spawned from `Recorder::start`, so this —
/// not the realtime cpal callback — is where WAV file I/O actually happens.
///
/// Batching matters for the channel's real buffering headroom: see
/// `STT_BLOCK_SAMPLES`/`STT_CHANNEL_CAPACITY`'s docs. cpal's own chunk
/// boundaries (`chunk_rx`'s items) are irrelevant to the STT side beyond
/// being the unit samples arrive in — a block can span many cpal chunks.
///
/// Returns once `chunk_rx`'s sender (owned by the audio callback) is
/// dropped and every already-queued chunk has been drained — at which
/// point it flushes whatever's left of a partial (not-yet-`STT_BLOCK_SAMPLES`)
/// trailing block (so audio recorded right up to `stop_recording` isn't
/// silently lost off the end) and finalizes and closes the WAV file.
///
/// A free function (rather than a method) so it's unit-testable by feeding
/// it a channel directly, without a real cpal device.
fn run_writer_thread(
    mut writer: WavWriter,
    chunk_rx: Receiver<Arc<Vec<f32>>>,
    stt_tx: SyncSender<Arc<Vec<f32>>>,
    shared: Arc<SharedState>,
) -> Result<u64> {
    let mut dropped: u64 = 0;
    let mut block: Vec<f32> = Vec::with_capacity(STT_BLOCK_SAMPLES);

    while let Ok(chunk) = chunk_rx.recv() {
        if let Err(e) = writer.append(&chunk) {
            log::warn!("failed to append recorded samples to wav: {e}");
            *lock(&shared.last_error) = Some(e.to_string());
        }

        block.extend_from_slice(&chunk);
        while block.len() >= STT_BLOCK_SAMPLES {
            let full_block: Vec<f32> = block.drain(..STT_BLOCK_SAMPLES).collect();
            try_send_stt_block(&stt_tx, full_block, &mut dropped);
        }
    }

    // Flush the trailing partial block (if any) rather than dropping it —
    // this is exactly the tail of audio a `stop_recording` call interrupts
    // mid-block.
    if !block.is_empty() {
        try_send_stt_block(&stt_tx, block, &mut dropped);
    }

    writer.finalize()
}

/// Factory namespace for starting a recording — see [`Recorder::start`].
/// (Zero-sized; the returned [`RecorderHandle`] is the actual owner of the
/// cpal stream and recording state.)
pub struct Recorder;

/// A live recording in progress: owns the cpal stream and the dedicated
/// WAV-writer thread (both kept alive for as long as this handle lives),
/// and exposes pause/resume/stop.
pub struct RecorderHandle {
    stream: cpal::Stream,
    shared: Arc<SharedState>,
    wav_path: PathBuf,
    writer_thread: std::thread::JoinHandle<Result<u64>>,
}

impl Recorder {
    /// Opens the default input device, starts capturing at its native
    /// rate/format, and writes into `note_dir/audio.wav` (16 kHz mono
    /// 16-bit PCM, resampled from whatever the device provides) via a
    /// dedicated writer thread — see `run_writer_thread`. Each
    /// downmixed+resampled chunk is also forwarded (as a shared `Arc`, no
    /// extra copy) onto `sample_tx` for the live transcription worker (see
    /// `run_writer_thread`'s docs for why this hand-off is bounded and
    /// drop-on-full).
    pub fn start(note_dir: PathBuf, sample_tx: SyncSender<Arc<Vec<f32>>>) -> Result<RecorderHandle> {
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
            tracker: Mutex::new(ElapsedTracker::new()),
            paused: AtomicBool::new(false),
            last_error: Mutex::new(None),
        });
        lock(&shared.tracker).start(Instant::now());

        let (writer_tx, writer_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let writer_shared = shared.clone();
        let writer_thread = std::thread::spawn(move || {
            run_writer_thread(wav_writer, writer_rx, sample_tx, writer_shared)
        });

        let resampler = LinearResampler::new(from_hz, TARGET_SAMPLE_RATE);

        let stream = match sample_format {
            cpal::SampleFormat::F32 => build_stream::<f32>(
                &device,
                &config,
                channels,
                shared.clone(),
                writer_tx,
                resampler,
            )?,
            cpal::SampleFormat::I16 => build_stream::<i16>(
                &device,
                &config,
                channels,
                shared.clone(),
                writer_tx,
                resampler,
            )?,
            cpal::SampleFormat::U16 => build_stream::<u16>(
                &device,
                &config,
                channels,
                shared.clone(),
                writer_tx,
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
            writer_thread,
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
    /// first — that drops the audio callback's `writer_tx` sender clone,
    /// which (once the writer thread drains whatever was already queued)
    /// ends `run_writer_thread`'s loop and lets it finalize the file — then
    /// joins that thread to make sure the file is actually closed before
    /// returning.
    pub fn stop(self) -> Result<(f64, PathBuf)> {
        drop(self.stream);

        let elapsed_ms = lock(&self.shared.tracker).elapsed_ms(Instant::now());

        let _total_samples = self
            .writer_thread
            .join()
            .map_err(|_| MinuteError::Other("wav writer thread panicked".to_string()))??;

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
    /// The live-transcription worker thread, if one was spawned (it isn't
    /// when the configured STT model isn't installed — see
    /// `start_recording`). Joined in `stop_recording`, *before*
    /// `finalize_note`, so the transcript is complete by the time the note
    /// is marked `transcribed`.
    stt_worker: Option<std::thread::JoinHandle<()>>,
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
/// recording", using the caller-supplied `model_id` — the frontend passes
/// the user's currently selected STT model — falling back to
/// "whisper-small" when `None`), starts the `Recorder` writing into that
/// note's `audio.wav`, spawns the live-transcription `SttWorker` (if the
/// resolved model is actually installed — recording still proceeds without
/// one otherwise, just without a live transcript; an id that isn't even in
/// the catalog is treated exactly the same way as "not installed", see
/// `spawn_stt_worker_if_model_installed`), and spawns the 1s ticker that
/// keeps emitting `recording-state` while active. Returns the new note's id.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    store: State<'_, SharedStore>,
    recorder: State<'_, SharedRecorderState>,
    model_id: Option<String>,
) -> std::result::Result<String, String> {
    if lock_recorder_state(&recorder).active.is_some() {
        return Err("a recording is already in progress".to_string());
    }

    let model_id = model_id.unwrap_or_else(|| "whisper-small".to_string());
    let meta = lock_store(&store)
        .create_note_now("New recording", &model_id)
        .map_err(|e| e.to_string())?;
    let note_dir = lock_store(&store).note_dir(&meta.id);

    let (sample_tx, sample_rx) =
        std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
    let handle = match Recorder::start(note_dir.clone(), sample_tx) {
        Ok(handle) => handle,
        Err(e) => {
            // The note directory was already created by `create_note_now`
            // above — if the recorder itself then fails to start (no input
            // device, stream build failure, ...), that note would
            // otherwise sit forever with status "recording" and no way to
            // ever finish it. It holds no user data yet (no audio, no
            // transcript), so it's safe to just remove it; best-effort —
            // if cleanup itself fails, log and still surface the original
            // `Recorder::start` error rather than masking it.
            if let Err(cleanup_err) = std::fs::remove_dir_all(&note_dir) {
                log::warn!(
                    "failed to remove note dir {note_dir:?} after failed recorder start: {cleanup_err}"
                );
            }
            return Err(e.to_string());
        }
    };

    let note_id = meta.id.clone();

    let stt_worker = spawn_stt_worker_if_model_installed(&app, &store, &note_id, &model_id, sample_rx);

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
        stt_worker,
        tick_handle,
    });

    emit_recording_state(&app, &note_id, "recording", 0.0);
    Ok(note_id)
}

/// Resolves `model_id`'s installed path from the catalog and, if it's
/// actually installed on disk, spawns an `SttWorker` consuming `sample_rx`.
/// If the model isn't in the catalog at all, or isn't installed, no worker
/// is spawned — the recording still proceeds (its `sample_rx` end is just
/// dropped, so the writer thread's `try_send` calls harmlessly start
/// returning `Disconnected`) and an `stt-status` error event is emitted so
/// the frontend can show "no live transcript" rather than silently having
/// none.
fn spawn_stt_worker_if_model_installed(
    app: &AppHandle,
    store: &State<'_, SharedStore>,
    note_id: &str,
    model_id: &str,
    sample_rx: Receiver<Arc<Vec<f32>>>,
) -> Option<std::thread::JoinHandle<()>> {
    let models_root = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("failed to resolve app data dir for stt worker: {e}");
            emit_stt_status_error(app, note_id, "failed to resolve app data directory");
            return None;
        }
    };

    let catalog = match catalog::load_catalog() {
        Ok(catalog) => catalog,
        Err(e) => {
            log::warn!("failed to load model catalog for stt worker: {e}");
            emit_stt_status_error(app, note_id, "failed to load model catalog");
            return None;
        }
    };

    let entry = catalog.into_iter().find(|e| e.id == model_id);
    let installed = entry
        .as_ref()
        .map(|e| catalog::install_state(e, &models_root) == InstallState::Installed)
        .unwrap_or(false);

    let Some(entry) = entry.filter(|_| installed) else {
        emit_stt_status_error(app, note_id, "model not installed");
        return None;
    };

    let model_path = catalog::installed_path(&entry, &models_root);
    let worker_ctx = WorkerCtx {
        note_id: note_id.to_string(),
        store: store.inner().clone(),
        emit: Box::new(stt::tauri_emit(app.clone())),
    };
    Some(stt::SttWorker::spawn(model_path, sample_rx, worker_ctx))
}

fn emit_stt_status_error(app: &AppHandle, note_id: &str, error: &str) {
    stt::tauri_emit(app.clone())(SttEvent::SttStatus(SttStatusPayload {
        note_id: note_id.to_string(),
        state: SttStatusState::Error,
        error: Some(error.to_string()),
    }));
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
/// (finalizing the WAV file), joins the `SttWorker` thread (if one was
/// spawned) so it flushes its final partial window and finishes persisting
/// segments *before* the note is finalized, finalizes the note in the store
/// (status `transcribed`, speakers 1 — diarization is out of scope for
/// Stage 2), and emits a final `stopped` `recording-state`. Errors if none
/// is active.
///
/// Failure handling: once `active` is taken out of `RecorderState`, there
/// is no way for a later call to retry stopping this specific recording —
/// so a failure partway through must not leave the note stuck at status
/// "recording" forever. If `Recorder::stop` itself fails (writer thread
/// panic, WAV finalize error), we still finalize the note using the
/// elapsed time captured *before* attempting `stop()`, on the reasoning
/// that "note closed out with an approximate duration" is strictly more
/// useful than "note permanently stuck as if still recording". The one
/// case left unhandled is `finalize_note` itself failing (e.g. a meta.json
/// write error) — there's no further fallback for that, since finalizing
/// the note *is* the mechanism being used for every other fallback here
/// too; that error is surfaced as-is.
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
    let fallback_elapsed_secs = active.handle.elapsed_ms() as f64 / 1000.0;

    let duration_sec = match active.handle.stop() {
        Ok((duration_sec, _wav_path)) => duration_sec,
        Err(e) => {
            log::warn!(
                "failed to cleanly stop recording {note_id}: {e}; finalizing the note anyway \
                 with its last known elapsed time so it doesn't stay stuck as \"recording\""
            );
            fallback_elapsed_secs
        }
    };

    // `Recorder::stop` (above) already dropped the cpal stream and joined
    // the writer thread, which drops the writer thread's `stt_tx` — the
    // STT worker's `sample_rx.recv()` loop sees the channel close, flushes
    // its final partial window, and returns. Joining here blocks until
    // that flush (and its `append_segment` calls) has actually happened,
    // so the transcript on disk is complete before `finalize_note` runs.
    if let Some(worker) = active.stt_worker {
        // Tail-window inference can take a second or two — let the
        // frontend show a "finalizing transcript" state for that stretch
        // rather than nothing between "stopped recording" and the note
        // actually being ready.
        stt::tauri_emit(app.clone())(SttEvent::SttStatus(SttStatusPayload {
            note_id: note_id.clone(),
            state: SttStatusState::Finalizing,
            error: None,
        }));
        if let Err(e) = worker.join() {
            log::warn!("stt worker thread panicked for note {note_id}: {e:?}");
        }
    }

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

    // --- run_writer_thread (the audio callback -> WAV + STT hand-off) -------

    fn test_shared_state() -> Arc<SharedState> {
        Arc::new(SharedState {
            tracker: Mutex::new(ElapsedTracker::new()),
            paused: AtomicBool::new(false),
            last_error: Mutex::new(None),
        })
    }

    #[test]
    fn writer_thread_flushes_partial_trailing_block_to_stt_on_channel_close() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        let chunk_a = Arc::new(vec![0.1f32, 0.2, 0.3]);
        let chunk_b = Arc::new(vec![-0.4f32, 0.5]);
        chunk_tx.send(chunk_a.clone()).unwrap();
        chunk_tx.send(chunk_b.clone()).unwrap();
        // Dropping the sender is exactly what `RecorderHandle::stop`
        // triggers by dropping the cpal stream — it's what lets
        // `run_writer_thread`'s `recv()` loop end (after draining what's
        // already queued) instead of blocking forever.
        drop(chunk_tx);

        let total = run_writer_thread(writer, chunk_rx, stt_tx, test_shared_state()).unwrap();
        assert_eq!(total, 5);

        // Well under one full ~0.5s block (STT_BLOCK_SAMPLES), so both
        // chunks are batched together into a single partial block and
        // flushed as one when the channel closes — not forwarded
        // chunk-by-chunk (no longer the same `Arc` as either input chunk),
        // and not lost off the end.
        let forwarded = stt_rx.recv().unwrap();
        assert_eq!(*forwarded, vec![0.1f32, 0.2, 0.3, -0.4, 0.5]);
        assert!(
            stt_rx.try_recv().is_err(),
            "expected exactly one forwarded block"
        );

        let mut reader = hound::WavReader::open(&path).unwrap();
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        let expected: Vec<i16> = [0.1f32, 0.2, 0.3, -0.4, 0.5]
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
            .collect();
        assert_eq!(samples.len(), expected.len());
        for (got, want) in samples.iter().zip(expected.iter()) {
            assert!((*got as i32 - *want as i32).abs() <= 1);
        }
    }

    #[test]
    fn writer_thread_sends_full_block_as_soon_as_it_accumulates_then_flushes_the_remainder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        // One full block plus a small remainder, delivered as two cpal-ish
        // chunks whose boundaries don't line up with the block boundary.
        chunk_tx
            .send(Arc::new(vec![0.2f32; STT_BLOCK_SAMPLES]))
            .unwrap();
        chunk_tx.send(Arc::new(vec![0.3f32; 100])).unwrap();
        drop(chunk_tx);

        let total = run_writer_thread(writer, chunk_rx, stt_tx, test_shared_state()).unwrap();
        assert_eq!(total, STT_BLOCK_SAMPLES as u64 + 100);

        let first = stt_rx.recv().unwrap();
        assert_eq!(first.len(), STT_BLOCK_SAMPLES);
        let second = stt_rx.recv().unwrap();
        assert_eq!(second.len(), 100);
        assert!(
            stt_rx.try_recv().is_err(),
            "expected exactly two forwarded blocks"
        );
    }

    #[test]
    fn writer_thread_with_no_chunks_finalizes_empty_wav() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (stt_tx, _stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        drop(chunk_tx);

        let total = run_writer_thread(writer, chunk_rx, stt_tx, test_shared_state()).unwrap();
        assert_eq!(total, 0);

        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.len(), 0);
    }

    #[test]
    fn writer_thread_survives_a_dropped_stt_receiver() {
        // If no `SttWorker` is draining the STT side (e.g. the model isn't
        // installed — see `spawn_stt_worker_if_model_installed`), the
        // writer thread must keep writing to the WAV file regardless;
        // `try_send`ing into a channel with no receiver just returns
        // `Disconnected` rather than panicking or blocking.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        drop(stt_rx);

        chunk_tx.send(Arc::new(vec![0.25f32, -0.25])).unwrap();
        drop(chunk_tx);

        let total = run_writer_thread(writer, chunk_rx, stt_tx, test_shared_state()).unwrap();
        assert_eq!(total, 2);
    }

    #[test]
    fn writer_thread_drops_blocks_and_logs_when_stt_channel_is_full() {
        // Capacity-1 channel with nothing draining it: the first ~0.5s
        // block fills it, every subsequent block must be dropped (not
        // block, not error out `run_writer_thread` itself) while the WAV
        // file still receives every single sample.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(1);

        // Exactly 3 full ~0.5s blocks worth of audio, sent as one chunk —
        // the writer thread batches internally regardless of how
        // `chunk_rx`'s items happen to be sized.
        let total_samples = STT_BLOCK_SAMPLES * 3;
        chunk_tx
            .send(Arc::new(vec![0.1f32; total_samples]))
            .unwrap();
        drop(chunk_tx);

        let total = run_writer_thread(writer, chunk_rx, stt_tx, test_shared_state()).unwrap();
        // Every sample still made it into the WAV file...
        assert_eq!(total, total_samples as u64);
        // ...but only as many ~0.5s blocks as the bounded channel's
        // capacity (1) made it to the STT side; the rest were dropped, not
        // queued.
        assert_eq!(stt_rx.try_iter().count(), 1);
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

    // --- real recording smoke test (manual only) -----------------------------

    /// End-to-end smoke test against real hardware, exercising the exact
    /// same pieces `start_recording`/`stop_recording` wire together (minus
    /// the `AppHandle`, which those two need only to emit Tauri events —
    /// everything else here is plain, non-Tauri Rust). Opens the *real*
    /// app-data store, plays a short `say` utterance through the speakers
    /// (so there's real speech for the mic to catch and whisper to
    /// transcribe), records ~10s from the default input device, transcribes
    /// it live with the installed whisper-small model, and asserts a real
    /// note directory with `audio.wav` shows up under the real app data
    /// dir. Requires whisper-small already installed (Task 4's real
    /// download test) and a working, permission-granted input device — a
    /// `Recorder::start` failure (no input device / mic permission denied)
    /// fails this test with that error message rather than silently
    /// no-op'ing, so a permission problem shows up directly in the test
    /// output. Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     real_recording_end_to_end -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn real_recording_end_to_end() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let app_data_dir = PathBuf::from(&home).join("Library/Application Support/dev.minute.app");

        let catalog = catalog::load_catalog().expect("catalog.json should parse");
        let entry = catalog
            .into_iter()
            .find(|e| e.id == "whisper-small")
            .expect("catalog.json must contain whisper-small");
        let model_path = catalog::installed_path(&entry, &app_data_dir);
        assert!(
            model_path.exists(),
            "expected whisper-small installed at {model_path:?} (run Task 4's \
             real_download_of_whisper_small test first)"
        );

        let store = crate::store::open_shared(app_data_dir.clone());
        let meta = lock_store(&store)
            .create_note_now("Smoke test recording", "whisper-small")
            .expect("failed to create note");
        let note_dir = lock_store(&store).note_dir(&meta.id);
        eprintln!("recording into {note_dir:?}");

        // Real speech through the speakers for the mic to (hopefully) pick
        // up — non-fatal if `say` itself isn't available; the test still
        // exercises the mechanical recording/finalize pipeline either way,
        // just against ambient audio instead.
        if let Err(e) = std::process::Command::new("say")
            .arg("The quick brown fox jumps over the lazy dog.")
            .spawn()
        {
            eprintln!("failed to spawn `say` (non-fatal, continuing with ambient audio): {e}");
        }

        let (sample_tx, sample_rx) =
            std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let handle = Recorder::start(note_dir.clone(), sample_tx)
            .expect("Recorder::start failed — check mic permission / input device availability");

        let events: Arc<Mutex<Vec<stt::SttEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = events.clone();
        let worker_ctx = WorkerCtx {
            note_id: meta.id.clone(),
            store: store.clone(),
            emit: Box::new(move |event| events_for_emit.lock().unwrap().push(event)),
        };
        let worker = stt::SttWorker::spawn(model_path, sample_rx, worker_ctx);

        std::thread::sleep(Duration::from_secs(10));

        let (duration_sec, wav_path) = handle.stop().expect("Recorder::stop failed");
        worker.join().expect("stt worker thread panicked");
        let final_meta = lock_store(&store)
            .finalize_note(&meta.id, duration_sec, 1)
            .expect("finalize_note failed");

        eprintln!("recorded {duration_sec:.1}s, wav at {wav_path:?}");
        eprintln!("final note status: {:?}", final_meta.status);
        let events = events.lock().unwrap();
        eprintln!("captured {} stt events: {:?}", events.len(), *events);

        assert!(note_dir.exists(), "note directory should exist");
        assert!(wav_path.exists(), "audio.wav should exist");
        let wav_len = std::fs::metadata(&wav_path).map(|m| m.len()).unwrap_or(0);
        eprintln!("audio.wav size: {wav_len} bytes");
        assert!(wav_len > 44, "audio.wav should contain more than just a WAV header");

        let (_meta, transcript) = lock_store(&store).get_note(&meta.id).unwrap();
        eprintln!("transcript.json segments: {:?}", transcript.segments);
    }
}
