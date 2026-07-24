import { formatMmSs } from '../state/adapters'

interface PlayerBarProps {
  /** The note's real recorded duration — playback itself is Stage 4, so elapsed stays a static 00:00 and progress stays 0% (an honest empty state rather than a fabricated position). */
  durationSec: number
}

export function PlayerBar({ durationSec }: PlayerBarProps) {
  return (
    <div style={{ padding: '12px 32px 16px', flex: 'none' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'var(--card)',
          border: '1px solid rgba(0,0,0,.08)',
          borderRadius: 'var(--radius-md)',
          padding: '10px 16px',
          boxShadow: '0 1px 4px rgba(0,0,0,.06)',
        }}
      >
        <button
          disabled
          aria-disabled="true"
          aria-label="Back 15s"
          title="Back 15s — playback arrives in a later update."
          className="icon-btn"
          style={{
            width: 30,
            height: 30,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            color: 'var(--ink-muted)',
            cursor: 'default',
            opacity: 0.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
        </button>
        <button
          className="btn-dark"
          aria-label="Play"
          title="Play"
          style={{
            width: 36,
            height: 36,
            border: 'none',
            borderRadius: '50%',
            background: 'var(--ink)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="6 3 20 12 6 21 6 3"></polygon>
          </svg>
        </button>
        <button
          disabled
          aria-disabled="true"
          aria-label="Forward 15s"
          title="Forward 15s — playback arrives in a later update."
          className="icon-btn"
          style={{
            width: 30,
            height: 30,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            color: 'var(--ink-muted)',
            cursor: 'default',
            opacity: 0.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
            <path d="M21 3v5h-5"></path>
          </svg>
        </button>
        <div style={{ flex: 1, height: 5, borderRadius: 999, background: '#e8e5e1', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: '0 100% 0 0', borderRadius: 999, background: 'var(--ink)' }} />
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '0%',
              top: -4,
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: 'var(--card)',
              border: '2.5px solid var(--accent)',
              boxShadow: '0 1px 3px rgba(0,0,0,.2)',
            }}
          />
        </div>
        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--ink-muted)', flex: 'none' }}>
          00:00 / {formatMmSs(durationSec)}
        </div>
        <button
          disabled
          aria-disabled="true"
          aria-label="Playback speed"
          title="Playback speed — playback arrives in a later update."
          className="btn-light"
          style={{
            padding: '6px 10px',
            border: '1px solid var(--border-strong)',
            borderRadius: 999,
            background: 'var(--card)',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--ink)',
            cursor: 'default',
            opacity: 0.5,
            flex: 'none',
          }}
        >
          1.5×
        </button>
      </div>
    </div>
  )
}
