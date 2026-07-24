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
        {/* Full-width fill scaled down via `transform` (M12) instead of animating `width` — `transform-origin: left` keeps it growing from the start edge, same as the old width-based fill; the track's `overflow: hidden` above keeps the (always full-width) rounded corners looking right. */}
        <div
          style={{
            height: '100%',
            width: '100%',
            background: 'var(--accent)',
            borderRadius: 999,
            transform: `scaleX(${percent / 100})`,
            transformOrigin: 'left',
            transition: 'transform .2s',
          }}
        />
      </div>
    </div>
  )
}
