// Typed listen helpers over the five Tauri events emitted by the recording/
// transcription/download backend (see download.rs, audio.rs, stt.rs). Each
// helper is a thin wrapper over `@tauri-apps/api/event`'s `listen`: it pins
// the event name and unwraps `event.payload` before handing it to the
// caller's callback, so call sites never have to know the wire event name
// or deal with the `Event<T>` envelope.

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AskAnswerEvent,
  AskStatusEvent,
  MeetingDetectedEvent,
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

export function onSummaryStatus(cb: (payload: SummaryStatusEvent) => void): Promise<UnlistenFn> {
  return listen<SummaryStatusEvent>('summary-status', (event) => cb(event.payload))
}

export function onAskStatus(cb: (payload: AskStatusEvent) => void): Promise<UnlistenFn> {
  return listen<AskStatusEvent>('ask-status', (event) => cb(event.payload))
}

export function onAskAnswer(cb: (payload: AskAnswerEvent) => void): Promise<UnlistenFn> {
  return listen<AskAnswerEvent>('ask-answer', (event) => cb(event.payload))
}

/**
 * `detect.rs`'s meeting-detection prompt trigger — see `MeetingDetectedEvent`'s
 * docs. Stage 5 Task 1 only wires the typed listener itself; nothing in the
 * frontend subscribes to it yet (the popup pill is Task 2).
 */
export function onMeetingDetected(cb: (payload: MeetingDetectedEvent) => void): Promise<UnlistenFn> {
  return listen<MeetingDetectedEvent>('meeting-detected', (event) => cb(event.payload))
}
