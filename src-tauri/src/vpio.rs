//! Mic capture through macOS's VoiceProcessingIO audio unit (issue #15).
//!
//! **Why this exists.** When a recording mixes the mic with system audio
//! (`syscap.rs`), any sound the Mac plays through its *speakers* — most
//! importantly the remote side of a meeting — reaches the recording twice:
//! once cleanly through the ScreenCaptureKit tap, and once acoustically
//! through the microphone, delayed by the room and by the capture
//! pipeline's buffering. Summed by `mix_into`, those two copies are the
//! "constant echo / two overlapping tracks" users hear in every recording
//! made on speakers. The fix is acoustic echo cancellation *on the mic
//! signal*, and macOS ships exactly that: the `VoiceProcessingIO` audio
//! unit (the same AEC FaceTime and friends use) subtracts what the system
//! is playing from what the microphone hears at the driver level. This
//! module is a minimal capture wrapper around that unit.
//!
//! **Why not cpal for this.** cpal's CoreAudio backend hardwires
//! `HalOutput`/`DefaultOutput` units and exposes no way to ask for
//! `VoiceProcessingIO`, so this goes one level down to `coreaudio-rs` —
//! which cpal itself is built on, so the dependency is already in the tree
//! at exactly this version (see Cargo.toml's pin comment).
//!
//! **Deliberately best-effort.** `RecorderHandle::start` only reaches for
//! this when system audio is actually part of the mix (mic-only
//! recordings have no clean copy for the mic bleed to double, so plain
//! cpal capture stays byte-for-byte what it always was), and any failure
//! here — device without VPIO support, exotic aggregate devices, a future
//! macOS regression — falls back to the ordinary cpal stream, degrading
//! to the pre-fix behavior rather than a dead recording. That mirrors how
//! `SysCapture::start` failures already degrade to mic-only.
//!
//! **Side effects of VPIO to be aware of.** The unit applies Apple's
//! whole voice pipeline, not just AEC: automatic gain control and noise
//! suppression come with it, and capture is effectively voice-band. For a
//! 16 kHz mono speech recording destined for STT that trade is the right
//! one — but it's why this is scoped to the system-audio case instead of
//! being unconditionally swapped in for every mic recording.

use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{get_default_device_id, get_device_id_from_name};
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, Element, IOType, SampleFormat, Scope, StreamFormat};
use objc2_audio_toolbox::{
    kAudioOutputUnitProperty_CurrentDevice, kAudioOutputUnitProperty_EnableIO,
    kAudioUnitProperty_StreamFormat,
};

use crate::error::{MinuteError, Result};

/// The sample rate this module asks the voice-processing unit to deliver.
/// Matching `audio::TARGET_SAMPLE_RATE` exactly means the chunks fed to
/// the writer thread need no further resampling — VPIO does its own
/// internal rate conversion from whatever the hardware runs at.
pub const VPIO_SAMPLE_RATE_HZ: u32 = 16_000;

/// A running VoiceProcessingIO mic capture. Dropping it stops the unit
/// (and `AudioUnit`'s own `Drop` uninitializes/disposes it), which also
/// drops the input callback closure — and with it any channel senders the
/// closure owns, exactly like dropping a `cpal::Stream` does for the
/// plain-capture path.
pub struct VoiceProcessedMic {
    unit: AudioUnit,
}

impl VoiceProcessedMic {
    /// Starts voice-processed (echo-cancelled) capture from the input
    /// device named `device_name` (resolved by name because that's the one
    /// identifier cpal and CoreAudio reliably share; `None`/no match falls
    /// back to the system default input). Every delivered buffer is handed
    /// to `on_chunk` as mono f32 at [`VPIO_SAMPLE_RATE_HZ`], on the
    /// realtime audio thread — `on_chunk` must obey the same rules as a
    /// cpal data callback (no locks, no I/O, no blocking).
    pub fn start(
        device_name: Option<&str>,
        mut on_chunk: impl FnMut(&[f32]) + Send + 'static,
    ) -> Result<Self> {
        let device_id = device_name
            .and_then(|name| get_device_id_from_name(name, true))
            .or_else(|| get_default_device_id(true))
            .ok_or_else(|| {
                MinuteError::Other("vpio: no input device found for voice processing".to_string())
            })?;

        let mut unit = AudioUnit::new_uninitialized(IOType::VoiceProcessingIO)
            .map_err(|e| MinuteError::Other(format!("vpio: unit creation failed: {e}")))?;

        // Same bus setup coreaudio-rs's own `audio_unit_from_device_id`
        // does for a capture unit: input on (bus 1), output off (bus 0) —
        // this app never plays audio through the unit; the AEC reference
        // on macOS is the device output stream, not this unit's output.
        let enable_input = 1u32;
        unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Input,
            Element::Input,
            Some(&enable_input),
        )
        .map_err(|e| MinuteError::Other(format!("vpio: enabling input failed: {e}")))?;
        let disable_output = 0u32;
        unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Output,
            Element::Output,
            Some(&disable_output),
        )
        .map_err(|e| MinuteError::Other(format!("vpio: disabling output failed: {e}")))?;

        unit.set_property(
            kAudioOutputUnitProperty_CurrentDevice,
            Scope::Global,
            Element::Output,
            Some(&device_id),
        )
        .map_err(|e| MinuteError::Other(format!("vpio: selecting input device failed: {e}")))?;

        // The format the unit delivers *to us* (client side of the input
        // element): 16 kHz mono packed f32. VPIO converts internally from
        // the hardware rate, so this either succeeds and the pipeline gets
        // exactly the rate it stores, or fails here and the caller falls
        // back to cpal. Set on *both* client-facing sides (output scope of
        // the input element, input scope of the output element) — VPIO
        // refuses to initialize when its two sides disagree, even with the
        // output bus disabled.
        let stream_format = StreamFormat {
            sample_rate: f64::from(VPIO_SAMPLE_RATE_HZ),
            sample_format: SampleFormat::F32,
            flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
            channels: 1,
        };
        unit.set_property(
            kAudioUnitProperty_StreamFormat,
            Scope::Output,
            Element::Input,
            Some(&stream_format.to_asbd()),
        )
        .map_err(|e| MinuteError::Other(format!("vpio: setting stream format failed: {e}")))?;
        unit.set_property(
            kAudioUnitProperty_StreamFormat,
            Scope::Input,
            Element::Output,
            Some(&stream_format.to_asbd()),
        )
        .map_err(|e| MinuteError::Other(format!("vpio: setting output-side format failed: {e}")))?;

        type Args = render_callback::Args<data::Interleaved<f32>>;
        unit.set_input_callback(move |args: Args| {
            on_chunk(args.data.buffer);
            Ok(())
        })
        .map_err(|e| MinuteError::Other(format!("vpio: installing input callback failed: {e}")))?;

        unit.initialize()
            .map_err(|e| MinuteError::Other(format!("vpio: unit initialize failed: {e}")))?;
        unit.start()
            .map_err(|e| MinuteError::Other(format!("vpio: unit start failed: {e}")))?;

        Ok(Self { unit })
    }
}

impl Drop for VoiceProcessedMic {
    fn drop(&mut self) {
        // Best-effort; AudioUnit's own Drop uninitializes and disposes.
        let _ = self.unit.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Real-hardware smoke test — `#[ignore]`d because it needs an actual
    /// input device (and mic permission for the test runner), which CI
    /// doesn't have. Run manually with
    /// `cargo test vpio_smoke -- --ignored --nocapture` when touching this
    /// module: it proves the VoiceProcessingIO unit accepts this exact
    /// configuration (input-only busses, 16 kHz mono f32 client format)
    /// end-to-end — creation, initialize, start, callbacks firing, clean
    /// drop — which no amount of compile-time checking can.
    #[test]
    #[ignore]
    fn vpio_smoke() {
        let samples = Arc::new(AtomicUsize::new(0));
        let seen = samples.clone();
        let mic = VoiceProcessedMic::start(None, move |chunk| {
            seen.fetch_add(chunk.len(), Ordering::Relaxed);
        })
        .expect("VoiceProcessingIO capture failed to start");
        // Timed from *after* start() returns: unit creation/initialization
        // takes a couple of seconds on real hardware and must not dilute
        // the delivery-rate measurement below.
        let started = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(700));
        drop(mic);
        let elapsed = started.elapsed().as_secs_f64();
        let delivered = samples.load(Ordering::Relaxed);
        let rate = delivered as f64 / elapsed;
        println!("vpio_smoke: {delivered} samples in {elapsed:.2}s (~{rate:.0} Hz)");
        assert!(
            delivered > 0,
            "VPIO unit started but its input callback never delivered audio"
        );
        // The whole pipeline stores these chunks as 16 kHz — a unit that
        // delivers some other rate would record slow/fast audio, which no
        // other test can catch. Generous ±25% band: startup latency eats
        // into the window, and the exact chunk cadence is the OS's call.
        let expected = f64::from(VPIO_SAMPLE_RATE_HZ);
        assert!(
            (rate - expected).abs() < expected * 0.25,
            "VPIO delivered ~{rate:.0} Hz, expected ~{expected} Hz"
        );
    }
}
