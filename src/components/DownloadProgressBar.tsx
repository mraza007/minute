import { formatBytes } from '../state/adapters'

interface DownloadProgressBarProps {
  downloaded: number
  total: number
}

/** Shared progress-bar chrome used by the Onboarding and Settings model cards. */
export function DownloadProgressBar({ downloaded, total }: DownloadProgressBarProps) {
  const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-muted)', marginBottom: 4 }}>
        <span>{percent}%</span>
        <span>
          {formatBytes(downloaded)} / {formatBytes(total)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${formatBytes(downloaded)} of ${formatBytes(total)}`}
        style={{ height: 6, borderRadius: 999, background: 'var(--panel-warm)', overflow: 'hidden' }}
      >
        <div style={{ height: '100%', width: `${percent}%`, background: 'var(--accent)', borderRadius: 999, transition: 'width .2s' }} />
      </div>
    </div>
  )
}
