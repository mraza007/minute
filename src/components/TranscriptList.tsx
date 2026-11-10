import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { UNKNOWN_SPEAKER_LABEL } from '../state/adapters'
import type { TranscriptSegment } from '../types'
import { EMPTY_SPEAKER_COLORS, speakerColorStyle, type SpeakerColors } from './speakerColors'

export interface TranscriptListProps {
  segments: TranscriptSegment[]
  /** Index into `segments` of the one whose `[start, end)` window contains playback's current position, or `-1` when nothing is playing (or the position falls in a gap). Passed as a plain index rather than raw `currentTime` — see the module docs below for why. */
  activeIndex: number
  /** Seeks playback to `seconds` and starts it — what clicking a segment's timestamp button does. */
  onSeek: (seconds: number) => void
  /** False when this note has no audio to seek into — timestamp buttons stay visually identical but go inert (aria-disabled, no click) rather than a no-op click that looks actionable but silently does nothing. */
  seekable: boolean
  /**
   * The note page's scroll container. The transcript scrolls with the rest
   * of the page, so the virtualized path windows its rows against this
   * element instead of a scroller of its own. Passed as the element (held in
   * state by the owner) rather than a ref: an ancestor's ref is still empty
   * when this component's layout effects run on mount.
   */
  scrollElement: HTMLElement | null
  /** Colour slot per speaker label, computed from the whole note so a filtered transcript keeps its colours. */
  speakerColors?: SpeakerColors
}

function handleTranscriptKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.turn-time:not(:disabled)'))
  if (buttons.length === 0) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0) return
  event.preventDefault()
  const direction = event.key === 'ArrowDown' ? 1 : -1
  buttons[Math.max(0, Math.min(buttons.length - 1, current + direction))]?.focus()
}

/** Above this many segments, `TranscriptList` switches from rendering every row directly to windowed rendering via `@tanstack/react-virtual` (see `VirtualizedRows` below) — a long meeting's transcript can run into the hundreds of segments, and mounting all of them (each with its own timestamp button) is the dominant cost of opening that note. Below the threshold every row mounts directly, with no virtualizer involved at all. */
const VIRTUALIZE_THRESHOLD = 150

/** Seeded estimate (px) for a not-yet-measured row's height, before the virtualizer's dynamic `measureElement` mode corrects it against the row's actual rendered height. Only ever a starting guess. */
const ESTIMATED_ROW_HEIGHT_PX = 82

/** Vertical rhythm between segments. Lives here rather than only as a flex `gap` because the virtualized branch positions rows absolutely and has to carry the same spacing as `paddingBottom`. */
const ROW_GAP_PX = 16

/** One transcript turn. The timestamp is the seek control. */
function Segment({
  segment,
  active,
  seekable,
  onSeek,
  speakerColors,
}: {
  segment: TranscriptSegment
  active: boolean
  seekable: boolean
  onSeek: (seconds: number) => void
  speakerColors: SpeakerColors
}) {
  return (
    <div className="turn" data-active={active ? 'true' : undefined}>
      <button
        onClick={() => seekable && onSeek(segment.start)}
        disabled={!seekable}
        aria-disabled={!seekable}
        aria-label={seekable ? `Play from ${segment.time}` : `Audio unavailable at ${segment.time}`}
        aria-current={active ? 'true' : undefined}
        className="turn-time"
        data-seekable={seekable ? 'true' : 'false'}
      >
        {segment.time}
      </button>
      <div className="turn-body">
        <div className="turn-who" style={speakerColorStyle(speakerColors, segment.speaker)}>
          {segment.speaker ?? UNKNOWN_SPEAKER_LABEL}
        </div>
        <p className="turn-said">{segment.text}</p>
      </div>
    </div>
  )
}

/** Plain, unvirtualized rendering — every segment mounted directly. Used at or below [`VIRTUALIZE_THRESHOLD`]. */
function PlainTranscriptList({ segments, activeIndex, onSeek, seekable, speakerColors = EMPTY_SPEAKER_COLORS }: TranscriptListProps) {
  return (
    <div className="transcript" onKeyDown={handleTranscriptKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: ROW_GAP_PX }}>
      {segments.map((segment, i) => (
        <Segment key={i} segment={segment} active={i === activeIndex} seekable={seekable} onSeek={onSeek} speakerColors={speakerColors} />
      ))}
    </div>
  )
}

/**
 * Windowed rendering for long transcripts (> [`VIRTUALIZE_THRESHOLD`]
 * segments): only the rows within (or just outside) the visible part of the
 * page are mounted. Rows are measured (`measureElement`) because real turns
 * run from one line to several.
 *
 * The list sits below the note header and summary inside the page's scroll
 * container, so the virtualizer needs the list's offset from the top of that
 * container (`scrollMargin`). The offset moves whenever the content above
 * changes height (a summary arrives, a marker form opens), which a
 * ResizeObserver on the scroll content tracks.
 */
function VirtualizedRows({ segments, activeIndex, onSeek, seekable, scrollElement, speakerColors = EMPTY_SPEAKER_COLORS }: TranscriptListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  useLayoutEffect(() => {
    const list = listRef.current
    const scroller = scrollElement
    if (!list || !scroller) return
    const measure = () => {
      setScrollMargin(Math.round(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop))
    }
    measure()
    const content = scroller.firstElementChild
    if (typeof ResizeObserver === 'undefined' || !content) return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [scrollElement])

  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 8,
    scrollMargin,
  })

  return (
    <div ref={listRef} className="transcript" data-virtualized="true" onKeyDown={handleTranscriptKeyDown}>
      <div style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
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
                transform: `translateY(${item.start - scrollMargin}px)`,
                paddingBottom: ROW_GAP_PX,
              }}
            >
              <Segment segment={segment} active={item.index === activeIndex} seekable={seekable} onSeek={onSeek} speakerColors={speakerColors} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Memoized so re-rendering NoteView (e.g. a status pill tick, or a
// `currentTime` tick from useAudioPlayer while playing) doesn't re-render every segment row when nothing this component
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
