# Minute reliability matrix

Use a release build on each supported macOS major version. Record the Mac,
audio device, model, duration, result, diagnostics filename, and linked issue
for every run. Never attach a recording or transcript to an issue unless the
tester explicitly created it as non-sensitive test data.

| Scenario | Setup | Expected behavior | Automated coverage | Device result |
| --- | --- | --- | --- | --- |
| Microphone permission denied | Reset Minute microphone permission, deny the next prompt | Preflight stays open, names the denied permission, and does not claim recording started | Native AVFoundation gate + preflight component tests | **Pass — July 28, 2026** |
| Microphone disconnected | Start with a removable input, disconnect it during capture | Recording remains reachable, reports the lost input, preserves audio already written, and offers recovery guidance | Recording health reducer and disconnected-state component tests | Pending |
| Microphone reconnected | Reconnect the same input after a disconnect | Minute honestly reports whether capture resumed or requires a new recording; it never silently switches sources | Recording-state event filtering tests | Pending |
| Sleep and wake | Record for five minutes, sleep for one minute, wake, continue, stop | No crash; elapsed/capture health recover; finalization yields a usable note or an explicit recovery state | Exit/finalization and logical soak tests | Pending |
| Low disk | Run in a constrained test volume, exhaust space during WAV writing | Audio-writer error is visible, existing capture remains recoverable, finalized note says Needs review | Deterministic WAV failure + persisted recovery-warning tests | Automated; constrained-volume device run pending |
| Model worker failure | Use the injected STT failure path | Audio continues, transcript failure is named, stop preserves the note | STT error and partial-content tests | Automated |
| Summary failure | Use the injected summary failure path | Transcript/audio remain usable and retry is available | Note overview recovery tests | Automated |
| Multi-hour capture | Run `npm run test:soak`, then an overnight real-device capture | Transcript grouping remains bounded, live DOM caps at 200 rows, health tracking remains stable, final note opens | Three-hour logical clock soak + live-row cap tests | Automated logical; device pending |

## Native-device baseline — July 28, 2026

- Opened an isolated native bundle on macOS 26.4.1, Apple Silicon, with 48 GB
  memory and 14 CPU cores.
- Confirmed recording preflight discovers and names the built-in MacBook Pro
  microphone, exposes the live input-level meter, reports system-audio
  permission state, and keeps Start disabled until its prerequisites are met.
- Confirmed the native accessibility tree exposes the microphone selector,
  system-audio state, transcription choice, Cancel, and Start recording.
- Verified a fresh-identity native bundle with AVFoundation status
  `notDetermined`: the microphone selector and Start action stayed disabled
  until the explicit **Allow microphone…** action.
- Verified the denied result: the sheet remained open, announced **Blocked**,
  named System Settings → Privacy & Security → Microphone, exposed no input
  meter, and did not start a recording. Evidence:
  `minute-reliability-microphone-denied.png`.
- The device inventory exposed only the built-in MacBook Pro Microphone, so a
  removable-device transition could not be performed honestly.
- Sleep/wake was not triggered from the active development session because it
  would suspend the test controller itself. The overnight capture likewise
  needs a user-owned unattended window and explicitly non-sensitive audio.
- Low-disk behavior now has a deterministic writer fault: already-written WAV
  samples and the transcription stream survive, the error is recorded, and the
  finalized note persists a **Needs review** warning. A constrained-volume
  hardware run is still required before the device row is complete.

## Recovery classes

| Backend class | User-facing recovery |
| --- | --- |
| Audio input/callback failure | Keep the recording visible, name the input problem, preserve already-written audio |
| WAV writer/final save failure | Retry finalization; never discard the active recovery context |
| STT load/inference failure | Continue saving audio; expose transcript recovery copy and model guidance |
| Note-list refresh failure | Keep the finalized note id and retry the library refresh |
| Summary/LLM failure | Keep transcript/audio/Markdown usable and offer summary retry |
| Note deletion | Move into Minute recovery and expose exact Undo |

Real-device rows remain incomplete until a person performs the hardware or
permission transition and records the result. Automated green status must not
be substituted for those runs.
