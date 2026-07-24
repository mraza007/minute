import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type { NoteMeta, StoredSegment } from '../ipc/types'
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
  const notes = overrides.notes ?? [noteFixture()]
  const sel = overrides.sel ?? 0
  const selectedMetaDefault = notes[sel] ?? notes[0] ?? null
  return {
    view: 'notes',
    isRecording: false,
    models: [],
    downloads: {},
    notes,
    hardware: null,
    recommendation: null,
    storage: null,
    lastError: null,
    sttModel: '',
    sttModelDisplayName: '',
    llmModel: null,
    sel,
    recElapsed: 0,
    paused: false,
    stopping: false,
    sttStatus: 'idle',
    sttError: null,
    sttStatusNoteId: null,
    liveSegments: [],
    selectedTranscript: [],
    selectedMeta: selectedMetaDefault,
    transcriptLoading: false,
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
    goRecording: vi.fn(),
    startRec: vi.fn(),
    stopRec: vi.fn(),
    togglePause: vi.fn(),
    selectNote: vi.fn(),
    setNoteTab: vi.fn(),
    setAskDraft: vi.fn(),
    ask: vi.fn(),
    setSttModel: vi.fn(),
    setLlmModel: vi.fn(),
    toggleDel: vi.fn(),
    toggleEnc: vi.fn(),
    downloadModel: vi.fn(),
    cancelDownload: vi.fn(),
    deleteModel: vi.fn(),
    completeOnboarding: vi.fn(),
    renameNote: vi.fn(),
    deleteNote: vi.fn(),
    revealNote: vi.fn(),
    reportError: vi.fn(),
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

  it('renders the transcript tab with the TranscriptList and the player bar', () => {
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

  describe('status pill', () => {
    it('shows a "Finalizing transcript…" pill when the selected note is mid-finalization', () => {
      const note = noteFixture({ id: 'note-1', status: 'recording' })
      render(<NoteView state={makeState({ notes: [note], sttStatusNoteId: 'note-1', sttStatus: 'finalizing' })} />)
      expect(screen.getByText('Finalizing transcript…')).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('shows a green "Transcribed" pill when the selected note is transcribed', () => {
      const note = noteFixture({ id: 'note-1', status: 'transcribed' })
      render(<NoteView state={makeState({ notes: [note], sttStatusNoteId: null, sttStatus: 'idle' })} />)
      expect(screen.getByText('Transcribed')).toBeInTheDocument()
      expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
    })

    it('prefers the finalizing pill over the transcribed pill for the same note', () => {
      // meta.status can already read 'transcribed' (the backend finalizes
      // the note before the stt worker's tail flush finishes emitting its
      // last stt-status event) — while sttStatus still says 'finalizing'
      // for this note, that takes priority.
      const note = noteFixture({ id: 'note-1', status: 'transcribed' })
      render(<NoteView state={makeState({ notes: [note], sttStatusNoteId: 'note-1', sttStatus: 'finalizing' })} />)
      expect(screen.getByText('Finalizing transcript…')).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('shows no pill when the note is still recording and sttStatus does not reference it', () => {
      const note = noteFixture({ id: 'note-1', status: 'recording' })
      render(<NoteView state={makeState({ notes: [note], sttStatusNoteId: 'some-other-note', sttStatus: 'finalizing' })} />)
      expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('does not show the finalizing pill for a different (non-selected) note', () => {
      const notes = [
        noteFixture({ id: 'note-1', title: 'First', status: 'recording' }),
        noteFixture({ id: 'note-2', title: 'Second', status: 'recording' }),
      ]
      render(<NoteView state={makeState({ notes, sel: 0, sttStatusNoteId: 'note-2', sttStatus: 'finalizing' })} />)
      expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
    })
  })

  describe('real transcript rendering', () => {
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3, text: 'Thanks for making time.' },
      { speaker: 'Speaker 1', start: 41, end: 44, text: 'Second segment.' },
    ]

    it('renders stored segments (adapted via storedSegmentsToDisplay) when selectedMeta matches the selected note', () => {
      const note = noteFixture()
      render(<NoteView state={makeState({ notes: [note], selectedMeta: note, selectedTranscript: segments })} />)
      expect(screen.getByText('Thanks for making time.')).toBeInTheDocument()
      expect(screen.getByText('Second segment.')).toBeInTheDocument()
      expect(screen.getByText('00:41')).toBeInTheDocument()
      expect(screen.getAllByText('S1').length).toBeGreaterThan(0)
    })

    it('does not render stale segments from a different note while the current note is still loading', () => {
      const note = noteFixture({ id: 'note-1' })
      const staleNote = noteFixture({ id: 'note-0' })
      render(
        <NoteView
          state={makeState({
            notes: [note],
            selectedMeta: staleNote,
            selectedTranscript: segments,
            transcriptLoading: true,
          })}
        />,
      )
      expect(screen.queryByText('Thanks for making time.')).not.toBeInTheDocument()
    })

    it('shows a loading indicator while the transcript for the selected note is still in flight', () => {
      const note = noteFixture({ id: 'note-1' })
      render(<NoteView state={makeState({ notes: [note], selectedMeta: null, transcriptLoading: true })} />)
      expect(screen.getByText(/loading transcript/i)).toBeInTheDocument()
    })
  })

  describe('markdown tab', () => {
    it('renders markdown generated from meta + the real transcript, with a real byte-size subtitle', () => {
      const note = noteFixture()
      const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 41, end: 44, text: 'Thanks for making time.' }]
      render(<NoteView state={makeState({ notes: [note], selectedMeta: note, selectedTranscript: segments, noteTab: 'md' })} />)

      expect(screen.getByText(/# Client call — Acme/)).toBeInTheDocument()
      expect(screen.getByText(/Thanks for making time\./)).toBeInTheDocument()
      expect(screen.getByText(/saved locally/)).toBeInTheDocument()
    })

    it('shows the "No speech detected." placeholder when the transcript is empty', () => {
      const note = noteFixture()
      render(<NoteView state={makeState({ notes: [note], selectedMeta: note, selectedTranscript: [], noteTab: 'md' })} />)
      expect(screen.getByText(/No speech detected\./)).toBeInTheDocument()
    })

    it('clicking Reveal in Finder calls state.revealNote with the note id', () => {
      const revealNote = vi.fn()
      const note = noteFixture()
      render(<NoteView state={makeState({ notes: [note], selectedMeta: note, noteTab: 'md', revealNote })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
      expect(revealNote).toHaveBeenCalledWith(note.id)
    })
  })

  describe('rename', () => {
    it('clicking the pencil button reveals an input pre-filled with the current title', () => {
      render(<NoteView state={makeState()} />)
      fireEvent.click(screen.getByTitle('Rename'))
      expect(screen.getByRole('textbox')).toHaveValue('Client call — Acme')
      expect(screen.queryByRole('heading', { name: 'Client call — Acme' })).not.toBeInTheDocument()
    })

    it('pressing Enter commits the new title via state.renameNote and exits edit mode', () => {
      const renameNote = vi.fn()
      const note = noteFixture()
      render(<NoteView state={makeState({ notes: [note], renameNote })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(renameNote).toHaveBeenCalledWith(note.id, 'New title')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('pressing Escape reverts the draft and does not call state.renameNote', () => {
      const renameNote = vi.fn()
      render(<NoteView state={makeState({ renameNote })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Changed but abandoned' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(renameNote).not.toHaveBeenCalled()
      expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
    })

    it('does not call state.renameNote when the title is unchanged', () => {
      const renameNote = vi.fn()
      render(<NoteView state={makeState({ renameNote })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

      expect(renameNote).not.toHaveBeenCalled()
    })

    it('committing on blur also calls state.renameNote', () => {
      const renameNote = vi.fn()
      const note = noteFixture()
      render(<NoteView state={makeState({ notes: [note], renameNote })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Blurred title' } })
      fireEvent.blur(input)

      expect(renameNote).toHaveBeenCalledWith(note.id, 'Blurred title')
    })
  })

  describe('delete', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('first click arms a confirmation without deleting; second click deletes', () => {
      const deleteNote = vi.fn()
      const note = noteFixture()
      render(<NoteView state={makeState({ notes: [note], deleteNote })} />)

      fireEvent.click(screen.getByTitle('Delete'))
      expect(deleteNote).not.toHaveBeenCalled()
      expect(screen.getByTitle('Confirm delete?')).toBeInTheDocument()

      fireEvent.click(screen.getByTitle('Confirm delete?'))
      expect(deleteNote).toHaveBeenCalledWith(note.id)
    })

    it('disarms the confirmation after the timeout elapses without a second click', () => {
      const deleteNote = vi.fn()
      render(<NoteView state={makeState({ deleteNote })} />)

      fireEvent.click(screen.getByTitle('Delete'))
      expect(screen.getByTitle('Confirm delete?')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(4000)
      })

      expect(screen.getByTitle('Delete')).toBeInTheDocument()
      expect(deleteNote).not.toHaveBeenCalled()
    })
  })
})
