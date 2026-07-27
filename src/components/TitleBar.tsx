import { memo } from 'react'

interface TitleBarProps {
  isRecording: boolean
  recTime: string
  onStartRec: () => void
  /** Returns to the recording view — the REC pill is clickable so a recording started while on Notes/Settings stays reachable from anywhere. */
  onReturnToRecording: () => void
}

// Memoized so App re-renders for unrelated reasons (e.g. a note being
// selected) don't also re-render TitleBar — `recTime` still ticks it once a
// second while `isRecording`, same as before, since that's a real prop
// change; this only skips the *other* renders.
export const TitleBar = memo(function TitleBar({ isRecording, recTime, onStartRec, onReturnToRecording }: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region=""
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        height: 48,
        padding: '0 16px 0 76px',
        background: 'var(--panel-warm)',
        borderBottom: '1px solid var(--rule)',
        flex: 'none',
      }}
    >
      <div data-tauri-drag-region="" style={{ fontWeight: 600, fontSize: 14, letterSpacing: '-.005em' }}>Minute</div>
      {/* The on-device assurance sits permanently in the chrome rather than
          in a banner that can be dismissed or scrolled past — it's the
          product's core promise, so it reads as a property of the window
          itself. */}
      <div
        data-tauri-drag-region=""
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-muted)' }}
      >
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ok-text)' }} />
        on-device
      </div>
      <div data-tauri-drag-region="" style={{ flex: 1 }} />
      {isRecording && (
        <button type="button" aria-label="Return to recording" onClick={onReturnToRecording} className="rec-chip">
          <span
            className="blink-dot"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--accent)',
              animation: 'blink 1.2s step-end infinite',
            }}
          />
          REC {recTime}
        </button>
      )}
      {!isRecording && (
        <button onClick={onStartRec} className="btn-record">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" x2="12" y1="19" y2="22"></line>
          </svg>
          New recording
        </button>
      )}
    </header>
  )
})
