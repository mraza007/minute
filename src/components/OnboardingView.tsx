import { useState } from 'react'
import type { Hardware, ModelStatus, Recommendation } from '../ipc/types'
import { formatBytes, modelStatusToSttInfo, type DownloadProgressState } from '../state/adapters'
import { modelDetail } from '../state/modelCatalog'
import { assessModelSuitability, hardwareSpecs } from '../state/modelSuitability'
import { DownloadProgressBar } from './DownloadProgressBar'
import { ModelFit } from './ModelSuitability'
import { SettingSwitch } from './settings/controls'
import './onboarding.css'

export interface OnboardingViewProps {
  models: ModelStatus[]
  hardware: Hardware | null
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  onDownload: (id: string) => void
  onCancel: (id: string) => void
  /**
   * "Open Minute" receives the meeting-detection opt-in so
   * `completeOnboarding` can save it in the same call that ends onboarding.
   */
  onStart: (meetingDetectionOptIn: boolean) => void
}

type StepState = 'done' | 'current' | 'todo'

function Badge({ number, state }: { number: number; state: StepState }) {
  return (
    <span className="ob-badge" data-state={state} aria-hidden="true">
      {state === 'done' ? (
        <svg width="12" height="12" viewBox="0 0 24 24">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        number
      )}
    </span>
  )
}

interface ModelLineProps {
  entry: ModelStatus
  hardware: Hardware | null
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  inUseId: string
  onDownload: (id: string) => void
  onCancel: (id: string) => void
  footnote?: string
}

function ModelLine({ entry, hardware, recommendation, downloads, inUseId, onDownload, onCancel, footnote }: ModelLineProps) {
  const info = modelStatusToSttInfo(entry, inUseId, downloads)
  const progress = downloads[entry.id]
  const suitability = assessModelSuitability(entry, hardware, recommendation)

  return (
    <li className="ob-model">
      <div className="ob-model-row">
        <div className="ob-model-text">
          <span className="ob-model-name">{info.displayName}</span>
          <span className="ob-sub">{modelDetail(entry)}</span>
          <span className="ob-sub">
            {info.state !== 'downloading' && <>{info.sub} · </>}
            <ModelFit result={suitability} />
          </span>
        </div>
        {info.state === 'notInstalled' && (
          <button type="button" className="st-btn" aria-label={`Download (${formatBytes(entry.sizeBytes)})`} onClick={() => onDownload(entry.id)}>
            Download
          </button>
        )}
        {info.state === 'downloading' && (
          <button type="button" className="st-btn" onClick={() => onCancel(entry.id)}>
            Cancel
          </button>
        )}
      </div>
      {info.state === 'downloading' && progress && <DownloadProgressBar downloaded={progress.downloaded} total={progress.total} />}
      {footnote && <p className="ob-sub ob-footnote">{footnote}</p>}
    </li>
  )
}

export function OnboardingView({ models, hardware, recommendation, downloads, onDownload, onCancel, onStart }: OnboardingViewProps) {
  const sttEntry = recommendation ? models.find(m => m.id === recommendation.stt) : undefined
  const llmEntry = recommendation ? models.find(m => m.id === recommendation.llm) : undefined
  const hasInstalledStt = models.some(m => m.kind === 'stt' && m.state === 'installed')
  const downloading = Object.keys(downloads).length > 0

  // Off until the user turns it on. Turning a similar feature on by default
  // drew a backlash for another app, so this must never start checked. It
  // stays local until "Open Minute", which saves it with the rest.
  const [meetingDetectionOptIn, setMeetingDetectionOptIn] = useState(false)

  return (
    <div className="app-paper ob-page">
      <div className="ob-top" data-tauri-drag-region="" />
      <main className="ob-main">
        <div className="ob-sheet">
          <header className="ob-head">
            <h1 className="ob-title">Meeting notes that never leave your Mac</h1>
            <p className="ob-lede">
              Minute records, transcribes, and summarizes on this Mac, with no account and no cloud. Three steps and you
              are ready.
            </p>
          </header>

          <ol className="ob-steps" aria-label="Setup steps">
            <li className="ob-step">
              <Badge number={1} state="todo" />
              <div className="ob-body">
                <h2 className="ob-step-title">Microphone</h2>
                <p className="ob-sub">Minute asks when you start your first recording. It captures only while the recording indicator is on.</p>
              </div>
            </li>

            <li className="ob-step" data-tall="true">
              <Badge number={2} state={hasInstalledStt ? 'done' : 'current'} />
              <div className="ob-body">
                <h2 className="ob-step-title">Models for this Mac</h2>
                <p className="ob-sub">{hardwareSpecs(hardware)}</p>
                <ul className="ob-models">
                  {sttEntry && (
                    <ModelLine
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
                    <ModelLine
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
                </ul>
              </div>
            </li>

            <li className="ob-step">
              <Badge number={3} state="todo" />
              <div className="ob-body">
                <h2 className="ob-step-title">System audio · optional</h2>
                <p className="ob-sub">Records the other people on a call. macOS asks for Screen Recording only when you choose to include call audio.</p>
              </div>
            </li>
          </ol>

          <div className="ob-optin">
            <SettingSwitch
              title="Offer to record when a meeting starts"
              description="You can change this anytime in Settings."
              on={meetingDetectionOptIn}
              onToggle={() => setMeetingDetectionOptIn(v => !v)}
            />
          </div>

          <div className="ob-actions">
            <button type="button" className="ob-start" disabled={!hasInstalledStt} onClick={() => onStart(meetingDetectionOptIn)}>
              Open Minute
            </button>
            <span className="ob-sub">
              {!hasInstalledStt
                ? 'Download the transcription model to continue.'
                : downloading
                  ? 'The download continues in the background.'
                  : ''}
            </span>
          </div>
        </div>
      </main>
    </div>
  )
}
