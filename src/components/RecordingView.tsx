import type { LiveTranscriptGroup } from '../state/adapters'
import { formatMmSs } from '../state/adapters'
import type { SttStatus } from '../types'
import { Waveform } from './Waveform'

interface RecordingViewProps {
  liveSegments: LiveTranscriptGroup[]
  paused: boolean
  togglePause: () => void
  stopRec: () => void
  stopping: boolean
  sttStatus: SttStatus
  sttError: string | null
  modelName: string
}

function TranscribingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b3200c', fontSize: 13, fontWeight: 600 }}>
      <span style={{ width: 8, height: 16, borderRadius: 3, background: '#e04430', display: 'inline-block', animation: 'blink 1s step-end infinite' }} />
      transcribing…
    </div>
  )
}

function SttErrorRow({ sttError }: { sttError: string | null }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        background: '#ffe6e1',
        border: '1px solid rgba(224,68,48,.3)',
        borderRadius: 10,
        padding: '10px 14px',
        color: '#b3200c',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>Recording continues — transcript unavailable</div>
      {sttError && <div style={{ fontSize: 12, color: '#c65847' }}>{sttError}</div>}
    </div>
  )
}

function LiveTranscriptBody({
  liveSegments,
  sttStatus,
  sttError,
  modelName,
}: {
  liveSegments: LiveTranscriptGroup[]
  sttStatus: SttStatus
  sttError: string | null
  modelName: string
}) {
  if (liveSegments.length === 0) {
    if (sttStatus === 'loading') {
      return <div style={{ fontSize: 13, color: '#9a938c' }}>Loading {modelName}…</div>
    }
    if (sttStatus === 'error') {
      return <SttErrorRow sttError={sttError} />
    }
    return <TranscribingIndicator />
  }

  return (
    <>
      {liveSegments.map((group, i) => (
        <div key={i}>
          <div style={{ display: 'flex', gap: 9, fontSize: 12, marginBottom: 3, alignItems: 'baseline' }}>
            <b>{group.speaker}</b>
            <span style={{ color: '#b0a9a2' }}>{formatMmSs(group.start)}</span>
          </div>
          <div style={{ fontSize: 14.5, lineHeight: 1.65, color: '#33302c', textWrap: 'pretty' }}>{group.text}</div>
        </div>
      ))}
      {sttStatus === 'error' ? <SttErrorRow sttError={sttError} /> : <TranscribingIndicator />}
    </>
  )
}

export function RecordingView({
  liveSegments,
  paused,
  togglePause,
  stopRec,
  stopping,
  sttStatus,
  sttError,
  modelName,
}: RecordingViewProps) {
  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, background: '#f7f6f4' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div style={{ padding: '16px 32px', borderBottom: '1px solid rgba(0,0,0,.07)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div role="group" aria-label="Audio source" style={{ display: 'flex', background: '#eceae7', borderRadius: 9, padding: 3 }}>
            <div
              style={{
                padding: '6px 14px',
                borderRadius: 7,
                background: '#fff',
                boxShadow: '0 1px 3px rgba(0,0,0,.1)',
                fontSize: 12.5,
                fontWeight: 600,
                display: 'flex',
                gap: 7,
                alignItems: 'center',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              </svg>
              Microphone
            </div>
            <div
              className="seg-off"
              aria-disabled="true"
              style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, color: '#6d675f', display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <rect width="20" height="14" x="2" y="3" rx="2"></rect>
                <line x1="8" x2="16" y1="21" y2="21"></line>
                <line x1="12" x2="12" y1="17" y2="21"></line>
              </svg>
              System audio
            </div>
          </div>
          <Waveform paused={paused} />
          <div style={{ fontSize: 12, color: '#9a938c', flex: 'none' }}>{modelName} · on-device</div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 740 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#9a938c' }}>LIVE TRANSCRIPT — AUDIO NEVER LEAVES THIS MACHINE</div>
          <LiveTranscriptBody liveSegments={liveSegments} sttStatus={sttStatus} sttError={sttError} modelName={modelName} />
        </div>
        <div style={{ padding: '14px 32px 18px', display: 'flex', gap: 10, flex: 'none' }}>
          <button
            onClick={stopRec}
            disabled={stopping}
            className="btn-rec"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '11px 22px',
              border: 'none',
              borderRadius: 999,
              background: '#e04430',
              color: '#fff',
              fontFamily: 'inherit',
              fontWeight: 600,
              fontSize: 13.5,
              cursor: stopping ? 'default' : 'pointer',
              opacity: stopping ? 0.7 : 1,
              boxShadow: '0 1px 4px rgba(224,68,48,.35)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect width="12" height="12" x="6" y="6" rx="2"></rect>
            </svg>
            {stopping ? 'Finishing…' : 'Stop & transcribe'}
          </button>
          <button
            onClick={togglePause}
            disabled={stopping}
            className="btn-light"
            style={{ padding: '11px 22px', border: '1px solid rgba(0,0,0,.14)', borderRadius: 999, background: '#fff', color: '#1c1a18', fontFamily: 'inherit', fontWeight: 600, fontSize: 13.5, cursor: stopping ? 'default' : 'pointer', opacity: stopping ? 0.6 : 1 }}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            disabled={stopping}
            className="btn-light"
            style={{ padding: '11px 22px', border: '1px solid rgba(0,0,0,.14)', borderRadius: 999, background: '#fff', color: '#1c1a18', fontFamily: 'inherit', fontWeight: 600, fontSize: 13.5, cursor: stopping ? 'default' : 'pointer', opacity: stopping ? 0.6 : 1 }}
          >
            Add marker
          </button>
        </div>
      </div>
      <div style={{ width: 330, flex: 'none', borderLeft: '1px solid rgba(0,0,0,.07)', display: 'flex', flexDirection: 'column', minHeight: 0, background: '#f2f0ee' }}>
        <div style={{ padding: '16px 16px 12px', fontWeight: 700, fontSize: 14 }}>Live insights</div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,.07)', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#b3200c', marginBottom: 8 }}>ACTION ITEMS · SO FAR</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: '#33302c', display: 'flex', gap: 8, marginBottom: 7 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1c1a18', flex: 'none', marginTop: 7 }} />
              Add security-review milestone to the board timeline slide.
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: '#33302c', display: 'flex', gap: 8 }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1c1a18', flex: 'none', marginTop: 7 }} />
              Draft headcount ask: two hires, on-device inference team.
            </div>
          </div>
          <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,.07)', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#b3200c', marginBottom: 6 }}>KEY POINTS</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: '#33302c', textWrap: 'pretty' }}>
              Churn down three consecutive months. Acme expansion offsets SMB shortfall. Security review gates the 200-seat rollout.
            </div>
          </div>
          <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 12, padding: '12px 14px', fontSize: 12, lineHeight: 1.55, color: '#9a938c' }}>
            Insights refresh every 60 s while recording. Model runs on the Neural Engine — battery impact ~4%/hr.
          </div>
        </div>
      </div>
    </div>
  )
}
