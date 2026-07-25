import { memo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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

/** Above this many segments, `TranscriptList` switches from rendering every row directly to windowed rendering via `@tanstack/react-virtual` (see `VirtualizedRows` below) — a long meeting's transcript can run into the hundreds of segments, and mounting all of them (each with its own timestamp button) is the dominant cost of opening that note. Below the threshold, rendering is unchanged from before virtualization existed: a plain `.map` with no virtualizer involved at all, so short notes (the overwhelming common case) and every test written against that shape keep working exactly as they did. */
const VIRTUALIZE_THRESHOLD = 150

/** Seeded estimate (px) for a not-yet-measured row's height, before the virtualizer's dynamic `measureElement` mode corrects it against the row's actual rendered height (segment text length varies a lot — a one-line aside vs. a multi-sentence remark — so this is only ever a starting guess, never load-bearing for correctness). Tuned to a typical single-paragraph segment at this component's font size/line-height. */
const ESTIMATED_ROW_HEIGHT_PX = 92

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

const scrollContainerStyle = {
  flex: 1,
  overflow: 'auto',
  padding: '24px 32px',
  maxWidth: 700,
} as const

/**
 * Plain, unvirtualized rendering — every segment mounted directly, exactly
 * as this component behaved before virtualization existed. Used below
 * [`VIRTUALIZE_THRESHOLD`]; kept byte-for-byte equivalent to the pre-Task-7
 * shape (same wrapper `display: flex, flexDirection: column, gap: 18`) so
 * every existing test (and every real note short enough to matter) sees no
 * difference at all.
 */
function PlainTranscriptList({ segments, activeIndex, onSeek, seekable }: TranscriptListProps) {
  return (
    <div style={{ ...scrollContainerStyle, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {segments.map((segment, i) => (
        <Segment key={i} segment={segment} active={i === activeIndex} seekable={seekable} onSeek={onSeek} />
      ))}
    </div>
  )
}

/**
 * Windowed rendering for long transcripts (> [`VIRTUALIZE_THRESHOLD`]
 * segments) via `@tanstack/react-virtual`: only the rows actually within
 * (or just outside) the visible scroll area are ever mounted, regardless of
 * how many hundreds of segments the note has. `measureElement` (dynamic
 * sizing mode) is used rather than a fixed row height — real segments vary
 * from a short one-liner to several sentences, and a fixed height would
 * either waste space or clip/overlap rows — [`ESTIMATED_ROW_HEIGHT_PX`] only
 * seeds the very first layout pass before any row has actually been
 * measured.
 *
 * The gap between rows (18px in the plain, flex-column layout above) can't
 * come from `flexDirection: column; gap` here — virtualized rows are
 * absolutely positioned, not flex children — so each row's wrapper carries
 * that spacing itself as `paddingBottom`.
 */
function VirtualizedRows({ segments, activeIndex, onSeek, seekable }: TranscriptListProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 8,
  })

  const items = virtualizer.getVirtualItems()

  return (
    <div ref={parentRef} data-testid="transcript-virtual-scroll" style={scrollContainerStyle}>
      <div style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}>
        {items.map(item => {
          const segment = segments[item.index]
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
                paddingBottom: 18,
              }}
            >
              <Segment segment={segment} active={item.index === activeIndex} seekable={seekable} onSeek={onSeek} />
            </div>
          )
        })}
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
//
// Delegates to one of two child components depending on `segments.length`
// vs. [`VIRTUALIZE_THRESHOLD`] — not a hook branching inside this component
// itself (which rules-of-hooks forbids), but a choice of *which* component
// mounts, exactly like any other conditional render.
export const TranscriptList = memo(function TranscriptList(props: TranscriptListProps) {
  if (props.segments.length > VIRTUALIZE_THRESHOLD) {
    return <VirtualizedRows {...props} />
  }
  return <PlainTranscriptList {...props} />
})
