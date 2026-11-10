import { fireEvent, render, screen, within } from '@testing-library/react'
import { demoNotes } from '../data/demo'
import { Sidebar } from './Sidebar'

const base = {
  notes: demoNotes,
  selectedNoteId: demoNotes[0].id,
  onSelect: vi.fn(),
  view: 'notes' as const,
  onGoNotes: vi.fn(),
  onGoSettings: vi.fn(),
  statsLine: '6 notes · 3.2 GB',
  onOpenPalette: vi.fn(),
  onStartRecording: vi.fn(),
  isRecording: false,
  recTime: '00:00',
  onReturnToRecording: vi.fn(),
  summaryStatus: {},
  onTogglePinned: vi.fn(),
  onOpenShortcuts: vi.fn(),
  onBulkExport: vi.fn().mockResolvedValue(undefined),
  onBulkDelete: vi.fn().mockResolvedValue(undefined),
  onRenameNote: vi.fn(),
  onRevealNote: vi.fn(),
  collapsed: false,
  onSetCollapsed: vi.fn(),
}

function chooseFilter(group: string, option: string) {
  if (!screen.queryByRole('menu', { name: 'Sort and filter notes' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Sort and filter notes' }))
  }
  fireEvent.click(within(screen.getByRole('group', { name: group })).getByRole('menuitemradio', { name: option }))
}

function enterSelectMode() {
  fireEvent.click(screen.getByRole('button', { name: 'Sort and filter notes' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Select notes…' }))
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

  it('marks the selected note row with aria-current', () => {
    render(<Sidebar {...base} selectedNoteId="demo-3" view="notes" />)
    expect(screen.getByRole('button', { name: /client call — acme/i })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /settings/i })).not.toHaveAttribute('aria-current')
  })

  it('exposes the complete note title when the row label is visually truncated', () => {
    render(<Sidebar {...base} />)
    expect(screen.getByRole('button', { name: /board prep sync/i })).toHaveAttribute('title', 'Board prep sync')
  })

  it('"All notes" in the Show menu returns to the notes view from another screen', () => {
    const onGoNotes = vi.fn()
    const { rerender } = render(<Sidebar {...base} view="settings" onGoNotes={onGoNotes} />)
    chooseFilter('Show', 'All notes')
    expect(onGoNotes).toHaveBeenCalledTimes(1)

    onGoNotes.mockClear()
    rerender(<Sidebar {...base} view="notes" onGoNotes={onGoNotes} />)
    chooseFilter('Show', 'All notes')
    expect(onGoNotes).not.toHaveBeenCalled()
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

    chooseFilter('Sort', 'Title A–Z')
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

    enterSelectMode()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Board prep sync' }))
    expect(screen.getByRole('status')).toHaveTextContent('1 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Export 1' }))
    await vi.waitFor(() => expect(onBulkExport).toHaveBeenCalledWith(['demo-1']))

    rerender(<Sidebar {...base} onBulkExport={onBulkExport} onBulkDelete={onBulkDelete} />)
    enterSelectMode()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Board prep sync' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' }))
    expect(onBulkDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete 1' }))
    await vi.waitFor(() => expect(onBulkDelete).toHaveBeenCalledWith(['demo-1']))
  })

  it('renders the given stats line', () => {
    render(<Sidebar {...base} statsLine="0 notes · 0 MB" />)
    expect(screen.getByText('0 notes · 0 MB')).toBeInTheDocument()
  })

  it('shows an empty-library message and no note rows when notes is empty', () => {
    render(<Sidebar {...base} notes={[]} />)
    expect(screen.getByText('Your notes appear here.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /board prep sync/i })).not.toBeInTheDocument()
  })

  it('filters the library by pinned state', () => {
    const notes = demoNotes.map((note, index) => ({ ...note, pinned: index === 1 }))
    render(<Sidebar {...base} notes={notes} />)
    chooseFilter('Show', 'Pinned')
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
    chooseFilter('Show', 'Recording')
    chooseFilter('Source', 'System audio')
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
    chooseFilter('Show', 'Summarized')
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
    chooseFilter('Show', 'Needs summary')
    expect(screen.getByText('Board prep sync')).toBeInTheDocument()
    expect(screen.queryByText('1:1 — Sarah')).not.toBeInTheDocument()
  })

  it('pins a note from its row', () => {
    const onTogglePinned = vi.fn()
    render(<Sidebar {...base} onTogglePinned={onTogglePinned} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin note' })[0])
    expect(onTogglePinned).toHaveBeenCalledWith('demo-1', true)
  })

  it('asks to collapse from its own control', () => {
    const onSetCollapsed = vi.fn()
    render(<Sidebar {...base} onSetCollapsed={onSetCollapsed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse library sidebar' }))
    expect(onSetCollapsed).toHaveBeenCalledWith(true)
  })

  // The toolbar's "Notes" button is the way back, so nothing of the sidebar
  // stays on screen or in the accessibility tree.
  it('is hidden entirely while collapsed', () => {
    const { container } = render(<Sidebar {...base} collapsed />)
    expect(screen.queryByRole('navigation', { name: 'Notes' })).not.toBeInTheDocument()
    expect(container.querySelector('nav')).toHaveAttribute('hidden')
  })

  describe('search field', () => {
    it('opens the search palette', () => {
      const onOpenPalette = vi.fn()
      render(<Sidebar {...base} onOpenPalette={onOpenPalette} />)
      fireEvent.click(screen.getByRole('button', { name: 'Search notes' }))
      expect(onOpenPalette).toHaveBeenCalledTimes(1)
    })
  })

  describe('recording row', () => {
    it('starts a recording when idle', () => {
      const onStartRecording = vi.fn()
      render(<Sidebar {...base} onStartRecording={onStartRecording} />)
      fireEvent.click(screen.getByRole('button', { name: 'New recording' }))
      expect(onStartRecording).toHaveBeenCalledTimes(1)
    })

    it('shows the elapsed time and returns to the recording while one is running', () => {
      const onReturnToRecording = vi.fn()
      const onStartRecording = vi.fn()
      render(
        <Sidebar
          {...base}
          isRecording
          recTime="12:47"
          onReturnToRecording={onReturnToRecording}
          onStartRecording={onStartRecording}
        />,
      )
      const row = screen.getByRole('button', { name: 'Return to recording' })
      expect(row).toHaveTextContent('Recording')
      expect(row).toHaveTextContent('12:47')
      fireEvent.click(row)
      expect(onReturnToRecording).toHaveBeenCalledTimes(1)
      expect(onStartRecording).not.toHaveBeenCalled()
    })
  })

  describe('filter menu', () => {
    it('keeps every sort, status, source and date option reachable', () => {
      render(<Sidebar {...base} />)
      fireEvent.click(screen.getByRole('button', { name: 'Sort and filter notes' }))
      const labels = (group: string) =>
        within(screen.getByRole('group', { name: group }))
          .getAllByRole('menuitemradio')
          .map(item => item.textContent)
      expect(labels('Sort')).toEqual(['Newest first', 'Oldest first', 'Longest first', 'Title A–Z'])
      expect(labels('Show')).toEqual(['All notes', 'Pinned', 'Summarized', 'Needs summary', 'Recording'])
      expect(labels('Source')).toEqual(['Any source', 'Microphone', 'System audio'])
      expect(labels('Date')).toEqual(['Any date', 'Past 24 hours', 'Last 7 days'])
      expect(screen.getByRole('menuitem', { name: 'Select notes…' })).toBeInTheDocument()
    })

    it('marks the current choice and closes on Escape', () => {
      render(<Sidebar {...base} />)
      fireEvent.click(screen.getByRole('button', { name: 'Sort and filter notes' }))
      chooseFilter('Sort', 'Oldest first')
      expect(screen.getByRole('menuitemradio', { name: 'Oldest first' })).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'false')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('offers a way back from a filter that matches nothing', () => {
      render(<Sidebar {...base} />)
      chooseFilter('Show', 'Pinned')
      expect(screen.getByText('No notes match these filters.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
      expect(screen.getByText('Board prep sync')).toBeInTheDocument()
    })
  })

  describe('select mode', () => {
    it('shows the count with Done, and leaves select mode on Done', () => {
      render(<Sidebar {...base} />)
      enterSelectMode()
      expect(screen.getByRole('status')).toHaveTextContent('0 selected')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Board prep sync' }))
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select 1:1 — Sarah' }))
      expect(screen.getByRole('status')).toHaveTextContent('2 selected')
      expect(screen.getByRole('button', { name: 'Export 2' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'New recording' })).toBeInTheDocument()
    })
  })

  describe('row status', () => {
    it('shows "Summarizing…" instead of the metadata while a summary is queued or running', () => {
      render(<Sidebar {...base} summaryStatus={{ 'demo-1': 'running', 'demo-2': 'queued', 'demo-3': 'done' }} />)
      expect(screen.getAllByText('Summarizing…')).toHaveLength(2)
      expect(screen.getByRole('button', { name: /board prep sync/i })).not.toHaveTextContent(demoNotes[0].meta)
      expect(screen.getByRole('button', { name: /client call — acme/i })).toHaveTextContent(demoNotes[2].meta)
    })

    it('keeps a pinned note visibly marked', () => {
      const notes = demoNotes.map((note, index) => ({ ...note, pinned: index === 0 }))
      render(<Sidebar {...base} notes={notes} />)
      expect(screen.getByRole('button', { name: 'Unpin note' })).toHaveAttribute('data-active', 'true')
    })
  })
})
