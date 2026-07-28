import { useEffect, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onAudioInputLevel } from '../ipc/events'
import type { AudioInputLevelEvent } from '../ipc/types'
import { useTauriEvent } from '../state/useTauriEvent'
import {
  meterLevelFromRms,
  nextInputDiagnostic,
  type InputDiagnostic,
  type InputDiagnosticTracker,
} from './inputLevelDiagnostics'

function diagnosticCopy(diagnostic: InputDiagnostic): string {
  switch (diagnostic) {
    case 'starting':
      return 'Starting input check…'
    case 'listening':
      return 'Speak to check your level'
    case 'good':
      return 'Input level looks good'
    case 'silent':
      return 'No sound detected — check mute or input'
    case 'clipping':
      return 'Input is clipping — lower the input level'
    case 'error':
      return 'Input preview unavailable'
  }
}

let previewSessionCounter = 0

export interface InputLevelMeterProps {
  deviceId: string | null
  active: boolean
}

export function InputLevelMeter({ deviceId, active }: InputLevelMeterProps) {
  const [level, setLevel] = useState(0)
  const [diagnostic, setDiagnostic] = useState<InputDiagnostic>('starting')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const trackerRef = useRef<InputDiagnosticTracker>({ silenceSince: null, clippingEvents: 0 })

  useTauriEvent(
    onAudioInputLevel,
    (event: AudioInputLevelEvent) => {
      if (event.sessionId !== sessionIdRef.current) return
      if (event.error) {
        setLevel(0)
        setDiagnostic('error')
        return
      }

      const result = nextInputDiagnostic(trackerRef.current, event.rms, event.peak, Date.now())
      trackerRef.current = result.tracker
      const target = meterLevelFromRms(event.rms)
      setLevel(previous =>
        result.diagnostic === 'clipping'
          ? Math.max(previous, 0.98)
          : previous + (target - previous) * 0.45,
      )
      setDiagnostic(result.diagnostic)
    },
    [],
  )

  useEffect(() => {
    if (!active || !deviceId) {
      sessionIdRef.current = null
      setSessionId(null)
      setLevel(0)
      setDiagnostic('starting')
      return
    }

    const nextSessionId = `input-preview-${Date.now()}-${++previewSessionCounter}`
    let live = true
    sessionIdRef.current = nextSessionId
    setSessionId(nextSessionId)
    trackerRef.current = { silenceSince: null, clippingEvents: 0 }
    setLevel(0)
    setDiagnostic('starting')

    void ipc
      .startAudioInputPreview(deviceId, nextSessionId)
      .then(() => {
        if (live && sessionIdRef.current === nextSessionId) {
          setDiagnostic(current => current === 'starting' ? 'listening' : current)
        }
      })
      .catch(() => {
        if (live && sessionIdRef.current === nextSessionId) {
          setLevel(0)
          setDiagnostic('error')
        }
      })

    return () => {
      live = false
      if (sessionIdRef.current === nextSessionId) sessionIdRef.current = null
      void ipc.stopAudioInputPreview(nextSessionId).catch(() => {
        // Cleanup is best-effort. The backend token guard and recording
        // start both drop stale preview streams independently.
      })
    }
  }, [active, deviceId])

  const percent = Math.round(level * 100)
  const tone = diagnostic === 'clipping' || diagnostic === 'silent' || diagnostic === 'error'
    ? 'warning'
    : diagnostic === 'good'
      ? 'positive'
      : 'neutral'

  return (
    <div
      className="input-level"
      data-preview-session={sessionId ?? undefined}
      data-tone={tone}
    >
      <div
        className="input-level-track"
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={diagnosticCopy(diagnostic)}
      >
        <span className="input-level-fill" style={{ transform: `scaleX(${level})` }} />
        <span className="input-level-clip-mark" aria-hidden="true" />
      </div>
      <span className="input-level-copy" aria-live="polite">{diagnosticCopy(diagnostic)}</span>
    </div>
  )
}
