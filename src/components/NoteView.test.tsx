import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import type { NoteMeta, StoredSegment, SummaryDoc } from '../ipc/types'
import { NoteView, type NoteViewProps } from './NoteView'

function noteFixture(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260521-140000',
    title: 'Client call — Acme',
    createdAt: '2026-05-21T14:00:00.000Z',
    durationSec: 48 * 60,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 4,
    audioDeleted: false,
    ...overrides,
  }
}

function summaryFixture(overrides: Partial<SummaryDoc> = {}): SummaryDoc {
  return {
    summary: 'Discussed the Q3 roadmap.',
    decisions: ['Ship the beta by Friday'],
    actionItems: [{ text: 'Write release notes', done: false }],
    ...overrides,
  }
}

function makeProps(overrides: Partial<NoteViewProps> = {}): NoteViewProps {
  const meta = 'meta' in overrides ? overrides.meta : noteFixture()
  return {
    meta: meta ?? null,
    selectedMeta: meta ?? null,
    selectedTranscript: [],
    selectedSummary: null,
    selectedMarkdown: meta ? `# ${meta.title}` : '',
    selectedAudioPath: null,
    transcriptLoading: false,
    pendingSeek: null,
    onPendingSeekApplied: vi.fn(),
    noteTab: 'transcript',
    setNoteTab: vi.fn(),
    sttStatus: 'idle',
    sttStatusNoteId: null,
    summaryStatus: 'idle',
    summaryError: undefined,
    llmInstalled: false,
    llmModelName: '',
    askHistory: [],
    askStatus: 'idle',
    llmBusy: false,
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onReveal: vi.fn(),
    onCopyError: vi.fn(),
    onToggleActionItem: vi.fn(),
    onRegenerateSummary: vi.fn(),
    onAsk: vi.fn(),
    onGoSettings: vi.fn(),
    ...overrides,
  }
}

describe('NoteView', () => {
  it('shows an empty-library message when there is no selected note', () => {
    render(<NoteView {...makeProps({ meta: null, selectedMeta: null })} />)
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument()
  })

  it('renders the selected note title from real note metadata', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('shows the meta line with duration, speaker count, formatted date, and storage note', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.getByText('48 min · 4 speakers · May 21, 2026 · stored locally')).toBeInTheDocument()
  })

  it('omits the speaker count when the note has a single speaker', () => {
    const meta = noteFixture({ speakers: 1 })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
    expect(screen.getByText('48 min · May 21, 2026 · stored locally')).toBeInTheDocument()
  })

  it('calls setNoteTab with md when Markdown is clicked, and transcript when Transcript is clicked', () => {
    const setNoteTab = vi.fn()
    render(<NoteView {...makeProps({ setNoteTab })} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Markdown' }))
    expect(setNoteTab).toHaveBeenCalledWith('md')
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }))
    expect(setNoteTab).toHaveBeenCalledWith('transcript')
  })

  it('marks the active tab with aria-selected', () => {
    render(<NoteView {...makeProps({ noteTab: 'transcript' })} />)
    expect(screen.getByRole('tab', { name: 'Transcript' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('aria-selected', 'false')
  })

  it('renders the transcript tab with the TranscriptList and the player bar', () => {
    render(<NoteView {...makeProps({ noteTab: 'transcript' })} />)
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('shows the markdown card and hides the transcript tab content when noteTab is md', () => {
    render(<NoteView {...makeProps({ noteTab: 'md' })} />)
    expect(screen.getByText('client-call-acme.md')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
  })

  it('hides the markdown card when noteTab is transcript', () => {
    render(<NoteView {...makeProps({ noteTab: 'transcript' })} />)
    expect(screen.queryByText('client-call-acme.md')).not.toBeInTheDocument()
  })

  it('shows the AI notes panel', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.getByText('AI notes')).toBeInTheDocument()
  })

  describe('status pill', () => {
    it('shows a "Finalizing transcript…" pill when the selected note is mid-finalization', () => {
      const meta = noteFixture({ id: 'note-1', status: 'recording' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, sttStatusNoteId: 'note-1', sttStatus: 'finalizing' })} />)
      expect(screen.getByText('Finalizing transcript…')).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('shows a green "Transcribed" pill when the selected note is transcribed', () => {
      const meta = noteFixture({ id: 'note-1', status: 'transcribed' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, sttStatusNoteId: null, sttStatus: 'idle' })} />)
      expect(screen.getByText('Transcribed')).toBeInTheDocument()
      expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
    })

    it('shows a green "Ready" pill when the selected note has status ready', () => {
      const meta = noteFixture({ id: 'note-1', status: 'ready' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
      expect(screen.getByText('Ready')).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('shows a "Summarizing…" pill while summaryStatus is running, even though meta.status is still transcribed', () => {
      const meta = noteFixture({ id: 'note-1', status: 'transcribed' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, summaryStatus: 'running' })} />)
      expect(screen.getByText('Summarizing…')).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('prefers the finalizing pill over the summarizing pill for the same note', () => {
      const meta = noteFixture({ id: 'note-1', status: 'transcribed' })
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: meta, sttStatusNoteId: 'note-1', sttStatus: 'finalizing', summaryStatus: 'running' })}
        />,
      )
      expect(screen.getByText('Finalizing transcript…')).toBeInTheDocument()
      expect(screen.queryByText('Summarizing…')).not.toBeInTheDocument()
    })

    it('prefers the finalizing pill over the transcribed pill for the same note', () => {
      const meta = noteFixture({ id: 'note-1', status: 'transcribed' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, sttStatusNoteId: 'note-1', sttStatus: 'finalizing' })} />)
      expect(screen.getByText('Finalizing transcript…')).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('shows no pill when the note is still recording and sttStatus does not reference it', () => {
      const meta = noteFixture({ id: 'note-1', status: 'recording' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, sttStatusNoteId: 'some-other-note', sttStatus: 'finalizing' })} />)
      expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
    })

    it('does not show the finalizing pill for a different (non-selected) note', () => {
      const meta = noteFixture({ id: 'note-1', title: 'First', status: 'recording' })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, sttStatusNoteId: 'note-2', sttStatus: 'finalizing' })} />)
      expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
    })
  })

  describe('real transcript rendering', () => {
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3, text: 'Thanks for making time.' },
      { speaker: 'Speaker 1', start: 41, end: 44, text: 'Second segment.' },
    ]

    it('renders stored segments (adapted via storedSegmentsToDisplay) when selectedMeta matches the selected note', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments })} />)
      expect(screen.getByText('Thanks for making time.')).toBeInTheDocument()
      expect(screen.getByText('Second segment.')).toBeInTheDocument()
      expect(screen.getByText('00:41')).toBeInTheDocument()
      expect(screen.getAllByText('S1').length).toBeGreaterThan(0)
    })

    it('does not render stale segments from a different note while the current note is still loading', () => {
      const meta = noteFixture({ id: 'note-1' })
      const staleMeta = noteFixture({ id: 'note-0' })
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: staleMeta,
            selectedTranscript: segments,
            transcriptLoading: true,
          })}
        />,
      )
      expect(screen.queryByText('Thanks for making time.')).not.toBeInTheDocument()
    })

    it('shows a loading indicator while the transcript for the selected note is still in flight', () => {
      const meta = noteFixture({ id: 'note-1' })
      render(<NoteView {...makeProps({ meta, selectedMeta: null, transcriptLoading: true })} />)
      expect(screen.getByText(/loading transcript/i)).toBeInTheDocument()
    })
  })

  describe('player bar audio wiring', () => {
    it('shows the disabled "Audio removed" state when the selected note has no audio', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedAudioPath: null })} />)
      expect(screen.getByText('Audio removed')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    })

    it('enables playback controls once selectedAudioPath is present for the selected note', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedAudioPath: '/notes/abc/audio.wav' })} />)
      expect(screen.queryByText('Audio removed')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Play' })).not.toBeDisabled()
    })

    it('does not leak a stale note’s audioPath into the player while the current note is still loading', () => {
      const meta = noteFixture({ id: 'note-1' })
      const staleMeta = noteFixture({ id: 'note-0' })
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: staleMeta,
            selectedAudioPath: '/notes/note-0/audio.wav',
            transcriptLoading: true,
          })}
        />,
      )
      expect(screen.getByText('Audio removed')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    })

    it('makes transcript timestamps inert (not seekable) when there is no audio', () => {
      const meta = noteFixture()
      const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'Thanks for making time.' }]
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, selectedAudioPath: null })} />)
      expect(screen.getByRole('button', { name: 'Play from 00:00' })).toBeDisabled()
    })

    it('makes transcript timestamps seekable once audio is present', () => {
      const meta = noteFixture()
      const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'Thanks for making time.' }]
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, selectedAudioPath: '/notes/abc/audio.wav' })}
        />,
      )
      expect(screen.getByRole('button', { name: 'Play from 00:00' })).not.toBeDisabled()
    })
  })

  describe('pendingSeek from the search palette', () => {
    it('applies a pendingSeek targeting the selected note once its audio is ready, then reports it applied', () => {
      const onPendingSeekApplied = vi.fn()
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: meta,
            selectedAudioPath: '/notes/abc/audio.wav',
            pendingSeek: { noteId: meta.id, seconds: 42 },
            onPendingSeekApplied,
          })}
        />,
      )
      expect(onPendingSeekApplied).toHaveBeenCalledTimes(1)
    })

    it('does not apply a pendingSeek targeting a different note', () => {
      const onPendingSeekApplied = vi.fn()
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: meta,
            selectedAudioPath: '/notes/abc/audio.wav',
            pendingSeek: { noteId: 'some-other-note', seconds: 42 },
            onPendingSeekApplied,
          })}
        />,
      )
      expect(onPendingSeekApplied).not.toHaveBeenCalled()
    })

    it('does not apply a pendingSeek while the selected note is still loading (stale selectedMeta)', () => {
      const onPendingSeekApplied = vi.fn()
      const meta = noteFixture({ id: 'note-1' })
      const staleMeta = noteFixture({ id: 'note-0' })
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: staleMeta,
            selectedAudioPath: '/notes/note-0/audio.wav',
            transcriptLoading: true,
            pendingSeek: { noteId: meta.id, seconds: 42 },
            onPendingSeekApplied,
          })}
        />,
      )
      expect(onPendingSeekApplied).not.toHaveBeenCalled()
    })

    it('does nothing when pendingSeek is null', () => {
      const onPendingSeekApplied = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, pendingSeek: null, onPendingSeekApplied })} />)
      expect(onPendingSeekApplied).not.toHaveBeenCalled()
    })
  })

  describe('markdown tab', () => {
    it('renders the backend-provided markdown with a real byte-size subtitle', () => {
      const meta = noteFixture()
      const markdown = '# Client call — Acme\n\n## Transcript\n\nThanks for making time.'
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedMarkdown: markdown, noteTab: 'md' })} />)

      expect(screen.getByText(/# Client call — Acme/)).toBeInTheDocument()
      expect(screen.getByText(/Thanks for making time\./)).toBeInTheDocument()
      expect(screen.getByText(/saved locally/)).toBeInTheDocument()
    })

    it('does not show markdown from a different (stale) note while still loading', () => {
      const meta = noteFixture({ id: 'note-1' })
      const staleMeta = noteFixture({ id: 'note-0' })
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: staleMeta, selectedMarkdown: '# stale note', noteTab: 'md', transcriptLoading: true })}
        />,
      )
      expect(screen.queryByText(/# stale note/)).not.toBeInTheDocument()
    })

    it('clicking Reveal in Finder calls onReveal with the note id', () => {
      const onReveal = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, noteTab: 'md', onReveal })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
      expect(onReveal).toHaveBeenCalledWith(meta.id)
    })
  })

  describe('AI notes panel wiring', () => {
    it('passes the real summary through to the panel', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: summaryFixture() })} />)
      expect(screen.getByText('Discussed the Q3 roadmap.')).toBeInTheDocument()
      expect(screen.getByText('Write release notes')).toBeInTheDocument()
    })

    it('does not show summary data from a stale selectedMeta', () => {
      const meta = noteFixture({ id: 'note-1' })
      const staleMeta = noteFixture({ id: 'note-0' })
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: staleMeta, selectedSummary: summaryFixture(), transcriptLoading: true })}
        />,
      )
      expect(screen.queryByText('Discussed the Q3 roadmap.')).not.toBeInTheDocument()
    })

    it('checking an action item calls onToggleActionItem with the note id, index, and new done value', () => {
      const onToggleActionItem = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: summaryFixture(), onToggleActionItem })} />)
      fireEvent.click(screen.getByRole('checkbox'))
      expect(onToggleActionItem).toHaveBeenCalledWith(meta.id, 0, true)
    })

    it('clicking Regenerate calls onRegenerateSummary with the note id', () => {
      const onRegenerateSummary = vi.fn()
      const meta = noteFixture()
      render(
        <NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: summaryFixture(), onRegenerateSummary })} />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
      expect(onRegenerateSummary).toHaveBeenCalledWith(meta.id)
    })

    it('clicking Export .md reveals the note (reuses onReveal, same as the Markdown tab)', () => {
      const onReveal = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: summaryFixture(), onReveal })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Export .md' }))
      expect(onReveal).toHaveBeenCalledWith(meta.id)
    })

    it('shows the "Generate summary" empty state when llmInstalled and no summary yet', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: null, llmInstalled: true })} />)
      expect(screen.getByRole('button', { name: 'Generate summary' })).toBeInTheDocument()
    })

    it('shows the no-LLM placeholder and calls onGoSettings when no summary yet and no LLM installed', () => {
      const onGoSettings = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: null, llmInstalled: false, onGoSettings })} />)
      // Two links share this name — the summary placeholder's and the ask
      // section's own no-LLM placeholder — both call the same `onGoSettings`.
      const links = screen.getAllByRole('button', { name: 'Download a summary model' })
      fireEvent.click(links[0])
      expect(onGoSettings).toHaveBeenCalledTimes(1)
    })

    it('passes askHistory/askStatus/llmBusy through to the panel', () => {
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: meta,
            llmInstalled: true,
            askHistory: [{ id: 1, question: 'What did they decide?', answer: 'They locked pricing.' }],
            askStatus: 'idle',
            llmBusy: false,
          })}
        />,
      )
      expect(screen.getByText('What did they decide?')).toBeInTheDocument()
      expect(screen.getByText('They locked pricing.')).toBeInTheDocument()
    })

    it('submitting a question in the ask input calls onAsk with the note id and question', () => {
      const onAsk = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, llmInstalled: true, onAsk })} />)

      const input = screen.getByPlaceholderText('Ask about this meeting…')
      fireEvent.change(input, { target: { value: 'What did they discuss?' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onAsk).toHaveBeenCalledWith(meta.id, 'What did they discuss?')
    })

    it('clicking a citation in an ask answer seeks/plays via the same audio player TranscriptList uses (no throw, with audio present)', () => {
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: meta,
            llmInstalled: true,
            selectedAudioPath: '/notes/abc/audio.wav',
            askHistory: [{ id: 1, question: 'When was pricing locked?', answer: 'Pricing was locked at [01:34].' }],
          })}
        />,
      )
      const citation = screen.getByRole('button', { name: 'Play from 01:34' })
      expect(() => fireEvent.click(citation)).not.toThrow()
    })

    it('passes summaryError through to the panel error card', () => {
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: meta, summaryStatus: 'error', summaryError: 'no summary model installed' })}
        />,
      )
      expect(screen.getByText('no summary model installed')).toBeInTheDocument()
    })
  })

  describe('rename', () => {
    it('clicking the pencil button reveals an input pre-filled with the current title', () => {
      render(<NoteView {...makeProps()} />)
      fireEvent.click(screen.getByTitle('Rename'))
      expect(screen.getByRole('textbox')).toHaveValue('Client call — Acme')
      expect(screen.queryByRole('heading', { name: 'Client call — Acme' })).not.toBeInTheDocument()
    })

    it('pressing Enter commits the new title via onRename and exits edit mode', () => {
      const onRename = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onRename })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith(meta.id, 'New title')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('pressing Escape reverts the draft and does not call onRename', () => {
      const onRename = vi.fn()
      render(<NoteView {...makeProps({ onRename })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Changed but abandoned' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(onRename).not.toHaveBeenCalled()
      expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
    })

    it('does not call onRename when the title is unchanged', () => {
      const onRename = vi.fn()
      render(<NoteView {...makeProps({ onRename })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

      expect(onRename).not.toHaveBeenCalled()
    })

    it('committing on blur also calls onRename', () => {
      const onRename = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onRename })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Blurred title' } })
      fireEvent.blur(input)

      expect(onRename).toHaveBeenCalledWith(meta.id, 'Blurred title')
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
      const onDelete = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onDelete })} />)

      fireEvent.click(screen.getByTitle('Delete'))
      expect(onDelete).not.toHaveBeenCalled()
      expect(screen.getByTitle('Confirm delete?')).toBeInTheDocument()

      fireEvent.click(screen.getByTitle('Confirm delete?'))
      expect(onDelete).toHaveBeenCalledWith(meta.id)
    })

    it('disarms the confirmation after the timeout elapses without a second click', () => {
      const onDelete = vi.fn()
      render(<NoteView {...makeProps({ onDelete })} />)

      fireEvent.click(screen.getByTitle('Delete'))
      expect(screen.getByTitle('Confirm delete?')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(4000)
      })

      expect(screen.getByTitle('Delete')).toBeInTheDocument()
      expect(onDelete).not.toHaveBeenCalled()
    })
  })
})
