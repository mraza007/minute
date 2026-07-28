import { useState } from 'react'
import type { Hardware, ModelStatus, Recommendation } from '../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../state/adapters'
import { DownloadProgressBar } from './DownloadProgressBar'
import { assessModelSuitability } from '../state/modelSuitability'
import { HardwareSummary, ModelSuitabilityLine } from './ModelSuitability'
import { Toggle } from './Toggle'

export interface OnboardingViewProps {
  models: ModelStatus[]
  hardware: Hardware | null
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
  hardware,
  recommendation,
  downloads,
  inUseId,
  onDownload,
  onCancel,
  footnote,
}: {
  entry: ModelStatus
  hardware: Hardware | null
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  inUseId: string
  onDownload: (id: string) => void
  onCancel: (id: string) => void
  footnote?: string
}) {
  const info = modelStatusToSttInfo(entry, inUseId, downloads)
  const progress = downloads[entry.id]
  const suitability = assessModelSuitability(entry, hardware, recommendation)

  return (
    <div style={{ padding: '16px 0', borderTop: '1px solid var(--rule)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 13.5, lineHeight: 1.5 }}>
          <b style={{ fontWeight: 700 }}>{info.displayName}</b> — {info.desc}
          <br />
          <span style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-faint)' }}>{info.sub}</span>
          <ModelSuitabilityLine result={suitability} />
        </div>
        {info.state === 'notInstalled' && (
          <button className="btn-solid" onClick={() => onDownload(entry.id)} style={{ flex: 'none', whiteSpace: 'nowrap' }}>
            Download ({formatBytes(entry.sizeBytes)})
          </button>
        )}
        {info.state === 'downloading' && (
          <button className="btn-outline" onClick={() => onCancel(entry.id)} style={{ flex: 'none' }}>
            Cancel
          </button>
        )}
      </div>
      {info.state === 'downloading' && progress && <DownloadProgressBar downloaded={progress.downloaded} total={progress.total} />}
      {footnote && (
        <div style={{ marginTop: 9, fontFamily: 'var(--serif)', fontSize: 12.5, color: 'var(--ink-faint)' }}>{footnote}</div>
      )}
    </div>
  )
}

export function OnboardingView({ models, hardware, recommendation, downloads, onDownload, onCancel, onStart }: OnboardingViewProps) {
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
    <div className="app-paper onboarding-page">
      <div className="onboarding-sheet">
        {/* The trust statement is the first thing on the page and reads as a
            title page, not a banner in a box: the promise is the product, so
            it's set at document scale in the serif rather than boxed off as
            a notice the eye learns to skip. */}
        <h1 style={{ margin: 0, fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 30, lineHeight: 1.16, letterSpacing: '-.015em' }}>
          Minute runs entirely on this Mac.
        </h1>
        <p style={{ margin: '12px 0 26px', fontFamily: 'var(--serif)', fontSize: 14.5, lineHeight: 1.6, color: 'var(--ink-muted)', maxWidth: '52ch' }}>
          No account and no cloud processing. Minute connects only when you choose to download a model; recordings,
          transcripts, summaries, and questions stay on this Mac.
        </p>

        <div className="onboarding-privacy-facts" aria-label="Privacy and permissions">
          <div>
            <span className="mlab">Microphone</span>
            <p>Requested when you start your first recording. Minute captures only while the recording indicator is visible.</p>
          </div>
          <div>
            <span className="mlab">System audio</span>
            <p>Optional. macOS Screen Recording permission is requested only when you choose to include call audio.</p>
          </div>
          <div>
            <span className="mlab">Storage</span>
            <p>Notes and audio are ordinary local files covered by your Mac’s FileVault settings.</p>
          </div>
        </div>

        <HardwareSummary hardware={hardware} />

        <div className="sec-head" style={{ marginBottom: 2 }}>
          <h2 className="mlab" style={{ margin: 0 }}>Models</h2>
        </div>

        {sttEntry && (
          <ModelCard
            entry={sttEntry}
            hardware={hardware}
            recommendation={recommendation}
            downloads={downloads}
            inUseId={recommendation?.stt ?? ''}
            onDownload={onDownload}
            onCancel={onCancel}
          />
        )}

        {llmEntry && (
          <ModelCard
            entry={llmEntry}
            hardware={hardware}
            recommendation={recommendation}
            downloads={downloads}
            inUseId={recommendation?.llm ?? ''}
            onDownload={onDownload}
            onCancel={onCancel}
            footnote="Optional. Add it now or later for local summaries, decisions, action items, and questions."
          />
        )}

        <div style={{ padding: '18px 0 24px', borderTop: '1px solid var(--rule)' }}>
          <Toggle
            on={meetingDetectionOptIn}
            onToggle={() => setMeetingDetectionOptIn(v => !v)}
            label="Offer to record when a meeting starts — you can change this anytime in Settings."
          />
        </div>

        <button
          disabled={!hasInstalledStt}
          onClick={() => onStart(meetingDetectionOptIn)}
          className="btn-solid"
          style={{
            padding: '12px 22px',
            background: hasInstalledStt ? 'var(--accent-solid)' : 'var(--control-track)',
            color: hasInstalledStt ? 'var(--text-on-accent)' : 'var(--ink-muted)',
            cursor: hasInstalledStt ? 'pointer' : 'not-allowed',
            opacity: 1,
          }}
        >
          Start using Minute
        </button>
      </div>
    </div>
  )
}
