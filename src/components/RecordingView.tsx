import { memo } from 'react'
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
    <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-text)', fontSize: 13, fontWeight: 600 }}>
      <span style={{ width: 8, height: 16, borderRadius: 3, background: 'var(--accent)', display: 'inline-block', animation: 'blink 1s step-end infinite' }} />
      transcribing…
    </div>
  )
}

function SttErrorRow({ sttError }: { sttError: string | null }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        background: 'var(--accent-tint)',
        border: '1px solid rgba(224,68,48,.3)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 14px',
        color: 'var(--accent-text)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>Recording continues — transcript unavailable</div>
      {sttError && <div style={{ fontSize: 12, color: 'var(--accent-text)' }}>{sttError}</div>}
    </div>
  )
}

// Memoized (same precedent as Waveform) so a parent re-render that doesn't
// actually change these props — e.g. the 1Hz `recording-state` tick, which
// only touches `recElapsed` up in TitleBar, not anything passed here —
// doesn't force the whole segment list to re-render every second.
const LiveTranscriptBody = memo(function LiveTranscriptBody({
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
      return <div style={{ fontSize: 13, color: 'var(--ink-faint)' }}>Loading {modelName}…</div>
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
            <span style={{ color: 'var(--ink-faint)' }}>{formatMmSs(group.start)}</span>
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink-body)', textWrap: 'pretty' }}>{group.text}</div>
        </div>
      ))}
      {sttStatus === 'error' ? <SttErrorRow sttError={sttError} /> : <TranscribingIndicator />}
    </>
  )
})

export const RecordingView = memo(function RecordingView({
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
    <main style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--surface-soft)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div style={{ padding: '16px 32px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div role="radiogroup" aria-label="Audio source" style={{ display: 'flex', background: 'var(--panel-warm)', borderRadius: 9, padding: 3 }}>
            <button
              type="button"
              role="radio"
              aria-checked="true"
              tabIndex={0}
              style={{
                padding: '6px 14px',
                borderRadius: 7,
                border: 'none',
                background: 'var(--card)',
                boxShadow: '0 1px 3px rgba(0,0,0,.1)',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                color: 'inherit',
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
            </button>
            <button
              type="button"
              role="radio"
              aria-checked="false"
              aria-disabled="true"
              disabled
              tabIndex={-1}
              title="System audio arrives in a later update."
              style={{
                padding: '6px 14px',
                borderRadius: 7,
                border: 'none',
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--ink-muted)',
                display: 'flex',
                gap: 7,
                alignItems: 'center',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <rect width="20" height="14" x="2" y="3" rx="2"></rect>
                <line x1="8" x2="16" y1="21" y2="21"></line>
                <line x1="12" x2="12" y1="17" y2="21"></line>
              </svg>
              System audio
            </button>
          </div>
          <Waveform paused={paused} />
          <div style={{ fontSize: 12, color: 'var(--ink-faint)', flex: 'none' }}>{modelName} · on-device</div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 740 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--ink-faint)' }}>LIVE TRANSCRIPT — AUDIO NEVER LEAVES THIS MACHINE</div>
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
              background: 'var(--accent-solid)',
              color: '#fff',
              fontFamily: 'inherit',
              fontWeight: 600,
              fontSize: 13,
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
            style={{ padding: '11px 22px', border: '1px solid rgba(0,0,0,.14)', borderRadius: 999, background: 'var(--card)', color: 'var(--ink)', fontFamily: 'inherit', fontWeight: 600, fontSize: 13, cursor: stopping ? 'default' : 'pointer', opacity: stopping ? 0.6 : 1 }}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            disabled
            aria-disabled="true"
            title="Markers arrive in a later update."
            className="btn-light"
            style={{ padding: '11px 22px', border: '1px solid rgba(0,0,0,.14)', borderRadius: 999, background: 'var(--card)', color: 'var(--ink)', fontFamily: 'inherit', fontWeight: 600, fontSize: 13, cursor: 'default', opacity: 0.5 }}
          >
            Add marker
          </button>
        </div>
      </div>
      <div style={{ width: 330, flex: 'none', borderLeft: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)' }}>
        <h2 style={{ margin: 0, padding: '16px 16px 12px', fontWeight: 700, fontSize: 14 }}>Live insights</h2>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--ink-faint)', marginBottom: 6 }}>LIVE INSIGHTS</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-faint)' }}>Live insights arrive in a later update.</div>
          </div>
          <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 'var(--radius-md)', padding: '12px 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--ink-faint)' }}>
            Transcription runs on-device — nothing leaves this machine.
          </div>
        </div>
      </div>
    </main>
  )
})
