import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, vi } from 'vitest'
import { demoTranscript } from '../data/demo'
import type { TranscriptSegment } from '../types'
import { TranscriptList, type TranscriptListProps } from './TranscriptList'

function makeProps(overrides: Partial<TranscriptListProps> = {}): TranscriptListProps {
  return {
    noteId: 'note-1',
    segments: demoTranscript,
    activeIndex: -1,
    onSeek: vi.fn(),
    seekable: true,
    ...overrides,
  }
}

/** Builds `count` synthetic segments — enough to exercise the virtualized (> 150 segments) path. */
function makeSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    initials: 'S1',
    speaker: 'Speaker 1',
    time: `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    text: `Segment number ${i} of the transcript.`,
    start: i,
    end: i + 1,
  }))
}

describe('TranscriptList', () => {
  it('renders every segment speaker and text', () => {
    render(<TranscriptList {...makeProps()} />)
    expect(screen.getAllByText('Tom Reyes — Acme').length).toBe(2)
    expect(screen.getAllByText('You', { selector: '.script-who' }).length).toBe(2)
    expect(screen.getByText('Priya Shah')).toBeInTheDocument()
  })

  it('renders nothing but an empty container for an empty segment list', () => {
    const { container } = render(<TranscriptList {...makeProps({ segments: [] })} />)
    expect(container.firstChild).toBeEmptyDOMElement()
  })

  it('renders segment timestamps', () => {
    render(<TranscriptList {...makeProps()} />)
    expect(screen.getByText('00:41')).toBeInTheDocument()
    expect(screen.getByText('02:26')).toBeInTheDocument()
  })

  it('renders timestamps as buttons with a "Play from mm:ss" aria-label', () => {
    render(<TranscriptList {...makeProps()} />)
    const button = screen.getByRole('button', { name: 'Play from 00:41' })
    expect(button).toBeInTheDocument()
  })

  it('clicking a timestamp calls onSeek with that segment’s start time', () => {
    const onSeek = vi.fn()
    render(<TranscriptList {...makeProps({ onSeek })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play from 01:34' }))
    expect(onSeek).toHaveBeenCalledWith(94)
  })

  // Playback position is marked with `data-active` on the row, which
  // index.css keys the (quiet) accent treatment off — the filled background
  // block it used to be would fight the ruled-margin layout.
  it('highlights the active segment (per activeIndex) and no other', () => {
    const { container } = render(<TranscriptList {...makeProps({ activeIndex: 1 })} />)
    const activeButton = screen.getByRole('button', { name: 'Play from 01:02' })
    expect(activeButton.closest('.script-line')).toHaveAttribute('data-active', 'true')
    expect(container.querySelectorAll('.script-line[data-active="true"]')).toHaveLength(1)
    expect(activeButton).toHaveAttribute('aria-current', 'true')
  })

  it('moves keyboard focus between timestamps with ArrowUp and ArrowDown', () => {
    render(<TranscriptList {...makeProps()} />)
    const first = screen.getByRole('button', { name: 'Play from 00:41' })
    const second = screen.getByRole('button', { name: 'Play from 01:02' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    expect(first).toHaveFocus()
  })

  it('restores each note’s transcript scroll position after switching notes', () => {
    const { container, rerender } = render(<TranscriptList {...makeProps({ noteId: 'note-a' })} />)
    const noteA = container.querySelector<HTMLElement>('.script')!
    noteA.scrollTop = 240
    fireEvent.scroll(noteA)

    rerender(<TranscriptList {...makeProps({ noteId: 'note-b' })} />)
    const noteB = container.querySelector<HTMLElement>('.script')!
    expect(noteB.scrollTop).toBe(0)
    noteB.scrollTop = 80
    fireEvent.scroll(noteB)

    rerender(<TranscriptList {...makeProps({ noteId: 'note-a' })} />)
    expect(container.querySelector<HTMLElement>('.script')!.scrollTop).toBe(240)
  })

  it('highlights nothing when activeIndex is -1', () => {
    const { container } = render(<TranscriptList {...makeProps({ activeIndex: -1 })} />)
    expect(container.querySelectorAll('.script-line[data-active="true"]')).toHaveLength(0)
  })

  it('disables timestamp buttons and does not call onSeek when not seekable', () => {
    const onSeek = vi.fn()
    render(<TranscriptList {...makeProps({ onSeek, seekable: false })} />)
    const button = screen.getByRole('button', { name: 'Audio unavailable at 00:41' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onSeek).not.toHaveBeenCalled()
  })

  describe('virtualization (long transcripts)', () => {
    // jsdom never computes real layout — `offsetHeight`/`offsetWidth` (what
    // @tanstack/react-virtual reads for both the scroll container's viewport
    // size and each row's measured height — see `getRect`/`measureElement`
    // in its source) are always 0 by default, which would collapse the
    // virtualizer's whole notion of "visible window" to nothing. Stubbed
    // here (not globally in `src/test/setup.ts` — nothing outside this describe
    // block needs it) via the scroll container's `data-testid` to tell it
    // apart from an individual row.
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() {
          return this.dataset.testid === 'transcript-virtual-scroll' ? 600 : 80
        },
      })
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() {
          return this.dataset.testid === 'transcript-virtual-scroll' ? 700 : 700
        },
      })
    })

    it('renders the plain (non-virtualized) path at exactly the threshold (150 segments)', () => {
      const { container } = render(<TranscriptList {...makeProps({ segments: makeSegments(150) })} />)
      expect(container.querySelector('[data-testid="transcript-virtual-scroll"]')).not.toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: /^Play from/ })).toHaveLength(150)
    })

    it('switches to the virtualized path just past the threshold (151 segments)', () => {
      const { container } = render(<TranscriptList {...makeProps({ segments: makeSegments(151) })} />)
      expect(container.querySelector('[data-testid="transcript-virtual-scroll"]')).toBeInTheDocument()
    })

    it('renders only a windowed subset of rows for a long transcript, not all of them', () => {
      render(<TranscriptList {...makeProps({ segments: makeSegments(300) })} />)
      const buttons = screen.getAllByRole('button', { name: /^Play from/ })
      // Stub geometry (600px viewport / 80px rows, overscan 8) yields ~7-8
      // rows visible plus overscan on either side — comfortably under 50,
      // and a far stronger windowing signal than merely "< 300".
      expect(buttons.length).toBeGreaterThan(0)
      expect(buttons.length).toBeLessThan(50)
    })

    it('a rendered row’s seek button still calls onSeek in the virtualized path', () => {
      const onSeek = vi.fn()
      render(<TranscriptList {...makeProps({ segments: makeSegments(300), onSeek })} />)
      // The very first segment is always within the initial visible window.
      fireEvent.click(screen.getByRole('button', { name: 'Play from 00:00' }))
      expect(onSeek).toHaveBeenCalledWith(0)
    })
  })
})
