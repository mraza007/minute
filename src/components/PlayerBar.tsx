export function PlayerBar() {
  return (
    <div style={{ padding: '12px 32px 16px', flex: 'none' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#fff',
          border: '1px solid rgba(0,0,0,.08)',
          borderRadius: 12,
          padding: '10px 16px',
          boxShadow: '0 1px 4px rgba(0,0,0,.06)',
        }}
      >
        <button
          title="Back 15s"
          className="icon-btn"
          style={{
            width: 30,
            height: 30,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            color: '#6d675f',
            cursor: 'pointer',
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
            background: '#1c1a18',
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
          title="Forward 15s"
          className="icon-btn"
          style={{
            width: 30,
            height: 30,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            color: '#6d675f',
            cursor: 'pointer',
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
          <div style={{ position: 'absolute', inset: '0 62% 0 0', borderRadius: 999, background: '#1c1a18' }} />
          <div
            style={{
              position: 'absolute',
              left: '38%',
              top: -4,
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: '#fff',
              border: '2.5px solid #e04430',
              boxShadow: '0 1px 3px rgba(0,0,0,.2)',
            }}
          />
        </div>
        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: '#8d867f', flex: 'none' }}>18:21 / 48:22</div>
        <button
          className="btn-light"
          style={{
            padding: '4px 10px',
            border: '1px solid rgba(0,0,0,.12)',
            borderRadius: 999,
            background: '#fff',
            fontFamily: 'inherit',
            fontSize: 11.5,
            fontWeight: 700,
            color: '#1c1a18',
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          1.5×
        </button>
      </div>
    </div>
  )
}
