// Typed listen helpers over the five Tauri events emitted by the recording/
// transcription/download backend (see download.rs, audio.rs, stt.rs). Each
// helper is a thin wrapper over `@tauri-apps/api/event`'s `listen`: it pins
// the event name and unwraps `event.payload` before handing it to the
// caller's callback, so call sites never have to know the wire event name
// or deal with the `Event<T>` envelope.

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AudioInputLevelEvent,
  AskAnswerEvent,
  AskStatusEvent,
  DiarStatusPayload,
  MeetingDetectedEvent,
  MeetingPopupPayloadEvent,
  ModelDownloadDoneEvent,
  ModelDownloadProgressEvent,
  RecordingStateEvent,
  SttStatusEvent,
  SummaryStatusEvent,
  TranscriptSegmentEvent,
} from './types'

// Re-exported so consumers (useTauriEvent, and anything else typing an
// unlisten callback) can import it from this module instead of reaching
// past it to `@tauri-apps/api/event` directly.
export type { UnlistenFn }

export function onDownloadProgress(
  cb: (payload: ModelDownloadProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ModelDownloadProgressEvent>('model-download-progress', (event) => cb(event.payload))
}

export function onDownloadDone(cb: (payload: ModelDownloadDoneEvent) => void): Promise<UnlistenFn> {
  return listen<ModelDownloadDoneEvent>('model-download-done', (event) => cb(event.payload))
}

export function onRecordingState(cb: (payload: RecordingStateEvent) => void): Promise<UnlistenFn> {
  return listen<RecordingStateEvent>('recording-state', (event) => cb(event.payload))
}

export function onTranscriptSegment(
  cb: (payload: TranscriptSegmentEvent) => void,
): Promise<UnlistenFn> {
  return listen<TranscriptSegmentEvent>('transcript-segment', (event) => cb(event.payload))
}

export function onSttStatus(cb: (payload: SttStatusEvent) => void): Promise<UnlistenFn> {
  return listen<SttStatusEvent>('stt-status', (event) => cb(event.payload))
}

export function onAudioInputLevel(cb: (payload: AudioInputLevelEvent) => void): Promise<UnlistenFn> {
  return listen<AudioInputLevelEvent>('audio-input-level', event => cb(event.payload))
}

export function onSummaryStatus(cb: (payload: SummaryStatusEvent) => void): Promise<UnlistenFn> {
  return listen<SummaryStatusEvent>('summary-status', (event) => cb(event.payload))
}

/** `diar.rs`'s speaker-detection lifecycle — see `DiarStatusPayload`'s docs. */
export function onDiarStatus(cb: (payload: DiarStatusPayload) => void): Promise<UnlistenFn> {
  return listen<DiarStatusPayload>('diar-status', (event) => cb(event.payload))
}

export function onAskStatus(cb: (payload: AskStatusEvent) => void): Promise<UnlistenFn> {
  return listen<AskStatusEvent>('ask-status', (event) => cb(event.payload))
}

export function onAskAnswer(cb: (payload: AskAnswerEvent) => void): Promise<UnlistenFn> {
  return listen<AskAnswerEvent>('ask-answer', (event) => cb(event.payload))
}

/**
 * `detect.rs`'s meeting-detection prompt trigger — see `MeetingDetectedEvent`'s
 * docs. Broadcast to every window (the main window doesn't currently act on
 * it — the popup pill itself is driven by `onMeetingPopupPayload` below,
 * targeted specifically at the popup window); kept as its own event rather
 * than folded into that one since it's the general "a prompt fired"
 * notification, not popup-window-specific wiring.
 */
export function onMeetingDetected(cb: (payload: MeetingDetectedEvent) => void): Promise<UnlistenFn> {
  return listen<MeetingDetectedEvent>('meeting-detected', (event) => cb(event.payload))
}

/**
 * `popup.rs`'s per-showing payload for the meeting-detected pill — see
 * `MeetingPopupPayloadEvent`'s docs. Only ever listened to by the popup
 * window itself (`src/popup/Pill.tsx`).
 */
export function onMeetingPopupPayload(
  cb: (payload: MeetingPopupPayloadEvent) => void,
): Promise<UnlistenFn> {
  return listen<MeetingPopupPayloadEvent>('meeting-popup-payload', (event) => cb(event.payload))
}

/**
 * `popup::popup_start`'s "the user clicked Start recording" signal to the
 * *main* window — see that command's docs for why this is a plain event
 * the main frontend reacts to (re-running its own already-tested `startRec`
 * flow) rather than the backend starting the recording directly. No real
 * payload (the Rust side emits `()`, which serializes to `null` — `cb`'s
 * `null` parameter matches that shape rather than pretending there's a
 * payload type, and is left unused by every caller) — everything the main
 * window's handler needs (which STT model, whether one is even installed)
 * is already in its own in-memory state. Kept in the same `(cb: (payload:
 * T) => void) => Promise<UnlistenFn>` shape as every other helper here
 * (rather than a bare `() => void` callback) so it can be passed directly
 * to `useTauriEvent`, which is generic over that shape.
 */
export function onMeetingPopupStart(cb: (payload: null) => void): Promise<UnlistenFn> {
  return listen<null>('meeting-popup-start', (event) => cb(event.payload))
}
