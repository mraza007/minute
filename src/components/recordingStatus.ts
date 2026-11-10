import type { CaptureHealth, TranscriptPaceResult } from './recordingDiagnostics'

/**
 * The one message the recording view can show above the live transcript.
 * A healthy recording has none.
 */
export type RecordingMessage =
  | { kind: 'saveFailed'; detail: string }
  | { kind: 'autoStop'; quietSecs: number; secondsRemaining: number }
  | { kind: 'disconnected'; microphoneName: string }
  | { kind: 'silence'; quietSecs: number | null; microphoneSilent: boolean; microphoneName: string }
  | { kind: 'transcriptFailed'; detail: string | null }
  | { kind: 'lag'; lagSeconds: number }

export type RecordingMessageKind = RecordingMessage['kind']

export interface RecordingStatusInput {
  /** Why the last Stop failed, while the recording is still running. */
  saveFailure: string | null
  /** Seconds until the backend stops this quiet recording, or `null`. */
  autoStopSeconds: number | null
  /** Seconds of the current quiet run across every source. */
  quietSecs: number
  paused: boolean
  captureHealth: CaptureHealth
  pace: TranscriptPaceResult
  sttError: string | null
  microphoneName: string
}

/** The quiet run is worth a message from here on (issue #42). */
const QUIET_MESSAGE_SECONDS = 30

/**
 * Highest priority first. What the user must act on soonest wins: a failed
 * Stop, then a stop that is about to happen without them, then lost audio,
 * then a lost or late transcript. A microphone-only recording is not here:
 * it is a standing condition, so its offer sits on the sources line, where
 * no message can hide it.
 */
export const MESSAGE_PRIORITY: readonly RecordingMessageKind[] = [
  'saveFailed',
  'autoStop',
  'disconnected',
  'silence',
  'transcriptFailed',
  'lag',
]

const DETECTORS: { [K in RecordingMessageKind]: (input: RecordingStatusInput) => Extract<RecordingMessage, { kind: K }> | null } = {
  saveFailed: input => (input.saveFailure === null ? null : { kind: 'saveFailed', detail: input.saveFailure }),
  autoStop: input =>
    input.autoStopSeconds === null
      ? null
      : { kind: 'autoStop', quietSecs: input.quietSecs, secondsRemaining: input.autoStopSeconds },
  disconnected: input =>
    input.captureHealth === 'disconnected' ? { kind: 'disconnected', microphoneName: input.microphoneName } : null,
  silence: input => {
    if (input.paused) return null
    const quiet = input.quietSecs >= QUIET_MESSAGE_SECONDS
    const microphoneSilent = input.captureHealth === 'silent'
    if (!quiet && !microphoneSilent) return null
    return {
      kind: 'silence',
      quietSecs: quiet ? input.quietSecs : null,
      microphoneSilent,
      microphoneName: input.microphoneName,
    }
  },
  transcriptFailed: input =>
    input.pace.pace === 'unavailable' ? { kind: 'transcriptFailed', detail: input.sttError } : null,
  lag: input => (input.pace.pace === 'delayed' ? { kind: 'lag', lagSeconds: Math.round(input.pace.lagSeconds) } : null),
}

/** Picks the single message to show, or `null` for a healthy recording. */
export function recordingMessage(input: RecordingStatusInput): RecordingMessage | null {
  for (const kind of MESSAGE_PRIORITY) {
    const message = DETECTORS[kind](input)
    if (message) return message
  }
  return null
}

export type MessageTone = 'warn' | 'danger' | 'info'

export interface MessageCopy {
  tone: MessageTone
  title: string
  detail: string
}

function minutesAndSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function messageCopy(message: RecordingMessage): MessageCopy {
  switch (message.kind) {
    case 'saveFailed':
      return {
        tone: 'danger',
        title: 'Minute could not finish this recording',
        detail: `The recording is still running. ${message.detail}`,
      }
    case 'autoStop':
      return {
        tone: 'warn',
        title: `Quiet for ${minutesAndSeconds(message.quietSecs)}. Minute stops in ${minutesAndSeconds(message.secondsRemaining)}.`,
        detail: 'The recording stops on its own unless sound returns.',
      }
    case 'disconnected':
      return {
        tone: 'danger',
        title: `${message.microphoneName} stopped responding`,
        detail: 'The audio recorded so far is safe. Reconnect the microphone to continue.',
      }
    case 'silence':
      return {
        tone: 'warn',
        title:
          message.quietSecs === null
            ? 'No sound from the microphone'
            : `Quiet for ${minutesAndSeconds(message.quietSecs)}`,
        detail: [
          message.microphoneSilent ? `Check that ${message.microphoneName} is not muted.` : null,
          message.quietSecs === null ? null : 'Minute offers to stop after 2 quiet minutes.',
        ].filter(Boolean).join(' '),
      }
    case 'transcriptFailed':
      return {
        tone: 'danger',
        title: 'The live transcript stopped',
        detail: ['Audio is still recording.', message.detail].filter(Boolean).join(' '),
      }
    case 'lag':
      return {
        tone: 'info',
        title: `The transcript is ${message.lagSeconds} seconds behind`,
        detail: 'Audio is still recording. The transcript catches up when you stop.',
      }
  }
}

export type HealthTone = 'ok' | 'neutral' | 'warn' | 'danger'

export interface HealthLine {
  tone: HealthTone
  /** What the bottom bar shows. May carry a changing lag figure. */
  text: string
  /** The same state without changing numbers, for the screen-reader live region. */
  announcement: string
}

function steady(tone: HealthTone, text: string): HealthLine {
  return { tone, text, announcement: text }
}

/** The single health line in the bottom bar: capture first, then transcript pace. */
export function recordingHealthLine(captureHealth: CaptureHealth, pace: TranscriptPaceResult): HealthLine {
  switch (captureHealth) {
    case 'disconnected':
      return steady('danger', 'The microphone stopped responding')
    case 'silent':
      return steady('warn', 'No sound from the microphone')
    case 'clipping':
      return steady('warn', 'The microphone is clipping. Lower the input level.')
    case 'paused':
      return steady('neutral', 'Paused')
    case 'checking':
      return steady('neutral', 'Checking the microphone')
    case 'healthy':
      break
  }

  const lag = Math.max(1, Math.round(pace.lagSeconds))
  switch (pace.pace) {
    case 'current':
      return steady('ok', 'Audio and transcript are healthy')
    case 'behind':
      return {
        tone: 'neutral',
        text: `Audio is healthy. Transcript ${lag}s behind.`,
        announcement: 'Audio is healthy. The transcript is behind.',
      }
    case 'delayed':
      return {
        tone: 'warn',
        text: `Audio is healthy. Transcript ${lag}s behind.`,
        announcement: 'Audio is healthy. The transcript is delayed.',
      }
    case 'unavailable':
      return steady('danger', 'Audio is healthy. Transcript unavailable.')
    case 'finalizing':
      return steady('neutral', 'Finishing the transcript')
    case 'paused':
      return steady('neutral', 'Paused')
    case 'waiting':
      return steady('ok', 'Audio is healthy. Waiting for speech.')
  }
}
