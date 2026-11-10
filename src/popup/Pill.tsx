import { useCallback, useEffect, useRef, useState } from 'react'
import { popupDismiss, popupStart, popupStop } from '../ipc/commands'
import { onMeetingPopupPayload, onRecordingState } from '../ipc/events'
import type { MeetingPopupPayloadEvent } from '../ipc/types'

/** How long a pill stays up with no interaction. The same window serves both states. */
export const DEFAULT_AUTO_DISMISS_MS = 12_000

interface PillProps {
  autoDismissMs?: number
}

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The meeting pill in the popup window (src-tauri/src/popup.rs). It has two
 * states, picked by the payload's `kind`:
 *
 * - `ask`: "<app> meeting started", "Minute is not recording.", Dismiss and
 *   Record. Nothing is recording until the user clicks Record.
 * - `started`: "Recording <app>", "Started automatically · 0:04", Stop. The
 *   recording already runs. The time comes from the recorder's own
 *   `recording-state` events, so it matches the main window.
 *
 * The window is created transparent and non-activating, so the pill carries
 * the visible surface. The popup window is created once and reused, so a new
 * payload re-arms the auto-dismiss timer instead of remounting.
 *
 * ## Keyboard caveat
 * Enter and Escape work only when AppKit made the panel key, which a
 * non-activating panel does after a click. Before that, the first key press
 * may reach nothing. Enter with no button focused starts a recording from
 * the `ask` state. It never stops one.
 */
export function Pill({ autoDismissMs = DEFAULT_AUTO_DISMISS_MS }: PillProps) {
  const [payload, setPayload] = useState<MeetingPopupPayloadEvent | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Bumped on every payload. It resets `resolvedRef` and re-arms the
  // auto-dismiss effect for each new showing of the reused window.
  const [generation, setGeneration] = useState(0)
  // Stops a double resolve of one showing, such as the timer firing while a
  // click is in flight.
  const resolvedRef = useRef(false)

  const kind = payload?.kind ?? 'ask'
  const appName = payload?.appName ?? null

  useEffect(() => {
    let live = true
    let unlisten: (() => void) | undefined
    onMeetingPopupPayload(next => {
      if (!live) return
      setPayload(next)
      setElapsed(0)
      resolvedRef.current = false
      setGeneration(g => g + 1)
    }).then(fn => {
      if (live) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      live = false
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (kind !== 'started') return
    let live = true
    let unlisten: (() => void) | undefined
    onRecordingState(state => {
      if (live && state.state !== 'stopped') setElapsed(state.elapsed)
    }).then(fn => {
      if (live) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      live = false
      unlisten?.()
    }
  }, [kind, generation])

  // Best-effort: the popup has no error surface of its own. The main window
  // reports a real failure once the event reaches it.
  const start = useCallback(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    popupStart().catch(() => {})
  }, [])

  const stop = useCallback(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    popupStop().catch(() => {})
  }, [])

  const dismiss = useCallback((timedOut: boolean) => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    popupDismiss(timedOut).catch(() => {})
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => dismiss(true), autoDismissMs)
    return () => clearTimeout(timer)
  }, [autoDismissMs, dismiss, generation])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter' && kind === 'ask') {
        // Enter on a focused button presses that button. Dismiss must not record.
        if (e.target instanceof HTMLButtonElement) return
        e.preventDefault()
        start()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        dismiss(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [kind, start, dismiss])

  if (kind === 'started') {
    return (
      <div role="dialog" aria-label="Recording started automatically" className="popup-pill">
        <span aria-hidden="true" className="popup-pill-dot" />
        <div className="popup-pill-text">
          <div className="popup-pill-title">{appName ? `Recording ${appName}` : 'Recording'}</div>
          <div className="popup-pill-detail">Started automatically · {formatElapsed(elapsed)}</div>
        </div>
        <button type="button" onClick={stop} className="popup-pill-stop">
          Stop
        </button>
      </div>
    )
  }

  return (
    <div role="dialog" aria-label="Meeting detected" className="popup-pill">
      <div className="popup-pill-text">
        <div className="popup-pill-title">{appName ? `${appName} meeting started` : 'Meeting started'}</div>
        <div className="popup-pill-detail">Minute is not recording.</div>
      </div>
      <button type="button" onClick={() => dismiss(false)} className="popup-pill-dismiss">
        Dismiss
      </button>
      <button type="button" onClick={start} className="popup-pill-record">
        <span aria-hidden="true" className="popup-pill-dot" />
        Record
      </button>
    </div>
  )
}
