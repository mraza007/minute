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

  it('renders the given stats line', () => {
    render(<Sidebar {...base} statsLine="0 notes · 0 MB local · nothing synced" />)
    expect(screen.getByText('0 notes · 0 MB local · nothing synced')).toBeInTheDocument()
  })

  it('shows an empty-library message and no note rows when notes is empty', () => {
    render(<Sidebar {...base} notes={[]} />)
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /board prep sync/i })).not.toBeInTheDocument()
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
})
