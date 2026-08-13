import type { RecordingStateEvent } from '../ipc/types'
import {
  INITIAL_CAPTURE_HEALTH_TRACKER,
  nextCaptureHealth,
  transcriptPace,
} from './recordingDiagnostics'

function event(overrides: Partial<RecordingStateEvent> = {}): RecordingStateEvent {
  return {
    noteId: 'note-live',
    state: 'recording',
    elapsed: 1,
    systemAudioActive: false,
    microphoneName: 'MacBook Pro Microphone',
    inputRms: 0.08,
    inputPeak: 0.4,
    inputSequence: 1,
    inputError: null,
    quietSecs: 0,
    ...overrides,
  }
}

describe('recording diagnostics', () => {
  it('warns only after prolonged silence', () => {
    const first = nextCaptureHealth(
      INITIAL_CAPTURE_HEALTH_TRACKER,
      event({ elapsed: 2, inputRms: 0, inputSequence: 2 }),
    )
    expect(first.health).toBe('healthy')
    expect(
      nextCaptureHealth(
        first.tracker,
        event({ elapsed: 11.9, inputRms: 0, inputSequence: 3 }),
      ).health,
    ).toBe('healthy')
    expect(
      nextCaptureHealth(
        first.tracker,
        event({ elapsed: 12, inputRms: 0, inputSequence: 4 }),
      ).health,
    ).toBe('silent')
  })

  it('requires repeated clipping peaks and clears once level recovers', () => {
    const first = nextCaptureHealth(
      INITIAL_CAPTURE_HEALTH_TRACKER,
      event({ inputPeak: 0.99 }),
    )
    expect(first.health).toBe('healthy')
    const second = nextCaptureHealth(
      first.tracker,
      event({ inputPeak: 0.99, inputSequence: 2 }),
    )
    expect(second.health).toBe('clipping')
    expect(
      nextCaptureHealth(
        second.tracker,
        event({ inputPeak: 0.4, inputSequence: 3 }),
      ).health,
    ).toBe('healthy')
  })

  it('distinguishes a stalled callback sequence and an explicit stream error from silence', () => {
    const one = nextCaptureHealth(INITIAL_CAPTURE_HEALTH_TRACKER, event({ inputSequence: 8 }))
    const two = nextCaptureHealth(one.tracker, event({ inputSequence: 8, elapsed: 2 }))
    const three = nextCaptureHealth(two.tracker, event({ inputSequence: 8, elapsed: 3 }))
    const four = nextCaptureHealth(three.tracker, event({ inputSequence: 8, elapsed: 4 }))
    expect(two.health).toBe('healthy')
    expect(three.health).toBe('healthy')
    expect(four.health).toBe('disconnected')
    expect(
      nextCaptureHealth(
        INITIAL_CAPTURE_HEALTH_TRACKER,
        event({ inputError: 'device disconnected' }),
      ).health,
    ).toBe('disconnected')
  })

  it('resets diagnostics while paused', () => {
    const result = nextCaptureHealth(
      {
        lastSequence: 4,
        stalledTicks: 3,
        silenceSince: 0,
        clippingTicks: 2,
      },
      event({ state: 'paused', inputSequence: 4 }),
    )
    expect(result.health).toBe('paused')
    expect(result.tracker.stalledTicks).toBe(0)
    expect(result.tracker.silenceSince).toBeNull()
  })

  it('classifies observed transcript lag without claiming a fake queue percentage', () => {
    expect(transcriptPace(20, 16, 'ready', false)).toEqual({
      pace: 'current',
      lagSeconds: 4,
    })
    expect(transcriptPace(30, 12, 'ready', false)).toEqual({
      pace: 'behind',
      lagSeconds: 18,
    })
    expect(transcriptPace(60, 20, 'ready', false)).toEqual({
      pace: 'delayed',
      lagSeconds: 40,
    })
    expect(transcriptPace(60, 20, 'error', false).pace).toBe('unavailable')
    expect(transcriptPace(60, 20, 'ready', true).pace).toBe('paused')
  })
})
