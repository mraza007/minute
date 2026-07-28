import type { RecordingStateEvent } from '../ipc/types'
import type { SttStatus } from '../types'

export type CaptureHealth = 'checking' | 'healthy' | 'silent' | 'clipping' | 'disconnected' | 'paused'

export interface CaptureHealthTracker {
  lastSequence: number | null
  stalledTicks: number
  silenceSince: number | null
  clippingTicks: number
}

export interface CaptureHealthResult {
  health: CaptureHealth
  tracker: CaptureHealthTracker
}

export const INITIAL_CAPTURE_HEALTH_TRACKER: CaptureHealthTracker = {
  lastSequence: null,
  stalledTicks: 0,
  silenceSince: null,
  clippingTicks: 0,
}

const SILENCE_RMS = 0.003
const SILENCE_WARNING_SECONDS = 10
const CLIPPING_PEAK = 0.98
const STALLED_TICKS = 3

export function nextCaptureHealth(
  tracker: CaptureHealthTracker,
  event: RecordingStateEvent,
): CaptureHealthResult {
  if (event.state === 'paused') {
    return {
      health: 'paused',
      tracker: { ...INITIAL_CAPTURE_HEALTH_TRACKER, lastSequence: event.inputSequence },
    }
  }

  if (event.inputError) {
    return {
      health: 'disconnected',
      tracker: { ...tracker, lastSequence: event.inputSequence },
    }
  }

  const stalledTicks =
    tracker.lastSequence !== null && event.inputSequence === tracker.lastSequence
      ? tracker.stalledTicks + 1
      : 0
  const clippingTicks = event.inputPeak >= CLIPPING_PEAK ? tracker.clippingTicks + 1 : 0
  const silenceSince =
    event.inputRms < SILENCE_RMS
      ? tracker.silenceSince ?? event.elapsed
      : null
  const nextTracker = {
    lastSequence: event.inputSequence,
    stalledTicks,
    silenceSince,
    clippingTicks,
  }

  if (stalledTicks >= STALLED_TICKS) return { health: 'disconnected', tracker: nextTracker }
  if (event.inputSequence === 0) return { health: 'checking', tracker: nextTracker }
  if (clippingTicks >= 2) return { health: 'clipping', tracker: nextTracker }
  if (silenceSince !== null && event.elapsed - silenceSince >= SILENCE_WARNING_SECONDS) {
    return { health: 'silent', tracker: nextTracker }
  }
  return { health: 'healthy', tracker: nextTracker }
}

export type TranscriptPace = 'waiting' | 'current' | 'behind' | 'delayed' | 'paused' | 'unavailable' | 'finalizing'

export interface TranscriptPaceResult {
  pace: TranscriptPace
  lagSeconds: number
}

export function transcriptPace(
  elapsed: number,
  latestSegmentEnd: number | null,
  sttStatus: SttStatus,
  paused: boolean,
): TranscriptPaceResult {
  const lagSeconds = Math.max(0, elapsed - (latestSegmentEnd ?? elapsed))
  if (sttStatus === 'error') return { pace: 'unavailable', lagSeconds }
  if (sttStatus === 'finalizing') return { pace: 'finalizing', lagSeconds }
  if (paused) return { pace: 'paused', lagSeconds }
  if (sttStatus === 'idle' || sttStatus === 'loading' || latestSegmentEnd === null) {
    return { pace: 'waiting', lagSeconds: latestSegmentEnd === null ? elapsed : lagSeconds }
  }
  if (lagSeconds >= 30) return { pace: 'delayed', lagSeconds }
  if (lagSeconds >= 12) return { pace: 'behind', lagSeconds }
  return { pace: 'current', lagSeconds }
}
