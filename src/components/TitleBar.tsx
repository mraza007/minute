interface TitleBarProps {
  isRecording: boolean
  recTime: string
  onStartRec: () => void
  /** Returns to the recording view — the REC pill is clickable so a recording started while on Notes/Settings stays reachable from anywhere. */
  onReturnToRecording: () => void
}

export function TitleBar({ isRecording, recTime, onStartRec, onReturnToRecording }: TitleBarProps) {
  return (
    <div
      data-tauri-drag-region=""
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 52,
        padding: '0 16px 0 76px',
        background: '#eceae7',
        borderBottom: '1px solid rgba(0,0,0,.09)',
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
          background: 'rgba(40,167,69,.1)',
          border: '1px solid rgba(40,167,69,.25)',
          fontSize: 12,
          fontWeight: 600,
          color: '#1e7c34',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#28a745' }} />
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
            background: '#ffe6e1',
            color: '#b3200c',
            fontFamily: 'inherit',
            fontWeight: 700,
            fontSize: 12.5,
            fontVariantNumeric: 'tabular-nums',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#e04430',
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
            background: '#e04430',
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
    </div>
  )
}
