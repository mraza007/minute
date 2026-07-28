const SILENCE_RMS = 0.003
const SILENCE_AFTER_MS = 2_000
const CLIPPING_PEAK = 0.98
const CLIPPING_EVENT_COUNT = 2

export type InputDiagnostic = 'starting' | 'listening' | 'good' | 'silent' | 'clipping' | 'error'

export interface InputDiagnosticTracker {
  silenceSince: number | null
  clippingEvents: number
}

export interface InputDiagnosticResult {
  diagnostic: Exclude<InputDiagnostic, 'starting' | 'error'>
  tracker: InputDiagnosticTracker
}

export function nextInputDiagnostic(
  previous: InputDiagnosticTracker,
  rms: number,
  peak: number,
  now: number,
): InputDiagnosticResult {
  const clippingEvents = peak >= CLIPPING_PEAK ? previous.clippingEvents + 1 : 0
  if (clippingEvents >= CLIPPING_EVENT_COUNT) {
    return {
      diagnostic: 'clipping',
      tracker: { silenceSince: null, clippingEvents },
    }
  }

  if (rms < SILENCE_RMS) {
    const silenceSince = previous.silenceSince ?? now
    return {
      diagnostic: now - silenceSince >= SILENCE_AFTER_MS ? 'silent' : 'listening',
      tracker: { silenceSince, clippingEvents },
    }
  }

  return {
    diagnostic: 'good',
    tracker: { silenceSince: null, clippingEvents },
  }
}

export function meterLevelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  const decibels = 20 * Math.log10(Math.min(1, rms))
  return Math.max(0, Math.min(1, (decibels + 60) / 60))
}
