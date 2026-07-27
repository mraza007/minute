import { useCallback, useEffect, useRef, useState } from 'react'
import { popupDismiss, popupStart } from '../ipc/commands'
import { onMeetingPopupPayload } from '../ipc/events'

/** The popup's own 12s auto-dismiss window — see the plan's Task 2 spec ("Auto-dismiss after 12s"). Exposed as a prop default (not hardcoded inline) so tests can drive the countdown on a short, fake-timer-free window instead of waiting out a real 12s. */
export const DEFAULT_AUTO_DISMISS_MS = 12_000

interface PillProps {
  autoDismissMs?: number
}

/**
 * The "meeting detected" pill rendered inside the popup window (see
 * src-tauri/src/popup.rs) — mic glyph, "Meeting detected" + the triggering
 * app's name, a [Start recording] accent-solid button, a quiet × dismiss,
 * and a hairline countdown bar that auto-dismisses after `autoDismissMs`.
 *
 * The window this renders into is created transparent and non-activating
 * (see popup.rs's module docs) — this component is what actually carries
 * the visible surface (var(--card)/var(--border) + a CSS shadow, never a
 * native window shadow — see popup.rs's `.shadow(false)`).
 *
 * ## Keyboard caveat
 * Enter/Escape are wired below via a plain `window` keydown listener, but
 * whether they're ever actually reachable depends on AppKit having made the
 * panel key at all — `popup.rs`'s initial `panel.show()` deliberately does
 * *not* do that (it's `orderFrontRegardless`, chosen precisely so appearing
 * doesn't steal focus). A `nonactivating` NSPanel *can* still become key
 * without activating Minute if the user clicks into it (the standard
 * non-activating-panel recipe), at which point these listeners do start
 * receiving events — but the very first `Enter`/`Escape` press, before any
 * click, may land on nothing. This is implemented anyway (a real accessible
 * fallback whenever the panel does have keyboard focus) rather than
 * skipped, but it's an honest best-effort, not a guarantee — see popup.rs's
 * own "what's verified vs. release-build-only" note for the same caveat
 * applied to the panel's AppKit behavior generally.
 */
export function Pill({ autoDismissMs = DEFAULT_AUTO_DISMISS_MS }: PillProps) {
  const [appName, setAppName] = useState<string | null>(null)
  // Bumped every time a new `meeting-popup-payload` arrives. The popup
  // window itself is created once and reused for the app's whole session
  // (see popup.rs's `ensure_window`) — `show_meeting_prompt` never remounts
  // this component between detections, it just re-emits the payload event
  // into the same still-mounted webview. Without something like this,
  // `resolvedRef` (below) would stay latched from the *first* detection's
  // resolution forever, and the auto-dismiss effect (also below) would
  // never re-arm — the second (and every later) detection would show a
  // pill whose buttons quietly do nothing and whose countdown never fires,
  // rather than actually resolving. `generation` is what both resets
  // `resolvedRef` and re-triggers the auto-dismiss effect for each new
  // prompt; the countdown bar below also keys off it to restart its CSS
  // animation from the beginning.
  const [generation, setGeneration] = useState(0)
  // Guards against a double-resolve for the *same* shown prompt (e.g. the
  // auto-dismiss timer firing the same instant a click is already in
  // flight) — reset to `false` every time `generation` bumps (a fresh
  // prompt to resolve), not just once at mount; see `generation`'s own docs
  // above.
  const resolvedRef = useRef(false)

  useEffect(() => {
    let live = true
    let unlisten: (() => void) | undefined
    onMeetingPopupPayload(payload => {
      if (!live) return
      setAppName(payload.appName)
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

  const start = useCallback(() => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    // Best-effort: this tiny popup window has no error-reporting surface of
    // its own (that's the main window's ErrorBanner/reportError) — a
    // rejected IPC call here has nothing more specific to show; the main
    // window still gets its own chance to report a real failure once (if)
    // `meeting-popup-start` reaches it.
    popupStart().catch(() => {})
  }, [])

  const dismiss = useCallback((timedOut: boolean) => {
    if (resolvedRef.current) return
    resolvedRef.current = true
    popupDismiss(timedOut).catch(() => {})
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => dismiss(true), autoDismissMs)
    return () => clearTimeout(timer)
    // Re-arms on every new `generation` (a fresh prompt to auto-dismiss) —
    // without this dependency, only the very first detection's timer would
    // ever run; see `generation`'s docs above.
  }, [autoDismissMs, dismiss, generation])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter') {
        e.preventDefault()
        start()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        dismiss(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [start, dismiss])

  return (
    <div
      role="dialog"
      aria-label="Meeting detected"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        // 470, not the plan's original "~380" — at 380 the subtitle's
        // `textOverflow: ellipsis` (below) genuinely clips real copy in the
        // shipped app, not just this marketing render: "Another app is
        // using the microphone" (the default, pre-payload text) and
        // "Microsoft Teams is using the microphone" (the longest
        // allowlisted app name — see detect.rs's `find_allowlisted`) both
        // overflowed the old 380px pill mid-word. Confirmed against a real
        // `popup.html` render at the window's exact logical size before
        // widening. Keep in lockstep with `PANEL_WIDTH` in
        // src-tauri/src/popup.rs — that's the actual native window size
        // this pill is created into.
        width: 470,
        height: 72,
        boxSizing: 'border-box',
        padding: '0 14px',
        margin: 8,
        borderRadius: 999,
        // Paper, like every other surface in the app — but this one floats
        // over an arbitrary desktop, so it keeps its border and shadow (the
        // only shadowed surface left) to separate itself from whatever is
        // behind it. See --shadow-pill in index.css.
        background: 'var(--panel)',
        border: '1px solid var(--rule-strong)',
        boxShadow: 'var(--shadow-pill)',
        overflow: 'hidden',
        fontFamily: 'var(--sans)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'var(--accent-tint)',
          color: 'var(--accent-text)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" x2="12" y1="19" y2="22"></line>
        </svg>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.11em', textTransform: 'uppercase', color: 'var(--ink)' }}>
          Meeting detected
        </div>
        <div
          style={{
            marginTop: 2,
            fontFamily: 'var(--serif)',
            fontSize: 13,
            color: 'var(--ink-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {appName ? `${appName} is using the microphone` : 'Another app is using the microphone'}
        </div>
      </div>

      <button
        type="button"
        onClick={start}
        className="btn-record"
        style={{ flex: 'none', padding: '8px 15px' }}
      >
        Start recording
      </button>

      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(false)}
        className="icon-btn"
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          border: 'none',
          borderRadius: '50%',
          background: 'transparent',
          color: 'var(--ink-faint)',
          fontSize: 15,
          lineHeight: 1,
          cursor: 'pointer',
        }}
      >
        ×
      </button>

      <div
        // Keyed on `generation` so React remounts a fresh element (rather
        // than patching the existing one's style) on every new detection —
        // a CSS animation on an element that never remounts doesn't replay
        // just because its `animationDuration` value is set again, so
        // without this the bar would stay visually frozen at 0% width for
        // every showing after the first.
        key={generation}
        className="popup-countdown-bar"
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '100%',
          height: 2,
          background: 'var(--accent)',
          animationDuration: `${autoDismissMs}ms`,
        }}
      />
    </div>
  )
}
