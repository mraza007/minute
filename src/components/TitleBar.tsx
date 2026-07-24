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
        gap: 12,
        height: 52,
        padding: '0 16px 0 76px',
        background: 'var(--panel-warm)',
        borderBottom: '1px solid var(--border)',
        flex: 'none',
      }}
    >
      <div data-tauri-drag-region="" style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-.01em' }}>Minute</div>
      <div
        data-tauri-drag-region=""
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '5px 12px',
          borderRadius: 999,
          background: 'var(--ok-tint)',
          border: '1px solid var(--ok-text)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ok-text)',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok-text)' }} />
        Offline · On-device
      </div>
      <div data-tauri-drag-region="" style={{ flex: 1 }} />
      {isRecording && (
        <button
          type="button"
          aria-label="Return to recording"
          onClick={onReturnToRecording}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 14px',
            border: 'none',
            borderRadius: 999,
            background: 'var(--accent-tint)',
            color: 'var(--accent-text)',
            fontFamily: 'inherit',
            fontWeight: 700,
            fontSize: 13,
            fontVariantNumeric: 'tabular-nums',
            cursor: 'pointer',
          }}
        >
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
        <button
          onClick={onStartRec}
          className="btn-rec"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 18px',
            border: 'none',
            borderRadius: 999,
            background: 'var(--accent-solid)',
            color: '#fff',
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(224,68,48,.35)',
          }}
        >
          <svg
            width="14"
            height="14"
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
