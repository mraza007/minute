import { fireEvent, render, screen } from '@testing-library/react'
import type { NoteMeta } from '../ipc/types'
import type { AppState } from '../state/useAppState'
import { NoteView } from './NoteView'

function noteFixture(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260521-140000',
    title: 'Client call — Acme',
    createdAt: '2026-05-21T14:00:00.000Z',
    durationSec: 48 * 60,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 4,
    ...overrides,
  }
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    view: 'notes',
    models: [],
    downloads: {},
    notes: [noteFixture()],
    hardware: null,
    recommendation: null,
    storage: null,
    lastError: null,
    sttModel: '',
    sel: 0,
    recSeconds: 0,
    paused: false,
    asked: false,
    askDraft: '',
    tDel: true,
    tEnc: false,
    noteTab: 'transcript',
    sidebarNotes: [],
    statsLine: '',
    recTime: '00:00',
    askText: 'What did we promise Acme?',
    goNotes: vi.fn(),
    goSettings: vi.fn(),
    startRec: vi.fn(),
    stopRec: vi.fn(),
    togglePause: vi.fn(),
    selectNote: vi.fn(),
    setNoteTab: vi.fn(),
    setAskDraft: vi.fn(),
    ask: vi.fn(),
    setSttModel: vi.fn(),
    toggleDel: vi.fn(),
    toggleEnc: vi.fn(),
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
    deleteModel: vi.fn(),
    completeOnboarding: vi.fn(),
    ...overrides,
  }
}

describe('NoteView', () => {
  it('shows an empty-library message when there are no notes', () => {
    render(<NoteView state={makeState({ notes: [] })} />)
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument()
  })

  it('renders the selected note title from real note metadata', () => {
    render(<NoteView state={makeState()} />)
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('shows the meta line with duration, speaker count, formatted date, and storage note', () => {
    render(<NoteView state={makeState()} />)
    expect(screen.getByText('48 min · 4 speakers · May 21, 2026 · stored locally')).toBeInTheDocument()
  })

  it('omits the speaker count when the note has a single speaker', () => {
    render(<NoteView state={makeState({ notes: [noteFixture({ speakers: 1 })] })} />)
    expect(screen.getByText('48 min · May 21, 2026 · stored locally')).toBeInTheDocument()
  })

  it('selects the note at state.sel, not always the first note', () => {
    const notes = [noteFixture({ id: 'a', title: 'First' }), noteFixture({ id: 'b', title: 'Second' })]
    render(<NoteView state={makeState({ notes, sel: 1 })} />)
    expect(screen.getByRole('heading', { name: 'Second' })).toBeInTheDocument()
  })

  it('calls setNoteTab with md when Markdown is clicked, and transcript when Transcript is clicked', () => {
    const setNoteTab = vi.fn()
    render(<NoteView state={makeState({ setNoteTab })} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Markdown' }))
    expect(setNoteTab).toHaveBeenCalledWith('md')
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }))
    expect(setNoteTab).toHaveBeenCalledWith('transcript')
  })

  it('marks the active tab with aria-selected', () => {
    render(<NoteView state={makeState({ noteTab: 'transcript' })} />)
    expect(screen.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('aria-selected', 'false')
  })

  it('renders the transcript tab with an (empty for now) TranscriptList and the player bar', () => {
    render(<NoteView state={makeState({ noteTab: 'transcript' })} />)
    expect(screen.getByTitle('Play')).toBeInTheDocument()
  })

  it('shows the markdown card and hides the transcript tab content when noteTab is md', () => {
    render(<NoteView state={makeState({ noteTab: 'md' })} />)
    expect(screen.getByText('client-call-acme.md')).toBeInTheDocument()
    expect(screen.queryByTitle('Play')).not.toBeInTheDocument()
  })

  it('hides the markdown card when noteTab is transcript', () => {
    render(<NoteView state={makeState({ noteTab: 'transcript' })} />)
    expect(screen.queryByText('client-call-acme.md')).not.toBeInTheDocument()
  })

  it('shows the AI notes placeholder card instead of the demo AI panel', () => {
    render(<NoteView state={makeState()} />)
    expect(screen.getByText('AI notes')).toBeInTheDocument()
    expect(screen.getByText('Summaries arrive in a later update.')).toBeInTheDocument()
    expect(screen.queryByText('ASK YOUR NOTES')).not.toBeInTheDocument()
  })
})
