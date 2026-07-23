import { fireEvent, render, screen } from '@testing-library/react'
import type { AppState } from '../state/useAppState'
import { NoteView } from './NoteView'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    view: 'notes',
    sel: 2,
    recSeconds: 872,
    paused: false,
    asked: false,
    askDraft: '',
    sttModel: 'medium',
    tDel: true,
    tEnc: false,
    summarizing: false,
    noteTab: 'transcript',
    actions: [],
    recTime: '14:32',
    askText: 'What did we promise Acme?',
    goNotes: vi.fn(),
    goSettings: vi.fn(),
    startRec: vi.fn(),
    stopRec: vi.fn(),
    togglePause: vi.fn(),
    selectNote: vi.fn(),
    setNoteTab: vi.fn(),
    toggleAction: vi.fn(),
    setAskDraft: vi.fn(),
    ask: vi.fn(),
    setSttModel: vi.fn(),
    toggleDel: vi.fn(),
    toggleEnc: vi.fn(),
    ...overrides,
  }
}

describe('NoteView', () => {
  it('renders the selected note title and Summarized badge when not summarizing', () => {
    render(<NoteView state={makeState({ sel: 2, summarizing: false })} />)
    expect(screen.getByText('Client call — Acme')).toBeInTheDocument()
    expect(screen.getByText('Summarized')).toBeInTheDocument()
  })

  it('renders Summarizing… and no Summarized badge when summarizing', () => {
    render(<NoteView state={makeState({ sel: 2, summarizing: true })} />)
    expect(screen.getByText('Summarizing…')).toBeInTheDocument()
    expect(screen.queryByText('Summarized')).not.toBeInTheDocument()
  })

  it('shows the meta line with duration, speakers, date, and storage note', () => {
    render(<NoteView state={makeState({ sel: 2 })} />)
    expect(screen.getByText('48 min · 4 speakers · May 21, 2026 · stored locally')).toBeInTheDocument()
  })

  it('calls setNoteTab with md when Markdown is clicked', () => {
    const setNoteTab = vi.fn()
    render(<NoteView state={makeState({ setNoteTab })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect(setNoteTab).toHaveBeenCalledWith('md')
  })

  it('calls setNoteTab with transcript when Transcript is clicked', () => {
    const setNoteTab = vi.fn()
    render(<NoteView state={makeState({ setNoteTab })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Transcript' }))
    expect(setNoteTab).toHaveBeenCalledWith('transcript')
  })

  it('shows all demo transcript speakers, one HIGHLIGHT chip, and the player time', () => {
    render(<NoteView state={makeState({ noteTab: 'transcript' })} />)
    expect(screen.getAllByText('Tom Reyes — Acme').length).toBe(2)
    expect(screen.getAllByText('You', { selector: 'b' }).length).toBe(2)
    expect(screen.getByText('Priya Shah')).toBeInTheDocument()
    expect(screen.getAllByText('HIGHLIGHT')).toHaveLength(1)
    expect(screen.getByText('18:21 / 48:22')).toBeInTheDocument()
  })

  it('hides the transcript list and player when noteTab is md', () => {
    render(<NoteView state={makeState({ noteTab: 'md' })} />)
    expect(screen.queryByText('Tom Reyes — Acme')).not.toBeInTheDocument()
    expect(screen.queryByText('18:21 / 48:22')).not.toBeInTheDocument()
  })
})
