import { performance } from 'node:perf_hooks'
import type { TranscriptSegmentEvent } from '../ipc/types'
import { groupLiveSegments } from '../state/adapters'
import { INITIAL_CAPTURE_HEALTH_TRACKER, nextCaptureHealth } from '../components/recordingDiagnostics'

describe('logical three-hour recording soak', () => {
  it('keeps transcript grouping and health tracking bounded across 10,800 ticks', () => {
    const segments: TranscriptSegmentEvent[] = Array.from({ length: 10_800 }, (_, index) => ({
      noteId: 'soak-note',
      speaker: `Speaker ${Math.floor(index / 5) % 3 + 1}`,
      start: index,
      end: index + 0.8,
      text: `turn ${index}`,
    }))

    const started = performance.now()
    const groups = groupLiveSegments(segments)
    const groupingMs = performance.now() - started

    let tracker = INITIAL_CAPTURE_HEALTH_TRACKER
    for (let index = 0; index < segments.length; index += 1) {
      tracker = nextCaptureHealth(tracker, {
        noteId: 'soak-note',
        state: 'recording',
        elapsed: index,
        systemAudioActive: true,
        microphoneName: 'Soak Test Microphone',
        inputRms: 0.08,
        inputPeak: 0.42,
        inputSequence: index + 1,
        inputError: null,
        quietSecs: 0,
      }).tracker
    }

    expect(groups).toHaveLength(2_160)
    expect(groups[0]).toMatchObject({ speaker: 'Speaker 1', start: 0, end: 4.8 })
    expect(groups.at(-1)).toMatchObject({ start: 10_795, end: 10_799.8 })
    expect(tracker.lastSequence).toBe(10_800)
    expect(groupingMs).toBeLessThan(1_000)
  })

  it('reports a callback gap after sleep or disconnect and recovers on the next real sample', () => {
    let tracker = INITIAL_CAPTURE_HEALTH_TRACKER
    const event = (elapsed: number, inputSequence: number) => ({
      noteId: 'sleep-wake-note',
      state: 'recording' as const,
      elapsed,
      systemAudioActive: false,
      microphoneName: 'External microphone',
      inputRms: 0.06,
      inputPeak: 0.3,
      inputSequence,
      inputError: null,
      quietSecs: 0,
    })

    tracker = nextCaptureHealth(tracker, event(10, 100)).tracker
    tracker = nextCaptureHealth(tracker, event(11, 100)).tracker
    tracker = nextCaptureHealth(tracker, event(12, 100)).tracker
    const stalled = nextCaptureHealth(tracker, event(13, 100))
    expect(stalled.health).toBe('disconnected')

    const recovered = nextCaptureHealth(stalled.tracker, event(74, 101))
    expect(recovered.health).toBe('healthy')
    expect(recovered.tracker.stalledTicks).toBe(0)
  })
})
