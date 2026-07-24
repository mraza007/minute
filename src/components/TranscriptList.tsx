import { memo } from 'react'
import type { TranscriptSegment } from '../types'

export interface TranscriptListProps {
  segments: TranscriptSegment[]
  /** Index into `segments` of the one whose `[start, end)` window contains playback's current position, or `-1` when nothing is playing (or the position falls in a gap). Passed as a plain index rather than raw `currentTime` — see the module docs below for why. */
  activeIndex: number
  /** Seeks playback to `seconds` and starts it — what clicking a segment's timestamp button does. */
  onSeek: (seconds: number) => void
  /** False when this note has no audio to seek into — timestamp buttons stay visually identical but go inert (aria-disabled, no click) rather than a no-op click that looks actionable but silently does nothing. */
  seekable: boolean
}

function Segment({
  segment,
  active,
  seekable,
  onSeek,
}: {
  segment: TranscriptSegment
  active: boolean
  seekable: boolean
  onSeek: (seconds: number) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 6,
        margin: -6,
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--surface-soft)' : 'transparent',
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: 'var(--panel-warm)',
          color: 'var(--ink-muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          flex: 'none',
        }}
      >
        {segment.initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 9, fontSize: 12, marginBottom: 3, alignItems: 'baseline' }}>
          <b>{segment.speaker}</b>
          <button
            onClick={() => seekable && onSeek(segment.start)}
            disabled={!seekable}
            aria-disabled={!seekable}
            aria-label={`Play from ${segment.time}`}
            style={{
              border: 'none',
              background: 'none',
              padding: 0,
              margin: 0,
              font: 'inherit',
              color: 'var(--ink-faint)',
              cursor: seekable ? 'pointer' : 'default',
            }}
          >
            {segment.time}
          </button>
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--ink-body)', textWrap: 'pretty' }}>{segment.text}</div>
      </div>
    </div>
  )
}

// Memoized so re-rendering NoteView's containing tabpanel (e.g. a status
// pill tick elsewhere, or a `currentTime` tick from useAudioPlayer while
// playing) doesn't re-render every segment row when nothing this component
// actually reads has changed. This is *why* NoteView passes `activeIndex` (a
// plain number, computed via a binary search in a `useMemo`) rather than raw
// `currentTime`: `currentTime` changes at ~4Hz while playing, but
// `activeIndex` only changes when playback actually crosses into a different
// segment — React.memo's shallow prop comparison means this component (and
// every one of its ~hundreds of `Segment` children) only re-renders on that
// coarser, much rarer transition.
export const TranscriptList = memo(function TranscriptList({ segments, activeIndex, onSeek, seekable }: TranscriptListProps) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 700 }}>
      {segments.map((segment, i) => (
        <Segment key={i} segment={segment} active={i === activeIndex} seekable={seekable} onSeek={onSeek} />
      ))}
    </div>
  )
})
