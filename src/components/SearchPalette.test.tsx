import { act, fireEvent, render, screen } from '@testing-library/react'
import type { NoteMeta, SearchHit } from '../ipc/types'
import { SearchPalette, type SearchPaletteProps } from './SearchPalette'

function noteFixture(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260722-120000',
    title: 'Client call — Acme',
    createdAt: '2026-07-22T12:00:00.000Z',
    durationSec: 1234.5,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 1,
    audioDeleted: false,
    ...overrides,
  }
}

function titleHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    noteId: '20260722-120000',
    title: 'Client call — Acme',
    snippet: 'Client call — Acme',
    segmentStart: null,
    kind: 'title',
    ...overrides,
  }
}

function transcriptHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    noteId: '20260722-120000',
    title: 'Client call — Acme',
    snippet: "Let's discuss the roadmap next quarter.",
    segmentStart: 72,
    kind: 'transcript',
    ...overrides,
  }
}

function baseProps(overrides: Partial<SearchPaletteProps> = {}) {
  return {
    notes: [noteFixture()],
    search: vi.fn().mockResolvedValue([]),
    onClose: vi.fn(),
    onOpenTitleHit: vi.fn(),
    onOpenTranscriptHit: vi.fn(),
    ...overrides,
  }
}

async function typeAndFlush(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
  await act(async () => {
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SearchPalette', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('autofocuses the search input on mount', () => {
    render(<SearchPalette {...baseProps()} />)
    expect(screen.getByRole('combobox', { name: 'Search notes' })).toHaveFocus()
  })

  it('shows a hint when the query is empty and does not call search', () => {
    const search = vi.fn().mockResolvedValue([])
    render(<SearchPalette {...baseProps({ search })} />)
    expect(screen.getByText('Search note titles and transcripts.')).toBeInTheDocument()
    expect(search).not.toHaveBeenCalled()
  })

  it('debounces the search call by 150ms as the user types', async () => {
    const search = vi.fn().mockResolvedValue([])
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    fireEvent.change(input, { target: { value: 'roadmap' } })
    expect(search).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(search).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(50)
      await Promise.resolve()
    })
    expect(search).toHaveBeenCalledWith('roadmap')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('restarts the debounce on every keystroke rather than firing per keystroke', async () => {
    const search = vi.fn().mockResolvedValue([])
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    fireEvent.change(input, { target: { value: 'r' } })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.change(input, { target: { value: 'ro' } })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(search).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(50)
      await Promise.resolve()
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('ro')
  })

  it('shows an honest "no matches" message when the search resolves empty', async () => {
    const search = vi.fn().mockResolvedValue([])
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    await typeAndFlush(input, 'nonexistent')

    expect(screen.getByText('No matches for “nonexistent”.')).toBeInTheDocument()
  })

  it('renders a title hit with its note title and date', async () => {
    const search = vi.fn().mockResolvedValue([titleHit()])
    render(<SearchPalette {...baseProps({ search, notes: [noteFixture()] })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    await typeAndFlush(input, 'acme')

    expect(screen.getByRole('option', { name: /client call — acme/i })).toBeInTheDocument()
    expect(screen.getByText('July 22, 2026')).toBeInTheDocument()
  })

  it('renders a transcript hit with a [mm:ss] timestamp chip and bolds the matched text', async () => {
    const search = vi.fn().mockResolvedValue([transcriptHit({ segmentStart: 72, snippet: "Let's discuss the ROADMAP next." })])
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    await typeAndFlush(input, 'roadmap')

    expect(screen.getByText('01:12')).toBeInTheDocument()
    const match = screen.getByText('ROADMAP')
    expect(match.tagName).toBe('STRONG')
  })

  it('announces the result count via the visually-hidden status region', async () => {
    const search = vi.fn().mockResolvedValue([titleHit(), transcriptHit()])
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    await typeAndFlush(input, 'acme')

    expect(screen.getByRole('status')).toHaveTextContent('2 results')
  })

  it('ArrowDown/ArrowUp move the roving selection and wrap at the ends', async () => {
    const hits = [titleHit(), transcriptHit({ segmentStart: 10 }), transcriptHit({ segmentStart: 20 })]
    const search = vi.fn().mockResolvedValue(hits)
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })
    await typeAndFlush(input, 'acme')

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    // wraps from the first entry back to the last on ArrowUp
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(options[2]).toHaveAttribute('aria-selected', 'true')

    // wraps from the last entry back to the first on ArrowDown
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter on a title hit calls onOpenTitleHit with its note id', async () => {
    const onOpenTitleHit = vi.fn()
    const search = vi.fn().mockResolvedValue([titleHit({ noteId: 'note-abc' })])
    render(<SearchPalette {...baseProps({ search, onOpenTitleHit })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })
    await typeAndFlush(input, 'acme')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenTitleHit).toHaveBeenCalledWith('note-abc')
  })

  it('Enter on a transcript hit calls onOpenTranscriptHit with its note id and segment start', async () => {
    const onOpenTranscriptHit = vi.fn()
    const search = vi.fn().mockResolvedValue([transcriptHit({ noteId: 'note-abc', segmentStart: 72 })])
    render(<SearchPalette {...baseProps({ search, onOpenTranscriptHit })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })
    await typeAndFlush(input, 'roadmap')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onOpenTranscriptHit).toHaveBeenCalledWith('note-abc', 72)
  })

  it('clicking a hit selects it the same as Enter would', async () => {
    const onOpenTranscriptHit = vi.fn()
    const search = vi.fn().mockResolvedValue([transcriptHit({ noteId: 'note-abc', segmentStart: 72 })])
    render(<SearchPalette {...baseProps({ search, onOpenTranscriptHit })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })
    await typeAndFlush(input, 'roadmap')

    fireEvent.mouseDown(screen.getByRole('option'))

    expect(onOpenTranscriptHit).toHaveBeenCalledWith('note-abc', 72)
  })

  it('Escape calls onClose', () => {
    const onClose = vi.fn()
    render(<SearchPalette {...baseProps({ onClose })} />)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search notes' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the overlay background calls onClose', () => {
    const onClose = vi.fn()
    render(<SearchPalette {...baseProps({ onClose })} />)
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking inside the panel does not call onClose', () => {
    const onClose = vi.fn()
    render(<SearchPalette {...baseProps({ onClose })} />)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps focus on the input when Tab is pressed (focus trap)', () => {
    render(<SearchPalette {...baseProps()} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveFocus()
  })

  it('restores focus to the previously focused element on unmount', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    expect(button).toHaveFocus()

    const { unmount } = render(<SearchPalette {...baseProps()} />)
    expect(screen.getByRole('combobox', { name: 'Search notes' })).toHaveFocus()

    unmount()
    expect(button).toHaveFocus()
    button.remove()
  })

  it('has combobox/listbox ARIA wiring', () => {
    render(<SearchPalette {...baseProps()} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', 'search-palette-listbox')
    expect(screen.getByRole('listbox', { name: 'Search results' })).toHaveAttribute('id', 'search-palette-listbox')
  })

  it('shows a "search failed" message when the search call rejects', async () => {
    const search = vi.fn().mockRejectedValue(new Error('backend unavailable'))
    render(<SearchPalette {...baseProps({ search })} />)
    const input = screen.getByRole('combobox', { name: 'Search notes' })

    await typeAndFlush(input, 'acme')

    expect(screen.getByText(/search failed: backend unavailable/i)).toBeInTheDocument()
  })
})
