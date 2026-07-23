import { fireEvent, render, screen } from '@testing-library/react'
import { demoNotes } from '../data/demo'
import { Sidebar } from './Sidebar'

const base = {
  notes: demoNotes,
  sel: 0,
  onSelect: vi.fn(),
  view: 'notes' as const,
  onGoNotes: vi.fn(),
  onGoSettings: vi.fn(),
  statsLine: '6 notes · 3.2 GB local · nothing synced',
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

  it('calls onSelect with the clicked note index', () => {
    const onSelect = vi.fn()
    render(<Sidebar {...base} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /pricing workshop/i }))
    expect(onSelect).toHaveBeenCalledWith(5)
  })

  it('gives the selected row a white background', () => {
    render(<Sidebar {...base} sel={2} />)
    const row = screen.getByRole('button', { name: /client call — acme/i })
    expect(row).toHaveStyle({ background: '#fff' })
  })

  it('marks the selected note row and current nav item with aria-current', () => {
    render(<Sidebar {...base} sel={2} view="notes" />)
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
})
