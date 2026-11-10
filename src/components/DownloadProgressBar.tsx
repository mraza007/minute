import type { ReactNode } from 'react'
import { formatBytes } from '../state/adapters'
import './downloadProgress.css'

interface DownloadProgressBarProps {
  downloaded: number
  total: number
  /** Percentage only, for a narrow column. */
  compact?: boolean
  /** Sits on the percentage line, for example Cancel. */
  action?: ReactNode
}

/** The thin progress bar shared by Settings and onboarding model downloads. */
export function DownloadProgressBar({ downloaded, total, compact = false, action }: DownloadProgressBarProps) {
  const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0
  return (
    <div className="dl-progress">
      <div className="dl-progress-line">
        <span>{percent}%</span>
        {!compact && (
          <span>
            {formatBytes(downloaded)} / {formatBytes(total)}
          </span>
        )}
        {action}
      </div>
      <div
        className="dl-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${formatBytes(downloaded)} of ${formatBytes(total)}`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
