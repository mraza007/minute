import type { ModelStatus, Recommendation } from '../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../state/adapters'
import { DownloadProgressBar } from './DownloadProgressBar'

export interface OnboardingViewProps {
  models: ModelStatus[]
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  onDownload: (id: string) => void
  onCancel: (id: string) => void
  onStart: () => void
}

function ModelCard({
  entry,
  downloads,
  inUseId,
  onDownload,
  onCancel,
  footnote,
}: {
  entry: ModelStatus
  downloads: Record<string, DownloadProgressState>
  inUseId: string
  onDownload: (id: string) => void
  onCancel: (id: string) => void
  footnote?: string
}) {
  const info = modelStatusToSttInfo(entry, inUseId, downloads)
  const progress = downloads[entry.id]

  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border-soft)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 1px 3px rgba(0,0,0,.04)',
        padding: '16px 18px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <b>{info.displayName}</b> — {info.desc}
          <br />
          <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{info.sub}</span>
        </div>
        {info.state === 'notInstalled' && (
          <button
            className="btn-rec"
            onClick={() => onDownload(entry.id)}
            style={{
              flex: 'none',
              padding: '8px 16px',
              border: 'none',
              borderRadius: 999,
              background: 'var(--accent-solid)',
              color: '#fff',
              fontFamily: 'inherit',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Download ({formatBytes(entry.sizeBytes)})
          </button>
        )}
        {info.state === 'downloading' && (
          <button
            className="btn-light"
            onClick={() => onCancel(entry.id)}
            style={{
              flex: 'none',
              padding: '8px 16px',
              border: '1px solid var(--border-strong)',
              borderRadius: 999,
              background: 'var(--card)',
              color: 'var(--ink)',
              fontFamily: 'inherit',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {info.state === 'downloading' && progress && <DownloadProgressBar downloaded={progress.downloaded} total={progress.total} />}
      {footnote && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-faint)' }}>{footnote}</div>}
    </div>
  )
}

export function OnboardingView({ models, recommendation, downloads, onDownload, onCancel, onStart }: OnboardingViewProps) {
  const sttEntry = recommendation ? models.find(m => m.id === recommendation.stt) : undefined
  const llmEntry = recommendation ? models.find(m => m.id === recommendation.llm) : undefined
  const hasInstalledStt = models.some(m => m.kind === 'stt' && m.state === 'installed')

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel)' }}>
      <div style={{ width: 560, maxWidth: '92vw', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ background: 'var(--ink)', color: '#fff', borderRadius: 'var(--radius-lg)', padding: '26px 30px', boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
          <div style={{ fontWeight: 700, fontSize: 21, letterSpacing: '-.02em' }}>Minute runs entirely on this Mac.</div>
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,.75)' }}>
            No account. No cloud. No network permission. Download a transcription model to get started — everything after
            this, recording, transcription, and notes, runs completely offline.
          </div>
        </div>

        {sttEntry && (
          <ModelCard entry={sttEntry} downloads={downloads} inUseId={recommendation?.stt ?? ''} onDownload={onDownload} onCancel={onCancel} />
        )}

        {llmEntry && (
          <ModelCard
            entry={llmEntry}
            downloads={downloads}
            inUseId={recommendation?.llm ?? ''}
            onDownload={onDownload}
            onCancel={onCancel}
            footnote="You can add this later — summaries arrive in a future update."
          />
        )}

        <button
          disabled={!hasInstalledStt}
          onClick={onStart}
          className="btn-rec"
          style={{
            padding: '12px 22px',
            border: 'none',
            borderRadius: 999,
            background: hasInstalledStt ? 'var(--accent-solid)' : '#d8d4cf',
            color: hasInstalledStt ? '#fff' : 'var(--ink-muted)',
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 13,
            cursor: hasInstalledStt ? 'pointer' : 'not-allowed',
            boxShadow: hasInstalledStt ? '0 1px 4px rgba(224,68,48,.35)' : 'none',
          }}
        >
          Start using Minute
        </button>
      </div>
    </div>
  )
}
