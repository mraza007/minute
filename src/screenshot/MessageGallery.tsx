import { StatusMessage } from '../components/RecordingView'
import type { RecordingMessage } from '../components/recordingStatus'

/** One of each message, in priority order. The app itself shows at most one. */
const MESSAGES: RecordingMessage[] = [
  { kind: 'saveFailed', detail: 'The disk is full.' },
  { kind: 'autoStop', quietSecs: 120, secondsRemaining: 108 },
  { kind: 'disconnected', microphoneName: 'AirPods Pro' },
  { kind: 'silence', quietSecs: 40, microphoneSilent: true, microphoneName: 'MacBook Pro Microphone' },
  { kind: 'transcriptFailed', detail: 'The transcription model stopped.' },
  { kind: 'lag', lagSeconds: 34 },
  { kind: 'micOnly' },
]

const NO_ACTIONS = {
  onKeepRecording: () => {},
  onStop: () => {},
  onRetrySave: () => {},
  onDismissSaveFailure: () => {},
  onRestartWithSystemAudio: () => {},
}

/**
 * `?state=messages`: every recording status message on one page, for the
 * capture that is read against the status-messages artboard.
 */
export function MessageGallery() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 720, padding: '48px 80px', background: 'var(--panel)' }}>
      {MESSAGES.map(message => (
        <StatusMessage key={message.kind} message={message} actions={NO_ACTIONS} />
      ))}
    </div>
  )
}
