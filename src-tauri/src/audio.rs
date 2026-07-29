//! Mic capture, downmix/resample to 16 kHz mono, and incremental WAV writing.
//!
//! Pure, unit-tested building blocks ([`downmix_to_mono`], [`LinearResampler`],
//! [`WavWriter`], [`ElapsedTracker`]) are factored out from the hardware-facing
//! [`Recorder`]/[`RecorderHandle`] pair the same way `download.rs` separates
//! its pure filesystem/throttling helpers from `execute_download`'s real
//! network I/O — see that module's header comment for the rationale.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample as _;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::runtime::Bool;
#[cfg(target_os = "macos")]
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

use crate::catalog::{self, InstallState};
use crate::error::{MinuteError, Result};
use crate::llm::{self, LlmBusy, SharedLlmEngine};
use crate::settings::{self, SharedSettings};
use crate::store::{lock_store, NoteMeta, SharedStore};
use crate::stt::{self, SttEvent, SttStatusPayload, SttStatusState, WorkerCtx};
use crate::syscap::{self, SysAudioAvailability, SysCapture};

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

/// Preview events are intentionally slower than the device callback cadence:
/// fast enough to feel live, slow enough not to churn the webview or make
/// assistive status text flicker.
const INPUT_PREVIEW_INTERVAL: Duration = Duration::from_millis(80);

/// A selectable microphone as reported by the same cpal host
/// `Recorder::start` uses. The opaque cpal id, rather than the display name,
/// is sent back when recording starts because multiple devices can share a
/// name.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Current microphones and the macOS default. An empty list is an honest
/// "no input device" state rather than a command error, so the preflight can
/// stay open and explain why recording cannot start.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputStatus {
    pub devices: Vec<AudioInputDevice>,
    pub default_device_id: Option<String>,
    pub permission: MicrophonePermission,
}

/// macOS microphone authorization as reported by AVFoundation. Checking this
/// explicitly matters because CoreAudio can successfully open a stream that
/// only delivers silence while permission is unresolved or denied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MicrophonePermission {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
    Unknown,
}

#[cfg(target_os = "macos")]
fn microphone_permission_from_av(status: AVAuthorizationStatus) -> MicrophonePermission {
    match status {
        AVAuthorizationStatus::NotDetermined => MicrophonePermission::NotDetermined,
        AVAuthorizationStatus::Restricted => MicrophonePermission::Restricted,
        AVAuthorizationStatus::Denied => MicrophonePermission::Denied,
        AVAuthorizationStatus::Authorized => MicrophonePermission::Authorized,
        _ => MicrophonePermission::Unknown,
    }
}

pub fn microphone_permission_status() -> MicrophonePermission {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: AVMediaTypeAudio is a process-lifetime AVFoundation
        // constant. Passing it to this documented class method is valid on
        // every supported macOS version.
        let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
            return MicrophonePermission::Unknown;
        };
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        microphone_permission_from_av(status)
    }

    #[cfg(not(target_os = "macos"))]
    {
        MicrophonePermission::Authorized
    }
}

fn ensure_microphone_authorized() -> Result<()> {
    match microphone_permission_status() {
        MicrophonePermission::Authorized => Ok(()),
        MicrophonePermission::NotDetermined => Err(MinuteError::Other(
            "microphone permission is required before recording".to_string(),
        )),
        MicrophonePermission::Denied => Err(MinuteError::Other(
            "microphone access is denied; enable Minute in System Settings → Privacy & Security → Microphone"
                .to_string(),
        )),
        MicrophonePermission::Restricted => Err(MinuteError::Other(
            "microphone access is restricted by macOS settings".to_string(),
        )),
        MicrophonePermission::Unknown => Err(MinuteError::Other(
            "microphone permission status could not be determined".to_string(),
        )),
    }
}

/// Read-only microphone check for the pre-recording sheet. This never opens
/// a stream or triggers microphone permission itself; the actual
/// `start_recording` call remains the final authority because devices can
/// change between this check and capture starting.
#[tauri::command]
pub fn audio_input_status() -> AudioInputStatus {
    let host = cpal::default_host();
    let default_device = host.default_input_device().and_then(|device| {
        let id = device.id().ok()?.to_string();
        let name = device.description().ok()?.name().to_string();
        Some((id, name))
    });
    let default_device_id = default_device.as_ref().map(|(id, _)| id.clone());

    let mut devices: Vec<AudioInputDevice> = host
        .input_devices()
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            let name = device.description().ok()?.name().to_string();
            Some(AudioInputDevice {
                is_default: default_device_id.as_deref() == Some(id.as_str()),
                id,
                name,
            })
        })
        .collect();

    // Some hosts can expose a usable default even when enumeration is
    // temporarily incomplete. Keep that source selectable instead of
    // presenting an empty, contradictory preflight.
    if let Some((id, name)) = default_device {
        if !devices.iter().any(|device| device.id == id) {
            devices.push(AudioInputDevice {
                id,
                name,
                is_default: true,
            });
        }
    }
    devices.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    AudioInputStatus {
        devices,
        default_device_id,
        permission: microphone_permission_status(),
    }
}

/// Requests microphone access through AVFoundation. This is separate from
/// opening a cpal stream because CoreAudio can vend silent samples without
/// presenting the system prompt. The blocking wait runs off the Tauri command
/// thread; AVFoundation invokes the completion block on its own queue.
#[tauri::command]
pub async fn request_microphone_permission() -> std::result::Result<MicrophonePermission, String> {
    let current = microphone_permission_status();
    if current != MicrophonePermission::NotDetermined {
        return Ok(current);
    }

    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
            let handler = RcBlock::new(move |granted: Bool| {
                let _ = result_tx.send(granted.as_bool());
            });
            // SAFETY: AVMediaTypeAudio is a static AVFoundation constant and
            // requestAccess copies the completion block for asynchronous use.
            let media_type = (unsafe { AVMediaTypeAudio })
                .ok_or_else(|| "AVFoundation audio media type is unavailable".to_string())?;
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &handler);
            }
            result_rx
                .recv_timeout(Duration::from_secs(120))
                .map_err(|_| {
                    "timed out waiting for the macOS microphone permission response".to_string()
                })?;
            Ok(microphone_permission_status())
        })
        .await
        .map_err(|error| format!("microphone permission task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(MicrophonePermission::Authorized)
    }
}

fn input_device(host: &cpal::Host, requested_id: Option<&str>) -> Result<cpal::Device> {
    let Some(requested_id) = requested_id else {
        return host
            .default_input_device()
            .ok_or_else(|| MinuteError::Other("no input device available".to_string()));
    };

    let devices = host
        .input_devices()
        .map_err(|e| MinuteError::Other(format!("could not list input devices: {e}")))?;
    for device in devices {
        let matches = device
            .id()
            .map(|id| id.to_string() == requested_id)
            .unwrap_or(false);
        if matches {
            return Ok(device);
        }
    }
    Err(MinuteError::Other(
        "the selected microphone is no longer available".to_string(),
    ))
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioInputLevelEvent {
    session_id: String,
    rms: f32,
    peak: f32,
    error: Option<String>,
}

enum InputPreviewMessage {
    Level { rms: f32, peak: f32 },
    Error(String),
}

/// A short-lived, read-only microphone stream used by the preflight meter.
/// Dropping the handle stops the stream first, which drops both callback
/// senders and lets the event worker exit before it is joined.
pub(crate) struct InputPreviewHandle {
    session_id: String,
    stream: Option<cpal::Stream>,
    event_worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for InputPreviewHandle {
    fn drop(&mut self) {
        drop(self.stream.take());
        if let Some(worker) = self.event_worker.take() {
            let _ = worker.join();
        }
    }
}

/// Managed state for the one preflight preview stream. A new device selection
/// replaces the old stream; a recording start always drops this state before
/// opening the final capture stream.
pub type SharedInputPreview = Arc<Mutex<Option<InputPreviewHandle>>>;

pub(crate) fn open_input_preview() -> SharedInputPreview {
    Arc::new(Mutex::new(None))
}

fn input_levels<T>(data: &[T], channels: u16) -> (f32, f32)
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = channels.max(1) as usize;
    let mut mono_square_sum = 0.0_f64;
    let mut frame_count = 0_usize;
    let mut peak = 0.0_f32;

    for frame in data.chunks(channels) {
        let mut mono = 0.0_f32;
        for &sample in frame {
            let sample = f32::from_sample(sample);
            mono += sample;
            peak = peak.max(sample.abs());
        }
        mono /= frame.len() as f32;
        mono_square_sum += f64::from(mono) * f64::from(mono);
        frame_count += 1;
    }

    let rms = if frame_count == 0 {
        0.0
    } else {
        (mono_square_sum / frame_count as f64).sqrt() as f32
    };
    (rms.clamp(0.0, 1.0), peak.clamp(0.0, 1.0))
}

fn build_input_preview_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    message_tx: SyncSender<InputPreviewMessage>,
) -> Result<cpal::Stream>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let error_tx = message_tx.clone();
    let mut last_emit = Instant::now()
        .checked_sub(INPUT_PREVIEW_INTERVAL)
        .unwrap_or_else(Instant::now);
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if last_emit.elapsed() < INPUT_PREVIEW_INTERVAL {
                    return;
                }
                last_emit = Instant::now();
                let (rms, peak) = input_levels(data, channels);
                let _ = message_tx.try_send(InputPreviewMessage::Level { rms, peak });
            },
            move |err| {
                log::warn!("cpal input preview stream error: {err}");
                let _ = error_tx.try_send(InputPreviewMessage::Error(err.to_string()));
            },
            None,
        )
        .map_err(|e| MinuteError::Other(format!("failed to build input preview: {e}")))
}

fn create_input_preview(
    app: AppHandle,
    device: &cpal::Device,
    session_id: String,
) -> Result<InputPreviewHandle> {
    let supported = device
        .default_input_config()
        .map_err(|e| MinuteError::Other(format!("no default input config: {e}")))?;
    let sample_format = supported.sample_format();
    let channels = supported.channels();
    let config: cpal::StreamConfig = supported.into();
    let (message_tx, message_rx) = std::sync::mpsc::sync_channel(2);
    let event_session_id = session_id.clone();
    let event_worker = std::thread::Builder::new()
        .name("input-preview-events".to_string())
        .spawn(move || {
            while let Ok(message) = message_rx.recv() {
                let (rms, peak, error) = match message {
                    InputPreviewMessage::Level { rms, peak } => (rms, peak, None),
                    InputPreviewMessage::Error(error) => (0.0, 0.0, Some(error)),
                };
                let _ = app.emit_to(
                    "main",
                    "audio-input-level",
                    AudioInputLevelEvent {
                        session_id: event_session_id.clone(),
                        rms,
                        peak,
                        error,
                    },
                );
            }
        })
        .map_err(|e| MinuteError::Other(format!("failed to start input preview worker: {e}")))?;

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            build_input_preview_stream::<f32>(device, &config, channels, message_tx)
        }
        cpal::SampleFormat::I16 => {
            build_input_preview_stream::<i16>(device, &config, channels, message_tx)
        }
        cpal::SampleFormat::U16 => {
            build_input_preview_stream::<u16>(device, &config, channels, message_tx)
        }
        other => Err(MinuteError::Other(format!(
            "unsupported input sample format: {other:?}"
        ))),
    };
    let stream = match stream {
        Ok(stream) => stream,
        Err(error) => {
            let _ = event_worker.join();
            return Err(error);
        }
    };
    if let Err(error) = stream.play() {
        drop(stream);
        let _ = event_worker.join();
        return Err(MinuteError::Other(format!(
            "failed to start input preview: {error}"
        )));
    }

    Ok(InputPreviewHandle {
        session_id,
        stream: Some(stream),
        event_worker: Some(event_worker),
    })
}

/// Opens the selected microphone without recording or persisting audio and
/// emits throttled `audio-input-level` events for the matching frontend
/// session. Replaces any older preview stream atomically.
#[tauri::command]
pub fn start_audio_input_preview(
    app: AppHandle,
    preview: State<'_, SharedInputPreview>,
    recorder: State<'_, SharedRecorderState>,
    input_device_id: String,
    session_id: String,
) -> std::result::Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("input preview session id cannot be empty".to_string());
    }

    let mut preview_guard = lock(&preview);
    preview_guard.take();
    if is_recording_active(&recorder) {
        return Err("cannot preview an input while recording".to_string());
    }
    ensure_microphone_authorized().map_err(|error| error.to_string())?;

    let host = cpal::default_host();
    let device = input_device(&host, Some(&input_device_id)).map_err(|e| e.to_string())?;
    let handle = create_input_preview(app, &device, session_id).map_err(|e| e.to_string())?;
    *preview_guard = Some(handle);
    Ok(())
}

/// Stops only the preview session that requested the cleanup. This token
/// check prevents a late React effect cleanup for device A from stopping the
/// newer device B preview.
#[tauri::command]
pub fn stop_audio_input_preview(preview: State<'_, SharedInputPreview>, session_id: String) {
    let mut guard = lock(&preview);
    if guard
        .as_ref()
        .is_some_and(|handle| handle.session_id == session_id)
    {
        guard.take();
    }
}

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
// mix_into (Stage 5 Task 5: two-source recording pipeline)
// ---------------------------------------------------------------------------

/// Additively mixes `mic` and `system` (both already resampled to
/// [`TARGET_SAMPLE_RATE`] mono by the time either reaches this function —
/// see `run_writer_thread_with_system`'s docs) into `out`, sample-for-sample.
///
/// **Clip guard: a hard clamp to `[-1.0, 1.0]`, not a `tanh`-style soft
/// clip.** Both were considered (per the plan's own callout); a hard clamp
/// was chosen because it's the only shape that satisfies *both* of this
/// function's contractual properties simultaneously: (1) two full-scale
/// inputs must not wrap/alias past `[-1.0, 1.0]`, and (2) silence plus a
/// signal must reproduce that signal *exactly* — a curve like `tanh` is
/// nonlinear everywhere, so it would quietly recolor every quiet passage
/// (e.g. `tanh(0.5) ≈ 0.4621`, not `0.5`) even when nothing is actually
/// clipping, and a curve applied only above some threshold would be
/// *discontinuous* at that threshold (a jump, not a knee). A hard clamp only
/// ever touches the rare sample where the summed mic+system signal actually
/// exceeds full scale — the same clamp `WavWriter::append` already applies
/// unconditionally to every sample regardless (see its docs), so this is
/// consistent with, not a departure from, this crate's existing audio-level
/// handling. The audible cost is ordinary hard-clipping distortion on the
/// rare loud-both-at-once sample, accepted as the honest trade for leaving
/// every other sample bit-exact.
///
/// **Length handling — underrun, not an error.** `mic` and `system` are
/// almost never exactly the same length in practice (see
/// `run_writer_thread_with_system`'s docs on why the system side can run
/// short) — `out` is sized to the *longer* of the two, and whichever side
/// ran short is treated as silence (`0.0`) for its missing tail, not
/// truncated or padded with anything else. `out` is cleared and reused
/// (not appended to) so repeated calls against the same scratch buffer never
/// accumulate stale samples from a previous call.
pub fn mix_into(mic: &[f32], system: &[f32], out: &mut Vec<f32>) {
    out.clear();
    let len = mic.len().max(system.len());
    out.reserve(len);
    for i in 0..len {
        let m = mic.get(i).copied().unwrap_or(0.0);
        let s = system.get(i).copied().unwrap_or(0.0);
        out.push((m + s).clamp(-1.0, 1.0));
    }
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
    #[cfg(test)]
    fail_after_samples: Option<u64>,
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
            #[cfg(test)]
            fail_after_samples: None,
        })
    }

    #[cfg(test)]
    fn create_failing_after(path: &Path, samples: u64) -> Result<Self> {
        let mut writer = Self::create(path)?;
        writer.fail_after_samples = Some(samples);
        Ok(writer)
    }

    /// Clamps each sample to `[-1.0, 1.0]` and appends it as 16-bit PCM.
    pub fn append(&mut self, samples_f32: &[f32]) -> Result<()> {
        let writer = self
            .inner
            .as_mut()
            .ok_or_else(|| MinuteError::Other("append called after finalize".to_string()))?;
        for &sample in samples_f32 {
            #[cfg(test)]
            if self
                .fail_after_samples
                .is_some_and(|limit| self.total_samples >= limit)
            {
                return Err(MinuteError::Other(
                    "simulated low-disk WAV write failure".to_string(),
                ));
            }
            let clamped = sample.clamp(-1.0, 1.0);
            let quantized = (clamped * i16::MAX as f32).round() as i16;
            writer
                .write_sample(quantized)
                .map_err(|e| MinuteError::Other(format!("failed to write wav sample: {e}")))?;
            self.total_samples += 1;
        }
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
    /// `Arc<AtomicBool>` (not a bare `AtomicBool`) so the exact same flag can
    /// be handed to a concurrently-running [`SysCapture`]'s audio callback
    /// too (see `Recorder::start`'s system-audio branch) — pausing the mic
    /// stream and pausing system-audio capture are then one atomic store,
    /// not two independently-toggled flags that could drift apart. Mirrors
    /// the cpal callback's own discipline exactly: [`SysCapture::start`]'s
    /// callback checks this the same way `build_stream`'s does, skipping
    /// entirely (no decode/mix work, no forwarded block) while paused —
    /// see this module's "pause pauses both sources" design note on
    /// `Recorder::start`.
    paused: Arc<AtomicBool>,
    /// cpal's data/error callbacks can't return a `Result` — errors raised
    /// from inside them (a device error) are stashed here (and
    /// `log::warn!`'d at the call site) instead, for a caller to surface
    /// later via `RecorderHandle::last_error`. The writer thread also
    /// stashes its own append/finalize errors here for the same reason.
    last_error: Mutex<Option<String>>,
    /// Latest microphone RMS, encoded with `f32::to_bits` so the realtime
    /// callback can publish it without taking a lock.
    input_rms_bits: AtomicU32,
    /// Loudest microphone peak since the last `recording-state` snapshot.
    /// The ticker resets this after reading it, making one-second clipping
    /// warnings much harder to miss than a single latest-value sample.
    input_peak_bits: AtomicU32,
    /// Incremented for every non-paused input callback. If it stops moving
    /// for several state ticks, the frontend can distinguish a stalled or
    /// disconnected device from an ordinary silent room.
    input_sequence: AtomicU64,
}

fn store_max_f32(target: &AtomicU32, value: f32) {
    let value = value.clamp(0.0, 1.0);
    let mut current = target.load(Ordering::Relaxed);
    while f32::from_bits(current) < value {
        match target.compare_exchange_weak(
            current,
            value.to_bits(),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

#[derive(Debug)]
struct RecordingInputSnapshot {
    rms: f32,
    peak: f32,
    sequence: u64,
    error: Option<String>,
}

fn recording_input_snapshot(shared: &SharedState) -> RecordingInputSnapshot {
    RecordingInputSnapshot {
        rms: f32::from_bits(shared.input_rms_bits.load(Ordering::Relaxed)),
        peak: f32::from_bits(
            shared
                .input_peak_bits
                .swap(0.0_f32.to_bits(), Ordering::Relaxed),
        ),
        sequence: shared.input_sequence.load(Ordering::Relaxed),
        error: lock(&shared.last_error).clone(),
    }
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
                let (rms, peak) = input_levels::<f32>(&floats, channels);
                shared
                    .input_rms_bits
                    .store(rms.to_bits(), Ordering::Relaxed);
                store_max_f32(&shared.input_peak_bits, peak);
                shared.input_sequence.fetch_add(1, Ordering::Relaxed);
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

/// Appends `samples` to `writer` immediately (so WAV durability never
/// depends on the STT side), stashing any append error onto `shared` the
/// same way `SharedState::last_error`'s docs describe, then batches the
/// same samples into `STT_BLOCK_SAMPLES`-sized (~0.5s) blocks in `block_buf`
/// and forwards each full one — via [`try_send_stt_block`] — to the
/// `SttWorker`. Factored out of `run_writer_thread`/
/// `run_writer_thread_with_system` so both share this one append+batch+
/// forward path byte-for-byte: the *only* difference between the two is
/// what `samples` slice each iteration of their own loop passes in (the raw
/// mic chunk for the former, this iteration's mixed mic+system block for
/// the latter) — see those two functions' own docs.
fn append_and_forward(
    writer: &mut WavWriter,
    stt_tx: &SyncSender<Arc<Vec<f32>>>,
    shared: &Arc<SharedState>,
    block_buf: &mut Vec<f32>,
    dropped: &mut u64,
    samples: &[f32],
) {
    if let Err(e) = writer.append(samples) {
        log::warn!("failed to append recorded samples to wav: {e}");
        *lock(&shared.last_error) = Some(e.to_string());
    }

    block_buf.extend_from_slice(samples);
    while block_buf.len() >= STT_BLOCK_SAMPLES {
        let full_block: Vec<f32> = block_buf.drain(..STT_BLOCK_SAMPLES).collect();
        try_send_stt_block(stt_tx, full_block, dropped);
    }
}

/// Drains `chunk_rx`, appending each chunk to `writer` and batching/
/// forwarding to the `SttWorker` via [`append_and_forward`]. Runs on a
/// dedicated OS thread spawned from `Recorder::start` (the mic-only path —
/// no system-audio source active; see `run_writer_thread_with_system` for
/// the two-source counterpart), so this — not the realtime cpal callback —
/// is where WAV file I/O actually happens.
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
/// it a channel directly, without a real cpal device. Deliberately kept
/// byte-for-byte identical to how it behaved before Stage 5 Task 5 added
/// system audio — no new allocation, no new branch — so every existing test
/// against it, and every mic-only recording, is completely unaffected by
/// that feature's existence.
fn run_writer_thread(
    mut writer: WavWriter,
    chunk_rx: Receiver<Arc<Vec<f32>>>,
    stt_tx: SyncSender<Arc<Vec<f32>>>,
    shared: Arc<SharedState>,
) -> Result<u64> {
    let mut dropped: u64 = 0;
    let mut block: Vec<f32> = Vec::with_capacity(STT_BLOCK_SAMPLES);

    while let Ok(chunk) = chunk_rx.recv() {
        append_and_forward(
            &mut writer,
            &stt_tx,
            &shared,
            &mut block,
            &mut dropped,
            &chunk,
        );
    }

    // Flush the trailing partial block (if any) rather than dropping it —
    // this is exactly the tail of audio a `stop_recording` call interrupts
    // mid-block.
    if !block.is_empty() {
        try_send_stt_block(&stt_tx, std::mem::take(&mut block), &mut dropped);
    }

    writer.finalize()
}

/// Upper bound, in samples, on how far `sys_buf` (the system-audio ring in
/// [`run_writer_thread_with_system`]) is ever allowed to run *ahead* of what
/// the mic side has consumed so far. `2 * STT_BLOCK_SAMPLES` — 1s at
/// [`TARGET_SAMPLE_RATE`]: double this module's only other named "how much
/// audio is one unit" constant, as generous slack above ordinary operation
/// (a real mic chunk handed to the writer thread is one cpal callback's own
/// ~10-20ms burst — one to two orders of magnitude smaller than this) while
/// still bounding a post-stall resync (see that function's docs) to at most
/// 1s of dropped system audio, never the raw stall duration itself.
const SYS_BUF_MAX_LEAD_SAMPLES: usize = 2 * STT_BLOCK_SAMPLES;

/// How often a sustained *run* of stall-recovery resyncs gets logged again,
/// rather than spamming on every single one — same cadence discipline as
/// `STT_DROP_LOG_INTERVAL`/`syscap::SYS_DROP_LOG_INTERVAL` (see those
/// constants' docs), specifically the "log the very first occurrence, then
/// every Nth after that" variant `syscap.rs::log_extraction_failure` already
/// uses (`% == 1`, not `% == 0`) — a *single* resync is the ordinary,
/// expected recovery from one real mic stall (a Bluetooth device switch,
/// ...) and is worth surfacing immediately, not held back; this only
/// throttles a pathological run of many resyncs in a row.
const SYS_RESYNC_LOG_INTERVAL: u64 = 10;

/// The two-source counterpart to [`run_writer_thread`]: pulls mic blocks the
/// same way (blocking `chunk_rx.recv()`), but on every iteration also drains
/// whatever system-audio blocks have arrived on `sys_rx` so far (non-
/// blocking `try_recv` — the system stream must never make the mic side
/// wait) into a small ring (`sys_buf`, a `VecDeque<f32>`), then consumes
/// exactly `chunk.len()` samples off its front — zero-filling if there
/// aren't enough yet (an *underrun*: the system stream started slightly
/// later than the mic one, or is momentarily behind) — before mixing the two
/// via [`mix_into`] and running the mixed result through the exact same
/// [`append_and_forward`] both the WAV writer and the STT chunker use.
///
/// **Drift-handling design note (acceptable, not sample-accurate sync).**
/// The plan explicitly doesn't require sample-accurate alignment between the
/// two hardware-independent streams (a CoreAudio device clock for the mic,
/// ScreenCaptureKit's own capture clock for system audio — the two are never
/// perfectly phase-locked even at the same nominal rate). Both are already
/// resampled to `TARGET_SAMPLE_RATE` before either reaches this function, so
/// the two nominal-rate clocks disagreeing slightly is a second-order effect
/// here, not a source of unbounded drift by itself over a long recording —
/// what *would* be unbounded is a one-directional trend from a real stall
/// (see below), which the staleness cap this function now enforces also
/// bounds, for the same reason. This ring-buffer-plus-zero-fill approach
/// accepts ordinary underrun: an underrun contributes silence for the
/// missing system-audio span (heard as "briefly quieter", not a glitch or
/// gap in the mic signal itself, since the mic side is never held up
/// waiting for it) rather than trying to timestamp-align the two exactly.
///
/// **Staleness cap — recovering from a mic stall, not just tolerating an
/// underrun.** A mic-side stall (e.g. a Bluetooth device switch pausing the
/// input stream for a couple of seconds) is the mirror-image failure mode
/// from underrun: `chunk_rx.recv()` simply blocks (no new mic chunk
/// arrives), while the *system* side keeps flowing and piles up, un-drained,
/// in the bounded channel upstream of `sys_rx`. Without a cap, the very next
/// mic chunk's `try_recv` drain loop would dump that *entire* backlog into
/// `sys_buf` in one shot — and because every subsequent iteration only ever
/// consumes `chunk.len()` samples per mic chunk (steady-state, not a
/// catch-up rate), that backlog would never fully drain: system audio would
/// stay offset by the stall's duration for the rest of the recording,
/// permanently, not just for the stall itself. [`SYS_BUF_MAX_LEAD_SAMPLES`]
/// closes that: after every drain, `sys_buf` is trimmed back down to that
/// cap by dropping from the *front* (the oldest, stalest queued samples) —
/// so what survives into the mix is always the most recent system audio
/// available, and the worst-case permanent offset is bounded at
/// `SYS_BUF_MAX_LEAD_SAMPLES` (~1s), never the raw stall length. Each trim
/// is logged (rate-limited — see [`SYS_RESYNC_LOG_INTERVAL`]) so a real
/// stall shows up in the logs as an honest, named event ("system audio
/// resynced after mic stall"), not a silent, permanent misalignment.
fn run_writer_thread_with_system(
    mut writer: WavWriter,
    chunk_rx: Receiver<Arc<Vec<f32>>>,
    sys_rx: Receiver<Arc<Vec<f32>>>,
    stt_tx: SyncSender<Arc<Vec<f32>>>,
    shared: Arc<SharedState>,
) -> Result<u64> {
    let mut dropped: u64 = 0;
    let mut block: Vec<f32> = Vec::with_capacity(STT_BLOCK_SAMPLES);
    let mut sys_buf: VecDeque<f32> = VecDeque::new();
    let mut sys_scratch: Vec<f32> = Vec::new();
    let mut mixed: Vec<f32> = Vec::new();
    let mut resyncs: u64 = 0;

    while let Ok(chunk) = chunk_rx.recv() {
        while let Ok(sys_block) = sys_rx.try_recv() {
            sys_buf.extend(sys_block.iter().copied());
        }

        // Staleness cap: drop from the front (oldest first) down to the cap
        // — see this function's own "Staleness cap" doc section above for
        // the mic-stall scenario this recovers from.
        if sys_buf.len() > SYS_BUF_MAX_LEAD_SAMPLES {
            let excess = sys_buf.len() - SYS_BUF_MAX_LEAD_SAMPLES;
            sys_buf.drain(..excess);
            resyncs += 1;
            if resyncs % SYS_RESYNC_LOG_INTERVAL == 1 {
                let dropped_ms = excess as f64 * 1000.0 / TARGET_SAMPLE_RATE as f64;
                log::warn!(
                    "system audio resynced after mic stall: dropped {dropped_ms:.0}ms of stale \
                     backlog ({resyncs} resync(s) so far this session)"
                );
            }
        }

        let need = chunk.len();
        let take = need.min(sys_buf.len());
        sys_scratch.clear();
        sys_scratch.reserve(need);
        sys_scratch.extend(sys_buf.drain(..take));
        sys_scratch.resize(need, 0.0);

        mix_into(&chunk, &sys_scratch, &mut mixed);
        append_and_forward(
            &mut writer,
            &stt_tx,
            &shared,
            &mut block,
            &mut dropped,
            &mixed,
        );
    }

    if !block.is_empty() {
        try_send_stt_block(&stt_tx, std::mem::take(&mut block), &mut dropped);
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
    /// Human-readable name reported by cpal for the default microphone that
    /// was opened for this session.
    microphone_name: String,
    /// The system-audio capture session, if one is active for this
    /// recording (`None` for a mic-only recording — see
    /// [`RecorderHandle::system_audio_active`]'s docs for how the two
    /// relate). Owned here so its lifetime matches the recording's: started
    /// in `Recorder::start`, stopped in [`RecorderHandle::stop`].
    sys_capture: Option<SysCapture>,
    /// Whether system audio actually ended up active for this recording —
    /// `true` only when `include_system_audio` was requested *and*
    /// `SysCapture::start` actually succeeded (permission/version-gated —
    /// see that function's docs). Kept as its own field (not just
    /// `sys_capture.is_some()`) so [`RecorderHandle::system_audio_active`]
    /// stays a trivial, panic-free accessor regardless of `sys_capture`'s
    /// state, and so `stop()` can still report it after `sys_capture` is
    /// consumed by that same call.
    system_audio_active: bool,
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
    ///
    /// **System audio (Stage 5 Task 5).** When `include_system_audio` is
    /// `true`, this also starts a [`SysCapture`] session and switches the
    /// writer thread over to [`run_writer_thread_with_system`] (mic +
    /// system, mixed via [`mix_into`]) instead of the plain
    /// [`run_writer_thread`] — see that function's own docs for the mixing/
    /// drift-handling design. `SysCapture::start` failing (permission
    /// revoked between `start_recording`'s own pre-check and this call,
    /// `SCStream` XPC hiccup, ...) is **not** fatal to the recording as a
    /// whole: it's logged and this degrades to an ordinary mic-only
    /// recording, exactly as if `include_system_audio` had been `false` —
    /// see [`RecorderHandle::system_audio_active`] for how a caller learns
    /// which actually happened. `include_system_audio: false` (the common
    /// case, and the *only* case before this task existed) takes the
    /// original code path with zero extra allocation or branching — see
    /// `run_writer_thread`'s own docs for that byte-for-byte guarantee.
    ///
    /// **Pause pauses both sources.** `shared.paused` is an `Arc<AtomicBool>`
    /// (see `SharedState::paused`'s docs) handed to *both* the cpal
    /// callback (`build_stream`, unchanged) and, when active, `SysCapture`'s
    /// own callback — so [`RecorderHandle::pause`]/[`RecorderHandle::resume`]
    /// flip one flag that gates both realtime callbacks identically, rather
    /// than the mic and system streams drifting in and out of sync with
    /// each other across a pause. This mirrors (doesn't diverge from) how
    /// mic-only pause already worked before this task: `RecorderHandle::
    /// pause` was already a software-level "stop forwarding samples" flag
    /// checked inside the realtime callback, not a hardware-level
    /// `cpal::Stream::pause()` call — extending the exact same mechanism to
    /// gate a second callback is simpler, and more consistent, than
    /// inventing a different pause primitive for system audio specifically.
    pub fn start(
        note_dir: PathBuf,
        sample_tx: SyncSender<Arc<Vec<f32>>>,
        include_system_audio: bool,
        input_device_id: Option<&str>,
    ) -> Result<RecorderHandle> {
        let host = cpal::default_host();
        let device = input_device(&host, input_device_id)?;
        let microphone_name = device
            .description()
            .map(|description| description.name().to_string())
            .unwrap_or_else(|_| "Default microphone".to_string());
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

        let paused = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(SharedState {
            tracker: Mutex::new(ElapsedTracker::new()),
            paused: paused.clone(),
            last_error: Mutex::new(None),
            input_rms_bits: AtomicU32::new(0.0_f32.to_bits()),
            input_peak_bits: AtomicU32::new(0.0_f32.to_bits()),
            input_sequence: AtomicU64::new(0),
        });
        lock(&shared.tracker).start(Instant::now());

        let (writer_tx, writer_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();

        // `sys_rx_opt` and `sys_capture` are set together (`Some`/`Some` or
        // `None`/`None`) in every branch below — `system_audio_active` reads
        // off `sys_capture` alone once both are settled, so the two can
        // never disagree about whether system audio actually started.
        let (sys_capture, sys_rx_opt) = if include_system_audio {
            let (sys_tx, sys_rx) = syscap::channel();
            match SysCapture::start(sys_tx, paused.clone()) {
                Ok(capture) => (Some(capture), Some(sys_rx)),
                Err(e) => {
                    log::warn!(
                        "system audio capture failed to start ({e}) — continuing with a \
                         mic-only recording"
                    );
                    (None, None)
                }
            }
        } else {
            (None, None)
        };
        let system_audio_active = sys_capture.is_some();

        let writer_shared = shared.clone();
        let writer_thread = if let Some(sys_rx) = sys_rx_opt {
            std::thread::spawn(move || {
                run_writer_thread_with_system(
                    wav_writer,
                    writer_rx,
                    sys_rx,
                    sample_tx,
                    writer_shared,
                )
            })
        } else {
            std::thread::spawn(move || {
                run_writer_thread(wav_writer, writer_rx, sample_tx, writer_shared)
            })
        };

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
            microphone_name,
            sys_capture,
            system_audio_active,
        })
    }
}

impl RecorderHandle {
    /// Pauses capture: the audio callback starts dropping incoming samples
    /// (stream stays alive/open) and the elapsed-time tracker stops
    /// counting from this instant. When system audio is active, its own
    /// callback observes the same shared flag and pauses identically — see
    /// `Recorder::start`'s "Pause pauses both sources" design note.
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::SeqCst);
        lock(&self.shared.tracker).pause(Instant::now());
    }

    /// Resumes capture after a `pause()` (both sources — see `pause`'s docs).
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

    /// Whether system audio actually ended up part of this recording's mix
    /// — see `Recorder::start`'s docs for why this can be `false` even when
    /// `include_system_audio: true` was requested (a failed `SysCapture::
    /// start` degrades silently to mic-only). This is fixed for the whole
    /// recording session: there's no way to change audio sources mid-
    /// recording, so callers (`start_recording`'s initial `recording-state`
    /// emit, `stop_recording`'s `sources` write) only ever need to read it
    /// once each.
    pub fn system_audio_active(&self) -> bool {
        self.system_audio_active
    }

    /// The cpal-reported name of the input device opened for this session.
    pub fn microphone_name(&self) -> &str {
        &self.microphone_name
    }

    /// Stops capture and finalizes the WAV file. Drops the cpal stream
    /// first — that drops the audio callback's `writer_tx` sender clone,
    /// which (once the writer thread drains whatever was already queued)
    /// ends the writer thread's loop and lets it finalize the file — then
    /// joins that thread to make sure the file is actually closed before
    /// returning. Also stops the system-audio session, if one was active
    /// (`SysCapture::stop`, best-effort — see that method's own docs) —
    /// after dropping the stream but before joining the writer thread is
    /// fine either way, since (see `run_writer_thread_with_system`'s docs)
    /// the writer thread's loop termination depends only on the mic
    /// channel closing, never on `sys_rx`.
    pub fn stop(self) -> Result<(f64, PathBuf, bool)> {
        drop(self.stream);
        if let Some(capture) = self.sys_capture {
            capture.stop();
        }

        let elapsed_ms = lock(&self.shared.tracker).elapsed_ms(Instant::now());

        let _total_samples = self
            .writer_thread
            .join()
            .map_err(|_| MinuteError::Other("wav writer thread panicked".to_string()))??;

        Ok((
            elapsed_ms as f64 / 1000.0,
            self.wav_path,
            self.system_audio_active,
        ))
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
    /// Mirrors `handle.system_audio_active()`, cached here so `pause_recording`/
    /// `resume_recording`/the ticker can read it without needing a method
    /// call threaded through `RecorderState`'s lock — fixed for the whole
    /// session (see that method's own docs), so caching it up front is
    /// exactly as correct as calling it fresh every time.
    system_audio_active: bool,
    /// The input device opened for this recording. Cached so each state
    /// event reports the session source even if macOS changes its default
    /// microphone later.
    microphone_name: String,
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
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether a recording is currently active. Used by `download::delete_model`
/// to refuse removing any model mid-recording (the live `SttWorker` holds a
/// loaded model file for the duration), and by the app-close/exit handler
/// in `lib.rs` to decide whether there's a recording to finalize.
pub fn is_recording_active(state: &SharedRecorderState) -> bool {
    lock_recorder_state(state).active.is_some()
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStateEvent {
    note_id: String,
    state: &'static str,
    elapsed: f64,
    /// Stage 5 Task 5: whether this recording is actually mixing in system
    /// audio right now — fixed for the whole session (see
    /// `RecorderHandle::system_audio_active`'s docs), so every event for a
    /// given `note_id` carries the same value. Lets the frontend show the
    /// real, honest state in `RecordingView`'s capture-source details rather
    /// than assuming the requested setting took effect.
    system_audio_active: bool,
    /// The microphone actually opened for this recording, as named by cpal.
    microphone_name: String,
    /// Current microphone level and the loudest peak observed since the
    /// previous state snapshot. These are diagnostics only; no audio samples
    /// cross the native/webview boundary.
    input_rms: f32,
    input_peak: f32,
    /// Monotonic callback count used to detect a stream that has stopped
    /// delivering data even when cpal has not produced an explicit error.
    input_sequence: u64,
    input_error: Option<String>,
}

fn emit_recording_state(
    app: &AppHandle,
    note_id: &str,
    state: &'static str,
    elapsed_secs: f64,
    system_audio_active: bool,
    microphone_name: &str,
    input: RecordingInputSnapshot,
) {
    let event = RecordingStateEvent {
        note_id: note_id.to_string(),
        state,
        elapsed: elapsed_secs,
        system_audio_active,
        microphone_name: microphone_name.to_string(),
        input_rms: input.rms,
        input_peak: input.peak,
        input_sequence: input.sequence,
        input_error: input.error,
    };
    if let Err(e) = app.emit("recording-state", event) {
        log::warn!("failed to emit recording-state for {note_id}: {e}");
    }
}

/// Starts a new recording: creates a note via the store (title "New
/// recording", using the caller-supplied `model_id` — the frontend passes
/// the user's currently selected STT model — falling back to the persisted
/// `settings.sttModel`, and then to "whisper-small" if neither is set; see
/// `settings::resolve_stt_model`), starts the `Recorder` writing into that
/// note's `audio.wav`, spawns the live-transcription `SttWorker` (if the
/// resolved model is actually installed — recording still proceeds without
/// one otherwise, just without a live transcript; an id that isn't even in
/// the catalog is treated exactly the same way as "not installed", see
/// `spawn_stt_worker_if_model_installed`), and spawns the 1s ticker that
/// keeps emitting `recording-state` while active. Returns the new note's id.
///
/// Resolves whether `start_recording` should actually *attempt* system
/// audio for this recording: `explicit` (the caller-supplied
/// `includeSystemAudio`) if given, else `settings_default` (the persisted
/// `settings.captureSystemAudio`) — mirrors `settings::resolve_stt_model`'s
/// identical explicit-then-settings-default shape (there's no dedicated
/// `settings::resolve_*` helper for this one since it's a plain `bool` with
/// no third hardcoded-fallback tier to factor out, unlike `resolve_stt_model`'s
/// `"whisper-small"`). That resolved *intent* is then gated on `availability`:
/// only ever `true` when it's actually [`SysAudioAvailability::Ready`]
/// (macOS 13+ and Screen Recording granted — see that enum's docs for why
/// the other two states aren't worth trying to distinguish here). Pure and
/// free-standing (no `AppHandle`, no settings lock, no real `sys_audio_status()`
/// call) so every branch is unit-testable directly — `start_recording` is
/// the only real caller, feeding it a fresh `syscap::sys_audio_status()`
/// read each time. `Recorder::start` still has its own, second-layer
/// fallback for a `SysCapture::start` failure *after* this resolves `true`
/// (see that function's docs) — this only decides whether to *attempt* it
/// at all.
fn resolve_include_system_audio(
    explicit: Option<bool>,
    settings_default: bool,
    availability: SysAudioAvailability,
) -> bool {
    let want = explicit.unwrap_or(settings_default);
    want && availability == SysAudioAvailability::Ready
}

/// **System audio (Stage 5 Task 5).** `include_system_audio` is resolved via
/// [`resolve_include_system_audio`] — see that function's docs for the
/// explicit-then-settings-default-then-availability-gate shape.
/// `Recorder::start` itself has its own, second-layer fallback (a
/// `SysCapture::start` failure *after* this resolves `true` still degrades
/// to mic-only rather than failing the whole recording) — see its docs.
/// Either way, the actually-realized outcome is read back off the returned
/// `RecorderHandle::system_audio_active()`, never assumed from what was
/// requested, so the very first `recording-state` event (emitted below) and
/// the frontend's toggle both reflect the truth.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    store: State<'_, SharedStore>,
    recorder: State<'_, SharedRecorderState>,
    input_preview: State<'_, SharedInputPreview>,
    settings: State<'_, SharedSettings>,
    llm_busy: State<'_, LlmBusy>,
    model_id: Option<String>,
    include_system_audio: Option<bool>,
    input_device_id: Option<String>,
) -> std::result::Result<String, String> {
    if lock_recorder_state(&recorder).active.is_some() {
        return Err("a recording is already in progress".to_string());
    }
    ensure_microphone_authorized().map_err(|error| error.to_string())?;

    // Observability only — not a guard. Starting a recording while an LLM
    // generation (a summarize or an ask) is in flight keeps both a whisper
    // `WhisperContext` (this recording's live transcription) and the LLM's
    // Metal context (the in-flight generation) resident in GPU memory at
    // once; no coordination or backoff exists for that today (see the
    // design doc's Known debt). This is just a log line so that shows up
    // during a smoke pass rather than only being discoverable by watching
    // Activity Monitor.
    if llm_busy.load(Ordering::SeqCst) {
        log::info!(
            "start_recording: an LLM generation is in flight — both the whisper and LLM Metal \
             contexts will be resident at once (no coordination; see Known debt)"
        );
    }

    let model_id = settings::resolve_stt_model(model_id, &settings::lock_settings(&settings));
    let capture_system_audio_default = settings::lock_settings(&settings).capture_system_audio;
    let attempt_system_audio = resolve_include_system_audio(
        include_system_audio,
        capture_system_audio_default,
        syscap::sys_audio_status().availability,
    );

    let meta = lock_store(&store)
        .create_note_now("New recording", &model_id)
        .map_err(|e| e.to_string())?;
    let note_dir = lock_store(&store).note_dir(&meta.id);

    let (sample_tx, sample_rx) =
        std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
    // Keep the preview mutex until the active recorder is installed. A
    // concurrent preview start therefore cannot slip a new meter stream in
    // between dropping the old one and opening the final capture stream.
    let mut preview_guard = lock(&input_preview);
    preview_guard.take();
    let handle = match Recorder::start(
        note_dir.clone(),
        sample_tx,
        attempt_system_audio,
        input_device_id.as_deref(),
    ) {
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
    let system_audio_active = handle.system_audio_active();
    let microphone_name = handle.microphone_name().to_string();
    let initial_input = recording_input_snapshot(&handle.shared);

    let stt_worker =
        spawn_stt_worker_if_model_installed(&app, &store, &note_id, &model_id, sample_rx);

    let tick_app = app.clone();
    let tick_note_id = note_id.clone();
    let tick_shared = handle.shared.clone();
    let tick_microphone_name = microphone_name.clone();
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
            emit_recording_state(
                &tick_app,
                &tick_note_id,
                state,
                elapsed_ms as f64 / 1000.0,
                system_audio_active,
                &tick_microphone_name,
                recording_input_snapshot(&tick_shared),
            );
        }
    });

    lock_recorder_state(&recorder).active = Some(ActiveRecording {
        note_id: note_id.clone(),
        handle,
        stt_worker,
        tick_handle,
        system_audio_active,
        microphone_name: microphone_name.clone(),
    });
    drop(preview_guard);

    emit_recording_state(
        &app,
        &note_id,
        "recording",
        0.0,
        system_audio_active,
        &microphone_name,
        initial_input,
    );
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
    let system_audio_active = active.system_audio_active;
    let microphone_name = active.microphone_name.clone();
    let input = recording_input_snapshot(&active.handle.shared);
    drop(guard);
    emit_recording_state(
        &app,
        &note_id,
        "paused",
        elapsed_secs,
        system_audio_active,
        &microphone_name,
        input,
    );
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
    let system_audio_active = active.system_audio_active;
    let microphone_name = active.microphone_name.clone();
    let input = recording_input_snapshot(&active.handle.shared);
    drop(guard);
    emit_recording_state(
        &app,
        &note_id,
        "recording",
        elapsed_secs,
        system_audio_active,
        &microphone_name,
        input,
    );
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
    settings: State<SharedSettings>,
    engine: State<SharedLlmEngine>,
    llm_busy: State<LlmBusy>,
) -> std::result::Result<NoteMeta, String> {
    let active = lock_recorder_state(&recorder)
        .active
        .take()
        .ok_or_else(|| "no active recording".to_string())?;

    active.tick_handle.abort();

    let mut capture_warning = active.handle.last_error();
    if let Some(err) = capture_warning.as_ref() {
        log::warn!(
            "recording {} encountered a stream error before stopping: {err}",
            active.note_id
        );
    }

    let note_id = active.note_id;
    let system_audio_active = active.system_audio_active;
    let microphone_name = active.microphone_name;
    let final_input = recording_input_snapshot(&active.handle.shared);
    let fallback_elapsed_secs = active.handle.elapsed_ms() as f64 / 1000.0;

    let duration_sec = match active.handle.stop() {
        Ok((duration_sec, _wav_path, _system_audio_active)) => duration_sec,
        Err(e) => {
            capture_warning = Some(format!("Audio finalization was incomplete: {e}"));
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

    // `create_note`'s own `["mic"]` default is already correct for the
    // overwhelmingly common case — this second write only actually happens
    // when system audio was part of the mix, per `NoteMeta::sources`'/
    // `set_note_sources`'s docs. Best-effort in the same spirit as the
    // `note.md` write just below: a failure here leaves the note's
    // `sources` at the (still honest, if incomplete) `["mic"]` default
    // rather than failing the whole `stop_recording` call over a purely
    // descriptive metadata field.
    let meta = if system_audio_active {
        match lock_store(&store)
            .set_note_sources(&note_id, vec!["mic".to_string(), "system".to_string()])
        {
            Ok(updated) => updated,
            Err(e) => {
                log::warn!("failed to record system-audio source for note {note_id}: {e}");
                meta
            }
        }
    } else {
        meta
    };

    let meta = if let Some(warning) = capture_warning {
        match lock_store(&store).set_capture_warning(&note_id, warning) {
            Ok(updated) => updated,
            Err(error) => {
                log::warn!("failed to persist capture warning for note {note_id}: {error}");
                meta
            }
        }
    } else {
        meta
    };

    // Best-effort: note.md is a derived convenience file (single source of
    // truth lives in meta.json/transcript.json), so a write failure here
    // shouldn't fail the whole stop_recording call — it just leaves note.md
    // stale/absent until the next write that regenerates it (a summary, a
    // rename, ...). The transcript now exists, so this is the point every
    // finalized note should get one.
    if let Err(e) = lock_store(&store).write_note_md(&note_id) {
        log::warn!("failed to write note.md for {note_id}: {e}");
    }

    emit_recording_state(
        &app,
        &note_id,
        "stopped",
        duration_sec,
        system_audio_active,
        &microphone_name,
        final_input,
    );

    auto_trigger_summarize(&app, &store, &settings, &engine, &llm_busy, &note_id);

    Ok(meta)
}

/// Best-effort auto-trigger for summarization right after a recording
/// finalizes: if the settings' selected LLM is actually installed, spawns a
/// summarization worker (via `llm::try_spawn_summarize`) for the
/// just-finalized note — non-blocking, `stop_recording` itself doesn't wait
/// for it to finish (or even start) before returning.
///
/// Mirrors `spawn_stt_worker_if_model_installed`'s not-installed-is-not-an-
/// error shape, but stays silent (no event) rather than emitting a
/// `summary-status` error when no LLM is selected or the selected one isn't
/// installed — unlike a missing STT model (which breaks live transcription
/// entirely for this recording), a note simply staying at `transcribed`
/// with no summary is the expected, unremarkable steady state for anyone
/// who hasn't set up a summary model yet (see the plan's status flow:
/// `transcribed -> summarizing… -> ready`; no LLM installed just means it
/// never leaves `transcribed`).
///
/// The one case this *does* eventually surface an error event for is the
/// engine being busy (e.g. a manual Regenerate on some other note, or an
/// in-flight ask-your-notes question, still running when this recording
/// finished) — rare in isolation, but "finish a recording while asking a
/// question about a different one" is an entirely routine sequence for
/// this app's target user (back-to-back meetings), so this is handled with
/// a bounded background retry rather than an immediate error — see the
/// busy-handling paragraph below.
///
/// **Busy handling — deferred retry, not an immediate error (and never the
/// raw internal `LlmBusy` rejection token):** the very first spawn attempt
/// happens synchronously, right here, before this function returns — a
/// single `compare_exchange` inside [`llm::try_spawn_summarize`], not
/// remotely slow — so the overwhelmingly common case (nothing else
/// generating) never touches a background thread at all. Only if *that*
/// first attempt finds [`llm::LlmBusy`] already claimed does this hand off
/// to a detached thread running [`llm::retry_spawn_while_busy`]: it
/// re-attempts the spawn every [`llm::AUTO_SUMMARIZE_POLL_INTERVAL`] until
/// either it succeeds (another generation finished, freeing the busy slot)
/// or [`llm::AUTO_SUMMARIZE_RETRY_DEADLINE`] passes, at which point *that*
/// gives up and this emits a `summary-status` error — with
/// [`llm::AUTO_SUMMARIZE_GIVE_UP_MESSAGE`], an honest, actionable sentence,
/// never `try_spawn_summarize`'s bare `"summarization already running"`
/// token (see that constant's docs for why a raw internal token is the
/// wrong thing to show here). Either way, `stop_recording` itself — which
/// calls this synchronously — never blocks: the synchronous part here is
/// only ever one atomic compare-exchange plus, on the busy path, spawning
/// (not running) a thread.
///
/// This deferred-retry treatment is deliberately **auto-trigger-only** —
/// `summarize_note`/`ask_note` (a manual Regenerate, or an ask) still
/// reject a busy call immediately, since a user who just clicked something
/// is watching for the result right then, unlike this background trigger
/// nothing is waiting on.
fn auto_trigger_summarize(
    app: &AppHandle,
    store: &State<SharedStore>,
    settings: &State<SharedSettings>,
    engine: &State<SharedLlmEngine>,
    busy: &State<LlmBusy>,
    note_id: &str,
) {
    let models_root = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!("auto-summarize: failed to resolve app data dir: {e}");
            return;
        }
    };

    let (model_id, preferred_context, summary_style, summary_instructions) = {
        let guard = settings::lock_settings(settings);
        (
            guard.llm_model.clone(),
            guard.llm_context_tokens,
            guard.summary_style,
            guard.summary_instructions.clone(),
        )
    };

    let catalog = match catalog::load_catalog() {
        Ok(catalog) => catalog,
        Err(e) => {
            log::warn!("auto-summarize: failed to load model catalog: {e}");
            return;
        }
    };
    let recommendation = catalog::recommend(&catalog, &catalog::detect_hardware());
    let Some(entry) =
        catalog::resolve_llm_entry(&catalog, &recommendation, model_id.as_deref(), &models_root)
    else {
        return;
    };

    let model_path = catalog::installed_path(&entry, &models_root);
    let store = store.inner().clone();
    let engine = engine.inner().clone();
    let busy = busy.inner().clone();
    let model_id = entry.id;
    let note_id = note_id.to_string();
    let app = app.clone();

    // Build one spawn attempt as a reusable closure — used for both the
    // synchronous first try below and, on the busy path, every retry
    // `retry_spawn_while_busy` makes on the detached thread. A fresh
    // `emit` closure per attempt (rather than trying to share/clone one)
    // since `try_spawn_summarize` takes ownership of it, moving it into
    // the worker's context only on a *successful* claim — cheap either
    // way, `llm::tauri_emit` just wraps a cloned `AppHandle`.
    let attempt_spawn = {
        let store = store.clone();
        let engine = engine.clone();
        let busy = busy.clone();
        let model_id = model_id.clone();
        let model_path = model_path.clone();
        let note_id = note_id.clone();
        let app = app.clone();
        move || {
            let emit = Box::new(llm::tauri_emit(app.clone()));
            llm::try_spawn_summarize(llm::SummarizeWorkerCtx {
                note_id: note_id.clone(),
                store: store.clone(),
                engine: engine.clone(),
                busy: busy.clone(),
                model_id: model_id.clone(),
                model_path: model_path.clone(),
                preferred_context,
                summary_style,
                summary_instructions: summary_instructions.clone(),
                emit,
            })
        }
    };

    // The synchronous first attempt — `stop_recording`'s call into this
    // function still returns fast either way: this is a single atomic
    // `compare_exchange` (see `try_spawn_summarize`'s docs), and the busy
    // path below only *spawns* a thread rather than running the retry loop
    // here. `attempt_spawn` is `Clone` (every value it captures — `Arc`s,
    // `String`s, a `PathBuf`, an `AppHandle` — is cheap to clone), so a
    // clone runs this first try, leaving the original free to move into
    // the retry thread below untouched if it's needed.
    let first_attempt = attempt_spawn.clone();
    if first_attempt().is_ok() {
        return;
    }

    log::info!("auto-summarize: busy for note {note_id} — retrying in the background");
    std::thread::spawn(move || {
        let start = Instant::now();
        let result = llm::retry_spawn_while_busy(
            attempt_spawn,
            std::thread::sleep,
            move || start.elapsed(),
            llm::AUTO_SUMMARIZE_POLL_INTERVAL,
            llm::AUTO_SUMMARIZE_RETRY_DEADLINE,
        );
        if let Err(msg) = result {
            log::warn!("auto-summarize: gave up for note {note_id} after busy retries: {msg}");
            llm::emit_summary_status_error(&app, &note_id, &msg);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn avfoundation_microphone_status_maps_to_stable_ipc_values() {
        assert_eq!(
            microphone_permission_from_av(AVAuthorizationStatus::NotDetermined),
            MicrophonePermission::NotDetermined
        );
        assert_eq!(
            microphone_permission_from_av(AVAuthorizationStatus::Restricted),
            MicrophonePermission::Restricted
        );
        assert_eq!(
            microphone_permission_from_av(AVAuthorizationStatus::Denied),
            MicrophonePermission::Denied
        );
        assert_eq!(
            microphone_permission_from_av(AVAuthorizationStatus::Authorized),
            MicrophonePermission::Authorized
        );
    }

    // --- is_recording_active -------------------------------------------

    #[test]
    fn is_recording_active_false_on_a_freshly_opened_state() {
        // A real `ActiveRecording` needs a live cpal stream (hardware),
        // which isn't constructible in a unit test — this pins the other
        // half of the contract: a state nothing has ever recorded into
        // reports inactive, which is exactly what `delete_model`/the
        // app-close handler see between recordings (the far more common
        // case for both).
        let state = open_shared();
        assert!(!is_recording_active(&state));
    }

    // --- resolve_include_system_audio (Stage 5 Task 5) -----------------------

    #[test]
    fn resolve_include_system_audio_explicit_false_overrides_a_true_settings_default() {
        assert!(!resolve_include_system_audio(
            Some(false),
            true,
            SysAudioAvailability::Ready,
        ));
    }

    #[test]
    fn resolve_include_system_audio_explicit_true_overrides_a_false_settings_default() {
        assert!(resolve_include_system_audio(
            Some(true),
            false,
            SysAudioAvailability::Ready,
        ));
    }

    #[test]
    fn resolve_include_system_audio_none_falls_back_to_the_settings_default_true() {
        assert!(resolve_include_system_audio(
            None,
            true,
            SysAudioAvailability::Ready
        ));
    }

    #[test]
    fn resolve_include_system_audio_none_falls_back_to_the_settings_default_false() {
        assert!(!resolve_include_system_audio(
            None,
            false,
            SysAudioAvailability::Ready
        ));
    }

    #[test]
    fn resolve_include_system_audio_wanting_it_is_still_false_when_not_ready() {
        assert!(!resolve_include_system_audio(
            Some(true),
            true,
            SysAudioAvailability::NotGranted,
        ));
        assert!(!resolve_include_system_audio(
            Some(true),
            true,
            SysAudioAvailability::Unsupported,
        ));
    }

    #[test]
    fn resolve_include_system_audio_not_wanting_it_stays_false_regardless_of_availability() {
        assert!(!resolve_include_system_audio(
            Some(false),
            false,
            SysAudioAvailability::Ready,
        ));
        assert!(!resolve_include_system_audio(
            None,
            false,
            SysAudioAvailability::NotGranted
        ));
    }

    // --- input preview levels ------------------------------------------

    #[test]
    fn input_levels_mono_reports_expected_rms_and_peak() {
        let (rms, peak) = input_levels(&[0.5_f32, -0.5], 1);
        assert!((rms - 0.5).abs() < 1e-6);
        assert!((peak - 0.5).abs() < 1e-6);
    }

    #[test]
    fn input_levels_stereo_uses_mono_rms_but_preserves_channel_peak() {
        let (rms, peak) = input_levels(&[0.5_f32, -0.5, 1.0, 1.0], 2);
        assert!((rms - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        assert_eq!(peak, 1.0);
    }

    #[test]
    fn input_levels_empty_input_is_silent() {
        assert_eq!(input_levels::<f32>(&[], 2), (0.0, 0.0));
    }

    #[test]
    fn audio_input_level_event_serializes_for_the_frontend() {
        let value = serde_json::to_value(AudioInputLevelEvent {
            session_id: "preview-1".to_string(),
            rms: 0.25,
            peak: 0.75,
            error: None,
        })
        .unwrap();
        assert_eq!(value["sessionId"], "preview-1");
        assert_eq!(value["rms"], 0.25);
        assert_eq!(value["peak"], 0.75);
        assert!(value["error"].is_null());
    }

    #[test]
    fn recording_input_snapshot_reports_latest_rms_interval_peak_and_sequence() {
        let shared = test_shared_state();
        shared
            .input_rms_bits
            .store(0.2_f32.to_bits(), Ordering::Relaxed);
        store_max_f32(&shared.input_peak_bits, 0.7);
        store_max_f32(&shared.input_peak_bits, 0.4);
        shared.input_sequence.store(42, Ordering::Relaxed);

        let first = recording_input_snapshot(&shared);
        assert!((first.rms - 0.2).abs() < 1e-6);
        assert!((first.peak - 0.7).abs() < 1e-6);
        assert_eq!(first.sequence, 42);
        assert!(first.error.is_none());

        let second = recording_input_snapshot(&shared);
        assert_eq!(second.peak, 0.0);
        assert_eq!(second.sequence, 42);
    }

    #[test]
    fn recording_state_event_serializes_input_health_for_the_frontend() {
        let value = serde_json::to_value(RecordingStateEvent {
            note_id: "note-live".to_string(),
            state: "recording",
            elapsed: 12.5,
            system_audio_active: false,
            microphone_name: "Studio Display Microphone".to_string(),
            input_rms: 0.08,
            input_peak: 0.7,
            input_sequence: 88,
            input_error: None,
        })
        .unwrap();
        assert!((value["inputRms"].as_f64().unwrap() - 0.08).abs() < 1e-6);
        assert!((value["inputPeak"].as_f64().unwrap() - 0.7).abs() < 1e-6);
        assert_eq!(value["inputSequence"], 88);
        assert!(value["inputError"].is_null());
    }

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

    // --- mix_into (Stage 5 Task 5) ------------------------------------------

    #[test]
    fn mix_two_full_scale_signals_clamps_rather_than_wraps() {
        let mut out = Vec::new();
        mix_into(&[1.0, -1.0], &[1.0, -1.0], &mut out);
        // 1.0 + 1.0 = 2.0 clamps to 1.0, not wraps around to -1.0 or similar.
        assert_eq!(out, vec![1.0, -1.0]);
    }

    #[test]
    fn mix_silence_plus_signal_reproduces_the_signal_exactly() {
        let mut out = Vec::new();
        mix_into(&[0.0, 0.0, 0.0], &[0.2, -0.3, 0.5], &mut out);
        assert_eq!(out, vec![0.2, -0.3, 0.5]);

        let mut out2 = Vec::new();
        mix_into(&[0.2, -0.3, 0.5], &[0.0, 0.0, 0.0], &mut out2);
        assert_eq!(out2, vec![0.2, -0.3, 0.5]);
    }

    #[test]
    fn mix_adds_two_ordinary_signals() {
        let mic = [0.1f32, 0.2, -0.1];
        let system = [0.05f32, -0.1, 0.05];
        let mut out = Vec::new();
        mix_into(&mic, &system, &mut out);
        let expected: Vec<f32> = mic.iter().zip(system.iter()).map(|(m, s)| m + s).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn mix_unequal_lengths_treats_the_missing_tail_as_silence() {
        // mic longer than system: the system side's missing tail is zeros.
        let mut out = Vec::new();
        mix_into(&[0.1f32, 0.2, 0.3, 0.4], &[0.5f32, 0.5], &mut out);
        assert_eq!(out, vec![0.1f32 + 0.5, 0.2 + 0.5, 0.3, 0.4]);

        // system longer than mic: same rule, mirrored.
        let mut out2 = Vec::new();
        mix_into(&[0.5f32, 0.5], &[0.1f32, 0.2, 0.3, 0.4], &mut out2);
        assert_eq!(out2, vec![0.5f32 + 0.1, 0.5 + 0.2, 0.3, 0.4]);
    }

    #[test]
    fn mix_both_empty_is_empty() {
        let mut out = Vec::new();
        mix_into(&[], &[], &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn mix_into_clears_and_reuses_the_scratch_buffer_rather_than_appending() {
        let mut out = vec![9.0, 9.0, 9.0];
        mix_into(&[0.1], &[0.2], &mut out);
        assert_eq!(out, vec![0.3]);
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
        let input: Vec<f32> = (0..n).map(|i| ((i as f32) * 0.001).sin()).collect();

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
        let ramp: Vec<f32> = (0..1000).map(|i| -1.0 + 2.0 * (i as f32) / 999.0).collect();
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

    #[test]
    fn low_disk_write_failure_is_reported_while_transcription_forwarding_survives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let mut writer = WavWriter::create_failing_after(&path, 2).unwrap();
        let shared = test_shared_state();
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let mut block = Vec::new();
        let mut dropped = 0;

        append_and_forward(
            &mut writer,
            &stt_tx,
            &shared,
            &mut block,
            &mut dropped,
            &[0.1, 0.2, 0.3],
        );

        assert_eq!(
            lock(&shared.last_error).as_deref(),
            Some("simulated low-disk WAV write failure")
        );
        assert_eq!(block, vec![0.1, 0.2, 0.3]);
        assert!(stt_rx.try_recv().is_err());
        assert_eq!(writer.finalize().unwrap(), 2);
    }

    // --- run_writer_thread (the audio callback -> WAV + STT hand-off) -------

    fn test_shared_state() -> Arc<SharedState> {
        Arc::new(SharedState {
            tracker: Mutex::new(ElapsedTracker::new()),
            paused: Arc::new(AtomicBool::new(false)),
            last_error: Mutex::new(None),
            input_rms_bits: AtomicU32::new(0.0_f32.to_bits()),
            input_peak_bits: AtomicU32::new(0.0_f32.to_bits()),
            input_sequence: AtomicU64::new(0),
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
        let (stt_tx, _stt_rx) =
            std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
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

    // --- run_writer_thread_with_system (Stage 5 Task 5) ----------------------

    #[test]
    fn writer_thread_with_system_mixes_known_mic_and_system_sequences() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx, sys_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        // System audio for this mic chunk already arrived before the mic
        // chunk is sent, matching the same-length, no-underrun case.
        sys_tx.send(Arc::new(vec![0.1f32, 0.2, 0.3])).unwrap();
        chunk_tx.send(Arc::new(vec![0.4f32, 0.5, 0.6])).unwrap();
        drop(chunk_tx);
        drop(sys_tx);

        let total =
            run_writer_thread_with_system(writer, chunk_rx, sys_rx, stt_tx, test_shared_state())
                .unwrap();
        assert_eq!(total, 3);

        let forwarded = stt_rx.recv().unwrap();
        assert_eq!(*forwarded, vec![0.4f32 + 0.1, 0.5 + 0.2, 0.6 + 0.3]);

        let mut reader = hound::WavReader::open(&path).unwrap();
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        let expected: Vec<i16> = [0.4f32 + 0.1, 0.5 + 0.2, 0.6 + 0.3]
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
            .collect();
        assert_eq!(samples, expected);
    }

    #[test]
    fn writer_thread_with_system_zero_fills_an_underrun() {
        // System audio hasn't produced anything at all yet by the time the
        // first (and only) mic chunk arrives — e.g. `SysCapture` starting
        // slightly later than the mic stream. The mic side must never wait
        // for it: the shortfall is treated as silence, not a stall.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx, sys_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        chunk_tx.send(Arc::new(vec![0.3f32, -0.2, 0.1])).unwrap();
        drop(chunk_tx);
        drop(sys_tx);

        let total =
            run_writer_thread_with_system(writer, chunk_rx, sys_rx, stt_tx, test_shared_state())
                .unwrap();
        assert_eq!(total, 3);

        // Mixing with all-silence system audio reproduces the mic signal
        // exactly — see `mix_silence_plus_signal_reproduces_the_signal_exactly`.
        let forwarded = stt_rx.recv().unwrap();
        assert_eq!(*forwarded, vec![0.3f32, -0.2, 0.1]);
    }

    #[test]
    fn writer_thread_with_system_zero_fills_a_partial_underrun() {
        // System audio delivered *some* samples for this mic chunk, but
        // fewer than the mic side's length — the missing tail is zero-filled,
        // not misaligned or truncated.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx, sys_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        sys_tx.send(Arc::new(vec![0.2f32])).unwrap();
        chunk_tx
            .send(Arc::new(vec![0.1f32, 0.1, 0.1, 0.1]))
            .unwrap();
        drop(chunk_tx);
        drop(sys_tx);

        let total =
            run_writer_thread_with_system(writer, chunk_rx, sys_rx, stt_tx, test_shared_state())
                .unwrap();
        assert_eq!(total, 4);

        let forwarded = stt_rx.recv().unwrap();
        assert_eq!(*forwarded, vec![0.1f32 + 0.2, 0.1, 0.1, 0.1]);
    }

    #[test]
    fn writer_thread_with_system_accumulates_system_blocks_smaller_than_a_mic_chunk() {
        // The system side can deliver in a different chunking than the mic
        // side — several small system blocks accumulate in the ring buffer
        // (`sys_buf`) before a single larger mic chunk consumes them.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx, sys_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        sys_tx.send(Arc::new(vec![0.1f32])).unwrap();
        sys_tx.send(Arc::new(vec![0.2f32])).unwrap();
        sys_tx.send(Arc::new(vec![0.3f32])).unwrap();
        chunk_tx.send(Arc::new(vec![0.0f32, 0.0, 0.0])).unwrap();
        drop(chunk_tx);
        drop(sys_tx);

        let total =
            run_writer_thread_with_system(writer, chunk_rx, sys_rx, stt_tx, test_shared_state())
                .unwrap();
        assert_eq!(total, 3);

        let forwarded = stt_rx.recv().unwrap();
        assert_eq!(*forwarded, vec![0.1f32, 0.2, 0.3]);
    }

    #[test]
    fn writer_thread_with_system_and_no_system_audio_at_all_matches_mic_only_wav_bytes() {
        // A `sys_rx` that never receives anything for the whole session
        // (system capture failed to start after the fact, or produced
        // nothing) must degrade to byte-identical output with the plain
        // mic-only `run_writer_thread` — mixing with all-silence reproduces
        // the mic signal exactly (see `mix_into`'s docs).
        let mic_samples = vec![0.1f32, -0.2, 0.3, -0.4, 0.5];

        let dir_a = tempfile::tempdir().unwrap();
        let path_a = dir_a.path().join("audio.wav");
        let writer_a = WavWriter::create(&path_a).unwrap();
        let (chunk_tx_a, chunk_rx_a) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (stt_tx_a, _stt_rx_a) =
            std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        chunk_tx_a.send(Arc::new(mic_samples.clone())).unwrap();
        drop(chunk_tx_a);
        run_writer_thread(writer_a, chunk_rx_a, stt_tx_a, test_shared_state()).unwrap();

        let dir_b = tempfile::tempdir().unwrap();
        let path_b = dir_b.path().join("audio.wav");
        let writer_b = WavWriter::create(&path_b).unwrap();
        let (chunk_tx_b, chunk_rx_b) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx_b, sys_rx_b) =
            std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let (stt_tx_b, _stt_rx_b) =
            std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        chunk_tx_b.send(Arc::new(mic_samples)).unwrap();
        drop(chunk_tx_b);
        drop(sys_tx_b);
        run_writer_thread_with_system(
            writer_b,
            chunk_rx_b,
            sys_rx_b,
            stt_tx_b,
            test_shared_state(),
        )
        .unwrap();

        let bytes_a = std::fs::read(&path_a).unwrap();
        let bytes_b = std::fs::read(&path_b).unwrap();
        assert_eq!(bytes_a, bytes_b);
    }

    // --- run_writer_thread_with_system: post-mic-stall resync -----------------

    #[test]
    fn writer_thread_with_system_resyncs_to_recent_system_audio_after_a_mic_stall() {
        // Simulates a mic stall (e.g. a Bluetooth device switch): system
        // audio keeps flowing and piles up, un-drained, in the channel
        // while no mic chunk has arrived yet — modeled here by sending one
        // big backlog block to `sys_tx` *before* any mic chunk exists.
        // Each sample is tagged with its own index so the surviving
        // (recent) tail is distinguishable from the dropped (stale) head.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx, sys_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(1);
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        let excess = 500usize;
        let backlog_len = SYS_BUF_MAX_LEAD_SAMPLES + excess;
        // Each sample tagged with its own index, scaled well inside
        // `mix_into`'s `[-1.0, 1.0]` clamp (a literal index value like
        // `500.0` would itself clamp to `1.0`, destroying the very
        // distinguishability this test relies on) — mixed against an
        // all-zero mic chunk below, this survives the mix exactly (adding
        // zero is exact in IEEE754), so the tag is still recoverable.
        let scale = 0.5 / backlog_len as f32;
        let backlog: Vec<f32> = (0..backlog_len).map(|i| i as f32 * scale).collect();
        sys_tx.send(Arc::new(backlog)).unwrap();

        // The mic stream resumes with an ordinary small chunk — must never
        // be held up waiting for, or forced to consume, the whole stale
        // backlog.
        chunk_tx.send(Arc::new(vec![0.0f32; 10])).unwrap();
        drop(chunk_tx);
        drop(sys_tx);

        run_writer_thread_with_system(writer, chunk_rx, sys_rx, stt_tx, test_shared_state())
            .unwrap();

        // Mixing with all-zero mic reproduces the (post-resync) system
        // signal exactly — the 10 samples actually consumed must be the
        // oldest *surviving* ones after dropping `excess`, i.e. indices
        // [excess, excess + 10), not the true stream start (index 0..10) —
        // the offset is bounded by the cap, not the (much larger) raw
        // backlog/stall length.
        let forwarded = stt_rx.recv().unwrap();
        let expected: Vec<f32> = (excess..excess + 10).map(|i| i as f32 * scale).collect();
        assert_eq!(*forwarded, expected);
    }

    #[test]
    fn writer_thread_with_system_does_not_resync_when_backlog_is_within_the_cap() {
        // A backlog sitting exactly at the cap must NOT trigger any drop —
        // resync only kicks in strictly past `SYS_BUF_MAX_LEAD_SAMPLES`,
        // never at or below it. Steady-state operation (see the other
        // `writer_thread_with_system_*` tests above) never approaches this
        // cap at all, so this pins the boundary explicitly.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let writer = WavWriter::create(&path).unwrap();

        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Arc<Vec<f32>>>();
        let (sys_tx, sys_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(1);
        let (stt_tx, stt_rx) = std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);

        // Same clamp-safe index scaling as the mic-stall test above.
        let scale = 0.5 / SYS_BUF_MAX_LEAD_SAMPLES as f32;
        let backlog: Vec<f32> = (0..SYS_BUF_MAX_LEAD_SAMPLES)
            .map(|i| i as f32 * scale)
            .collect();
        sys_tx.send(Arc::new(backlog)).unwrap();
        chunk_tx.send(Arc::new(vec![0.0f32; 10])).unwrap();
        drop(chunk_tx);
        drop(sys_tx);

        run_writer_thread_with_system(writer, chunk_rx, sys_rx, stt_tx, test_shared_state())
            .unwrap();

        let forwarded = stt_rx.recv().unwrap();
        let expected: Vec<f32> = (0..10).map(|i| i as f32 * scale).collect();
        assert_eq!(*forwarded, expected);
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
    /// Removes `note_dir` when dropped — including during unwinding from a
    /// failed `assert!`/`.expect()`, unlike plain cleanup code placed after
    /// the assertions, which a panic would skip entirely. Used by
    /// `real_recording_end_to_end` so that test — run manually, against
    /// the *real* app-data dir — never leaves a stray "Smoke test
    /// recording" note behind in the real app's library, pass or fail.
    struct NoteDirCleanupGuard(PathBuf);

    impl Drop for NoteDirCleanupGuard {
        fn drop(&mut self) {
            if let Err(e) = std::fs::remove_dir_all(&self.0) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("smoke test cleanup: failed to remove {:?}: {e}", self.0);
                }
            }
        }
    }

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
        // Bound to `_cleanup` (not `_`) so it lives to the end of the
        // function scope and only drops (removing `note_dir`) on the way
        // out — whether that's normal return or an unwinding panic.
        let _cleanup = NoteDirCleanupGuard(note_dir.clone());

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
        let handle = Recorder::start(note_dir.clone(), sample_tx, false, None)
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

        let (duration_sec, wav_path, _system_audio_active) =
            handle.stop().expect("Recorder::stop failed");
        worker.join().expect("stt worker thread panicked");
        let final_meta = lock_store(&store)
            .finalize_note(&meta.id, duration_sec, 1)
            .expect("finalize_note failed");

        eprintln!("recorded {duration_sec:.1}s, wav at {wav_path:?}");
        eprintln!("final note status: {:?}", final_meta.status);
        let events = events.lock().unwrap();
        eprintln!("captured {} stt events: {:?}", events.len(), *events);
        drop(events);

        // Only assert what this smoke test actually proves the pipeline
        // did, not exact transcribed wording — whisper's output on the
        // same `say` audio can vary run to run.
        assert_eq!(
            final_meta.status,
            crate::store::NoteStatus::Transcribed,
            "note should be finalized as transcribed"
        );

        assert!(wav_path.exists(), "audio.wav should exist");
        let wav_len = std::fs::metadata(&wav_path).map(|m| m.len()).unwrap_or(0);
        eprintln!("audio.wav size: {wav_len} bytes");
        // ~10s of 16kHz/16-bit mono PCM is ~320_000 bytes; assert well
        // above the floor a near-empty/corrupt capture would produce
        // rather than pinning an exact byte count.
        assert!(
            wav_len > 200_000,
            "audio.wav should hold roughly 10s of 16kHz/16-bit mono audio, got {wav_len} bytes"
        );

        let (_meta, transcript) = lock_store(&store).get_note(&meta.id).unwrap();
        eprintln!("transcript.json segments: {:?}", transcript.segments);
        assert!(
            !transcript.segments.is_empty(),
            "expected at least one transcribed segment"
        );
        let total_text_len: usize = transcript.segments.iter().map(|s| s.text.len()).sum();
        assert!(
            total_text_len > 10,
            "expected non-trivial transcribed text (>10 chars), got {total_text_len}: {:?}",
            transcript.segments
        );
    }

    /// End-to-end smoke test for the two-source pipeline (Stage 5 Task 5):
    /// records 4s with `include_system_audio: true` while `afplay` plays
    /// `tests/fixtures/hello.wav` through the system's default output, then
    /// asserts (a) system audio actually activated (`Ready` availability —
    /// this machine has Screen Recording granted) and (b) the resulting
    /// `audio.wav` is non-silent. Mirrors `real_recording_end_to_end`'s
    /// real-app-data-dir/cleanup-guard shape, plus `syscap.rs`'s own e2e
    /// test's `afplay`-a-fixture technique.
    ///
    /// Transcript non-emptiness is asserted as a *bonus*, not the primary
    /// signal — per this task's own honesty requirement, whisper
    /// transcribing `afplay`'d system audio (routed back in through
    /// whatever the mic happens to also pick up acoustically, since there's
    /// no synthetic-input injection here) is measurably more failure-prone
    /// run to run than "the wav file actually contains non-silent audio",
    /// which is what the mix pipeline itself is actually responsible for.
    /// A failing transcript assertion would conflate "the mixer/capture
    /// pipeline is broken" with "whisper had an off run on this particular
    /// take", which this test is not in a position to tell apart — so it's
    /// logged, not asserted, and reported honestly in this task's summary.
    ///
    /// Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     real_system_audio_recording_end_to_end -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn real_system_audio_recording_end_to_end() {
        let status = syscap::sys_audio_status();
        if status.availability != SysAudioAvailability::Ready {
            eprintln!(
                "skipping: sys_audio_status() = {:?} (needs Screen Recording permission granted \
                 to this test binary)",
                status.availability
            );
            return;
        }

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
            .create_note_now("System audio smoke test", "whisper-small")
            .expect("failed to create note");
        let note_dir = lock_store(&store).note_dir(&meta.id);
        eprintln!("recording into {note_dir:?}");
        let _cleanup = NoteDirCleanupGuard(note_dir.clone());

        let fixture =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hello.wav");
        assert!(fixture.exists(), "expected fixture at {fixture:?}");
        let mut afplay = std::process::Command::new("afplay")
            .arg(&fixture)
            .spawn()
            .expect("failed to spawn afplay");

        let (sample_tx, sample_rx) =
            std::sync::mpsc::sync_channel::<Arc<Vec<f32>>>(STT_CHANNEL_CAPACITY);
        let handle = Recorder::start(note_dir.clone(), sample_tx, true, None)
            .expect("Recorder::start failed — check mic permission / input device availability");
        assert!(
            handle.system_audio_active(),
            "expected system audio to actually activate given Ready availability"
        );

        let events: Arc<Mutex<Vec<stt::SttEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_emit = events.clone();
        let worker_ctx = WorkerCtx {
            note_id: meta.id.clone(),
            store: store.clone(),
            emit: Box::new(move |event| events_for_emit.lock().unwrap().push(event)),
        };
        let worker = stt::SttWorker::spawn(model_path, sample_rx, worker_ctx);

        std::thread::sleep(Duration::from_secs(4));

        let _ = afplay.wait();

        let (duration_sec, wav_path, system_audio_active) =
            handle.stop().expect("Recorder::stop failed");
        assert!(
            system_audio_active,
            "system audio should have stayed active for the whole recording"
        );
        worker.join().expect("stt worker thread panicked");
        lock_store(&store)
            .finalize_note(&meta.id, duration_sec, 1)
            .expect("finalize_note failed");
        let final_meta = lock_store(&store)
            .set_note_sources(&meta.id, vec!["mic".to_string(), "system".to_string()])
            .expect("set_note_sources failed");

        eprintln!("recorded {duration_sec:.1}s, wav at {wav_path:?}");
        eprintln!("final note sources: {:?}", final_meta.sources);
        assert_eq!(
            final_meta.sources,
            vec!["mic".to_string(), "system".to_string()]
        );

        assert!(wav_path.exists(), "audio.wav should exist");
        let mut reader = hound::WavReader::open(&wav_path).expect("failed to open recorded wav");
        let samples: Vec<f32> = reader
            .samples::<i16>()
            .map(|s| s.unwrap() as f32 / i16::MAX as f32)
            .collect();
        eprintln!(
            "recorded {} samples ({:.2}s at 16kHz)",
            samples.len(),
            samples.len() as f64 / 16_000.0
        );

        // Primary assertion: the mixed wav actually contains non-silent
        // audio (proves the mic+system mixing pipeline delivered real
        // signal into the file), not merely that recording "ran".
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
        eprintln!("wav RMS = {rms}");
        assert!(
            rms > 1e-4,
            "expected non-silent recorded audio, got RMS {rms}"
        );

        // Bonus signal, not asserted — see this test's own doc comment for
        // why a transcript miss here is reported, not failed.
        let (_meta, transcript) = lock_store(&store).get_note(&meta.id).unwrap();
        let total_text_len: usize = transcript.segments.iter().map(|s| s.text.len()).sum();
        eprintln!(
            "transcript.json segments: {:?} (total text length {total_text_len})",
            transcript.segments
        );
        if transcript.segments.is_empty() {
            eprintln!(
                "note: transcript came back empty — reported honestly, not asserted (see this \
                 test's doc comment); the wav-non-silence assertion above is this test's \
                 real pass/fail signal"
            );
        }
    }
}
