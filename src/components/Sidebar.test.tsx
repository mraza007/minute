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
})
