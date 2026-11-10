import type { CaptureHealth, TranscriptPaceResult } from './recordingDiagnostics'
import {
  MESSAGE_PRIORITY,
  messageCopy,
  recordingHealthLine,
  recordingMessage,
  type RecordingMessageKind,
  type RecordingStatusInput,
} from './recordingStatus'

const CURRENT: TranscriptPaceResult = { pace: 'current', lagSeconds: 2 }

const healthy: RecordingStatusInput = {
  saveFailure: null,
  autoStopSeconds: null,
  quietSecs: 0,
  paused: false,
  captureHealth: 'healthy',
  pace: CURRENT,
  sttError: null,
  microphoneName: 'MacBook Pro Microphone',
  systemAudioActive: true,
  canRestartWithSystemAudio: true,
}

/** The smallest change to a healthy recording that raises each message. */
const TRIGGER: Record<RecordingMessageKind, Partial<RecordingStatusInput>> = {
  saveFailed: { saveFailure: 'Disk full.' },
  autoStop: { autoStopSeconds: 108, quietSecs: 120 },
  disconnected: { captureHealth: 'disconnected' },
  silence: { captureHealth: 'silent' },
  transcriptFailed: { pace: { pace: 'unavailable', lagSeconds: 0 }, sttError: 'model not installed' },
  lag: { pace: { pace: 'delayed', lagSeconds: 34.4 } },
  micOnly: { systemAudioActive: false },
}

describe('recordingMessage', () => {
  it('shows nothing for a healthy recording', () => {
    expect(recordingMessage(healthy)).toBeNull()
  })

  it.each(MESSAGE_PRIORITY)('raises %s on its own trigger', kind => {
    expect(recordingMessage({ ...healthy, ...TRIGGER[kind] })?.kind).toBe(kind)
  })

  it('picks the most urgent message when every condition holds at once', () => {
    const everything = Object.assign({}, healthy, ...[...MESSAGE_PRIORITY].reverse().map(kind => TRIGGER[kind]))
    expect(recordingMessage(everything)?.kind).toBe('saveFailed')
  })

  it.each(MESSAGE_PRIORITY.slice(0, -1).map((kind, index) => [kind, MESSAGE_PRIORITY[index + 1]] as const))(
    '%s outranks %s',
    (higher, lower) => {
      expect(recordingMessage({ ...healthy, ...TRIGGER[lower], ...TRIGGER[higher] })?.kind).toBe(higher)
    },
  )

  it('orders the kinds: failed stop, pending stop, lost audio, lost transcript, advice', () => {
    expect(MESSAGE_PRIORITY).toEqual([
      'saveFailed',
      'autoStop',
      'disconnected',
      'silence',
      'transcriptFailed',
      'lag',
      'micOnly',
    ])
  })

  it('reports a quiet run from 30 seconds, with or without a silent microphone', () => {
    expect(recordingMessage({ ...healthy, quietSecs: 29 })).toBeNull()
    expect(recordingMessage({ ...healthy, quietSecs: 30 })).toEqual({
      kind: 'silence',
      quietSecs: 30,
      microphoneSilent: false,
      microphoneName: 'MacBook Pro Microphone',
    })
    expect(recordingMessage({ ...healthy, captureHealth: 'silent', quietSecs: 5 })).toMatchObject({
      kind: 'silence',
      quietSecs: null,
      microphoneSilent: true,
    })
  })

  it('does not call a paused recording quiet', () => {
    expect(recordingMessage({ ...healthy, paused: true, captureHealth: 'paused', quietSecs: 90 })).toBeNull()
  })

  it('keeps a merely behind transcript out of the message slot', () => {
    expect(recordingMessage({ ...healthy, pace: { pace: 'behind', lagSeconds: 20 } })).toBeNull()
  })

  it('offers the restart only when this Mac can capture system audio', () => {
    expect(recordingMessage({ ...healthy, systemAudioActive: false, canRestartWithSystemAudio: false })).toBeNull()
  })
})

describe('messageCopy', () => {
  it('counts the quiet run and the time left in minutes and seconds', () => {
    expect(messageCopy({ kind: 'autoStop', quietSecs: 120, secondsRemaining: 108 }).title).toBe(
      'Quiet for 2:00. Minute stops in 1:48.',
    )
  })

  it('names the microphone to check only when the microphone itself is silent', () => {
    const base = { kind: 'silence' as const, microphoneName: 'AirPods Pro' }
    expect(messageCopy({ ...base, quietSecs: null, microphoneSilent: true })).toMatchObject({
      title: 'No sound from the microphone',
      detail: 'Check that AirPods Pro is not muted.',
    })
    expect(messageCopy({ ...base, quietSecs: 45, microphoneSilent: false })).toMatchObject({
      title: 'Quiet for 0:45',
      detail: 'Minute offers to stop after 2 quiet minutes.',
    })
  })

  it('marks lost audio and a failed stop as danger, quiet as a warning, and advice as info', () => {
    expect(messageCopy({ kind: 'disconnected', microphoneName: 'AirPods Pro' }).tone).toBe('danger')
    expect(messageCopy({ kind: 'saveFailed', detail: 'Disk full.' }).tone).toBe('danger')
    expect(messageCopy({ kind: 'autoStop', quietSecs: 120, secondsRemaining: 60 }).tone).toBe('warn')
    expect(messageCopy({ kind: 'lag', lagSeconds: 34 }).tone).toBe('info')
    expect(messageCopy({ kind: 'micOnly' }).tone).toBe('info')
  })
})

describe('recordingHealthLine', () => {
  it('is green only when audio and transcript are both keeping up', () => {
    expect(recordingHealthLine('healthy', CURRENT)).toMatchObject({ tone: 'ok', text: 'Audio and transcript are healthy' })
  })

  it.each<[CaptureHealth, string]>([
    ['disconnected', 'danger'],
    ['silent', 'warn'],
    ['clipping', 'warn'],
    ['paused', 'neutral'],
    ['checking', 'neutral'],
  ])('reports a %s microphone ahead of the transcript pace', (captureHealth, tone) => {
    expect(recordingHealthLine(captureHealth, { pace: 'delayed', lagSeconds: 60 }).tone).toBe(tone)
  })

  it('shows the lag figure but keeps it out of the announcement', () => {
    const line = recordingHealthLine('healthy', { pace: 'delayed', lagSeconds: 41.6 })
    expect(line.text).toBe('Audio is healthy. Transcript 42s behind.')
    expect(line.announcement).not.toMatch(/\d/)
    expect(line.tone).toBe('warn')
  })

  it('says the transcript is unavailable while audio stays healthy', () => {
    expect(recordingHealthLine('healthy', { pace: 'unavailable', lagSeconds: 0 })).toMatchObject({
      tone: 'danger',
      text: 'Audio is healthy. Transcript unavailable.',
    })
  })
})
