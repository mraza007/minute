import { useState } from 'react'
import type { ModelStatus, Recommendation } from '../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../state/adapters'
import { DownloadProgressBar } from './DownloadProgressBar'
import { Toggle } from './Toggle'

export interface OnboardingViewProps {
  models: ModelStatus[]
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  onDownload: (id: string) => void
  onCancel: (id: string) => void
  /**
   * "Start using Minute" — receives the opt-in row's checked state (see
   * `meetingDetectionOptIn` below) so `useAppState`'s `completeOnboarding`
   * can persist it in the same call that finalizes onboarding, rather than
   * this view needing its own separate `set_settings` call.
   */
  onStart: (meetingDetectionOptIn: boolean) => void
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
              color: 'var(--text-on-accent)',
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

  // Quiet, opt-in meeting-detection row — default unchecked. Notion's own
  // opt-out backlash (turning a similar feature on by default) is the
  // lesson the plan explicitly calls out: onboarding must never pre-check
  // this. Local to this view (not yet a real setting) until "Start using
  // Minute" is actually clicked — see `onStart`'s docs for why the write
  // happens on completion rather than immediately on toggle.
  const [meetingDetectionOptIn, setMeetingDetectionOptIn] = useState(false)

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel)' }}>
      <div style={{ width: 560, maxWidth: '92vw', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ background: 'var(--banner-bg)', color: 'var(--banner-text)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-lg)', padding: '26px 30px', boxShadow: '0 2px 8px rgba(0,0,0,.15)' }}>
          <div style={{ fontWeight: 700, fontSize: 21, letterSpacing: '-.02em' }}>Minute runs entirely on this Mac.</div>
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--banner-text-muted)' }}>
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

        <div
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 18px',
          }}
        >
          <Toggle
            on={meetingDetectionOptIn}
            onToggle={() => setMeetingDetectionOptIn(v => !v)}
            label="Offer to record when a meeting starts — you can change this anytime in Settings."
          />
        </div>

        <button
          disabled={!hasInstalledStt}
          onClick={() => onStart(meetingDetectionOptIn)}
          className="btn-rec"
          style={{
            padding: '12px 22px',
            border: 'none',
            borderRadius: 999,
            background: hasInstalledStt ? 'var(--accent-solid)' : 'var(--control-track)',
            color: hasInstalledStt ? 'var(--text-on-accent)' : 'var(--ink-muted)',
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 13,
            cursor: hasInstalledStt ? 'pointer' : 'not-allowed',
            boxShadow: hasInstalledStt ? '0 1px 4px rgba(var(--accent-rgb), .35)' : 'none',
          }}
        >
          Start using Minute
        </button>
      </div>
    </div>
  )
}
