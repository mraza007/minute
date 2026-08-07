import { fireEvent, render, screen } from '@testing-library/react'
import { demoNotes } from '../data/demo'
import { Sidebar } from './Sidebar'

const base = {
  notes: demoNotes,
  selectedNoteId: demoNotes[0].id,
  onSelect: vi.fn(),
  view: 'notes' as const,
  onGoNotes: vi.fn(),
  onGoSettings: vi.fn(),
  statsLine: '6 notes · 3.2 GB local · nothing synced',
  searchQuery: '',
  onSearchQueryChange: vi.fn(),
  matchedNoteIds: null,
  onOpenPalette: vi.fn(),
  onStartRecording: vi.fn(),
  onTogglePinned: vi.fn(),
  onOpenShortcuts: vi.fn(),
  onBulkExport: vi.fn().mockResolvedValue(undefined),
  onBulkDelete: vi.fn().mockResolvedValue(undefined),
  onRenameNote: vi.fn(),
  onRevealNote: vi.fn(),
}

describe('Sidebar', () => {
  it('renders all demo note titles', () => {
    render(<Sidebar {...base} />)
    for (const note of demoNotes) {
      expect(screen.getByText(note.title)).toBeInTheDocument()
    }
  })

  it('renders each group header exactly once', () => {
    render(<Sidebar {...base} />)
    expect(screen.getAllByText('Today')).toHaveLength(1)
    expect(screen.getAllByText('Yesterday')).toHaveLength(1)
    expect(screen.getAllByText('Last week')).toHaveLength(1)
  })

  it('calls onSelect with the clicked note id', () => {
    const onSelect = vi.fn()
    render(<Sidebar {...base} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /pricing workshop/i }))
    expect(onSelect).toHaveBeenCalledWith('demo-6')
  })

  // Selection is drawn as a margin marker (a 2px accent rule down the left
  // edge plus a wash that fades out to the right), not as a raised card.
  // That treatment lives in index.css keyed on `.side-row[aria-current]`, so
  // what this guards is the pair of hooks the stylesheet needs — jsdom won't
  // resolve the stylesheet itself.
  it('marks the selected row with the hooks index.css draws the margin rule from', () => {
    render(<Sidebar {...base} selectedNoteId="demo-3" />)
    const row = screen.getByRole('button', { name: /client call — acme/i })
    expect(row).toHaveClass('side-row')
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('marks the selected note row and current nav item with aria-current', () => {
    render(<Sidebar {...base} selectedNoteId="demo-3" view="notes" />)
    expect(screen.getByRole('button', { name: /client call — acme/i })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /all notes/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /settings/i })).not.toHaveAttribute('aria-current')
  })

  it('exposes the complete note title when the row label is visually truncated', () => {
    render(<Sidebar {...base} />)
    expect(screen.getByRole('button', { name: /board prep sync/i })).toHaveAttribute('title', 'Board prep sync')
  })

  it('calls onGoNotes when "All notes" is clicked', () => {
    const onGoNotes = vi.fn()
    render(<Sidebar {...base} onGoNotes={onGoNotes} />)
    fireEvent.click(screen.getByRole('button', { name: /all notes/i }))
    expect(onGoNotes).toHaveBeenCalledTimes(1)
  })

  it('calls onGoSettings when "Settings" is clicked', () => {
    const onGoSettings = vi.fn()
    render(<Sidebar {...base} onGoSettings={onGoSettings} />)
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(onGoSettings).toHaveBeenCalledTimes(1)
  })

  it('sorts notes explicitly and opens the shortcut reference', () => {
    const onOpenShortcuts = vi.fn()
    render(<Sidebar {...base} onOpenShortcuts={onOpenShortcuts} />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort notes' }), {
      target: { value: 'title' },
    })
    const noteRows = screen.getAllByRole('button').filter(button => button.classList.contains('side-row'))
    expect(noteRows.map(row => row.querySelector('.side-row-title')?.textContent)).toEqual(
      demoNotes.map(note => note.title).toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1)
  })

  it('bulk selects, exports, and recoverably deletes notes', async () => {
    const onBulkExport = vi.fn().mockResolvedValue(undefined)
    const onBulkDelete = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(
      <Sidebar {...base} onBulkExport={onBulkExport} onBulkDelete={onBulkDelete} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Select notes' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Board prep sync' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await vi.waitFor(() => expect(onBulkExport).toHaveBeenCalledWith(['demo-1']))

    rerender(<Sidebar {...base} onBulkExport={onBulkExport} onBulkDelete={onBulkDelete} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select notes' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Board prep sync' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onBulkDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete 1' }))
    await vi.waitFor(() => expect(onBulkDelete).toHaveBeenCalledWith(['demo-1']))
  })

  it('renders the given stats line', () => {
    render(<Sidebar {...base} statsLine="0 notes · 0 MB local · nothing synced" />)
    expect(screen.getByText('0 notes · 0 MB local · nothing synced')).toBeInTheDocument()
  })

  it('shows an empty-library message and no note rows when notes is empty', () => {
    const onStartRecording = vi.fn()
    render(<Sidebar {...base} notes={[]} onStartRecording={onStartRecording} />)
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /board prep sync/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /start your first recording/i }))
    expect(onStartRecording).toHaveBeenCalledTimes(1)
  })

  it('filters the library by pinned state', () => {
    const notes = demoNotes.map((note, index) => ({ ...note, pinned: index === 1 }))
    render(<Sidebar {...base} notes={notes} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'pinned' },
    })
    expect(screen.getByText('1:1 — Sarah')).toBeInTheDocument()
    expect(screen.queryByText('Board prep sync')).not.toBeInTheDocument()
  })

  it('combines source and recording-status filters', () => {
    const notes = demoNotes.map((note, index) => ({
      ...note,
      status: index === 0 ? 'recording' as const : 'ready' as const,
      sources: index === 0 ? ['mic', 'system'] : ['mic'],
    }))
    render(<Sidebar {...base} notes={notes} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'recording' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by source' }), {
      target: { value: 'system' },
    })
    expect(screen.getByText('Board prep sync')).toBeInTheDocument()
    expect(screen.queryByText('1:1 — Sarah')).not.toBeInTheDocument()
  })

  // Issue #18: the "Summarized" / "Needs summary" filters follow real
  // summary presence (`hasSummary`), not `status` — the two disagree on
  // notes from older builds and on notes whose summarization never
  // finished.
  it('filters "Summarized" by summary presence even when status disagrees', () => {
    const notes = demoNotes.map((note, index) => ({
      ...note,
      // Board prep sync (index 0): status says ready, but no summary
      // exists. 1:1 — Sarah (index 1): status says transcribed, but a
      // summary exists.
      status: index === 0 ? 'ready' as const : 'transcribed' as const,
      hasSummary: index !== 0,
    }))
    render(<Sidebar {...base} notes={notes} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'ready' },
    })
    expect(screen.getByText('1:1 — Sarah')).toBeInTheDocument()
    expect(screen.queryByText('Board prep sync')).not.toBeInTheDocument()
  })

  it('filters "Needs summary" by missing summary, excluding recording notes', () => {
    const notes = demoNotes.map((note, index) => ({
      ...note,
      status: index === 0 ? 'ready' as const : 'recording' as const,
      hasSummary: false,
    }))
    render(<Sidebar {...base} notes={notes} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), {
      target: { value: 'transcribed' },
    })
    expect(screen.getByText('Board prep sync')).toBeInTheDocument()
    expect(screen.queryByText('1:1 — Sarah')).not.toBeInTheDocument()
  })

  it('pins a note and collapses the library into its compact mode', () => {
    const onTogglePinned = vi.fn()
    render(<Sidebar {...base} onTogglePinned={onTogglePinned} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin note' })[0])
    expect(onTogglePinned).toHaveBeenCalledWith('demo-1', true)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse library sidebar' }))
    expect(screen.getByRole('navigation', { name: 'Notes' })).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByRole('button', { name: 'Expand library sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All notes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  describe('search input', () => {
    it('is a controlled input reflecting searchQuery', () => {
      render(<Sidebar {...base} searchQuery="acme" />)
      expect(screen.getByRole('textbox', { name: 'Search notes' })).toHaveValue('acme')
    })

    it('calls onSearchQueryChange as the user types', () => {
      const onSearchQueryChange = vi.fn()
      render(<Sidebar {...base} onSearchQueryChange={onSearchQueryChange} />)
      fireEvent.change(screen.getByRole('textbox', { name: 'Search notes' }), { target: { value: 'acme' } })
      expect(onSearchQueryChange).toHaveBeenCalledWith('acme')
    })

    it('clicking the ⌘K badge calls onOpenPalette', () => {
      const onOpenPalette = vi.fn()
      render(<Sidebar {...base} onOpenPalette={onOpenPalette} />)
      fireEvent.click(screen.getByRole('button', { name: /open search palette/i }))
      expect(onOpenPalette).toHaveBeenCalledTimes(1)
    })
  })

  describe('matchedNoteIds filtering', () => {
    it('shows only the matching notes, without group headers, when a filter is active', () => {
      const matchedNoteIds = new Set(['demo-1', 'demo-3'])
      render(<Sidebar {...base} searchQuery="a" matchedNoteIds={matchedNoteIds} />)

      expect(screen.getByText('Board prep sync')).toBeInTheDocument()
      expect(screen.getByText('Client call — Acme')).toBeInTheDocument()
      expect(screen.queryByText('1:1 — Sarah')).not.toBeInTheDocument()
      expect(screen.queryByText('Today')).not.toBeInTheDocument()
      expect(screen.queryByText('Yesterday')).not.toBeInTheDocument()
    })

    it('shows an honest "no matches" message when the filter matches nothing', () => {
      render(<Sidebar {...base} searchQuery="nonexistent" matchedNoteIds={new Set()} />)
      expect(screen.getByText('No matches for “nonexistent”')).toBeInTheDocument()
      expect(screen.queryByText('Board prep sync')).not.toBeInTheDocument()
    })

    it('restores the full grouped list once matchedNoteIds goes back to null', () => {
      const { rerender } = render(<Sidebar {...base} searchQuery="a" matchedNoteIds={new Set(['demo-1'])} />)
      expect(screen.queryByText('1:1 — Sarah')).not.toBeInTheDocument()

      rerender(<Sidebar {...base} searchQuery="" matchedNoteIds={null} />)
      expect(screen.getByText('1:1 — Sarah')).toBeInTheDocument()
      expect(screen.getByText('Today')).toBeInTheDocument()
    })
  })

  it('shows a glyph instead of repeated initials for default-titled notes when collapsed', () => {
    const notes = [
      { ...demoNotes[0], id: 'n1', title: 'New recording' },
      { ...demoNotes[1], id: 'n2', title: 'Pricing workshop' },
    ]
    render(<Sidebar {...base} notes={notes} selectedNoteId="n1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse library sidebar' }))
    expect(screen.queryByText('NR')).not.toBeInTheDocument()
    expect(screen.getByText('PW')).toBeInTheDocument()
  })

  it('expands a collapsed sidebar when Rename is chosen from the context menu', () => {
    render(<Sidebar {...base} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse library sidebar' }))
    // Collapsed rows are monograms — the inline rename input has no room, so
    // choosing Rename must expand the sidebar first.
    const collapsedRow = screen.getAllByRole('button', { name: new RegExp(demoNotes[0].title) })[0]
    fireEvent.contextMenu(collapsedRow)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByRole('textbox', { name: `Rename ${demoNotes[0].title}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse library sidebar' })).toBeInTheDocument()
  })
})
