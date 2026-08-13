import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    sources: ['mic'],
    ...overrides,
  }
}

function summaryFixture(overrides: Partial<SummaryDoc> = {}): SummaryDoc {
  return {
    summary: 'Discussed the Q3 roadmap.',
    topics: [],
    decisions: ['Ship the beta by Friday'],
    actionItems: [{ text: 'Write release notes', done: false }],
    ...overrides,
  }
}

function makeProps(overrides: Partial<NoteViewProps> = {}): NoteViewProps {
  const meta = 'meta' in overrides ? overrides.meta : noteFixture()
  return {
    meta: meta ?? null,
    // Mirrors the real wiring: App passes `s.notes.length > 0`, and a test
    // that renders a note self-evidently has one in the library.
    hasNotes: meta != null,
    selectedMeta: meta ?? null,
    selectedTranscript: [],
    selectedSummary: null,
    selectedMarkdown: meta ? `# ${meta.title}` : '',
    selectedAudioPath: null,
    selectedNoteStorage: { totalBytes: 12_000_000, audioBytes: 11_000_000, documentBytes: 1_000_000 },
    transcriptLoading: false,
    pendingSeek: null,
    onPendingSeekApplied: vi.fn(),
    noteTab: 'transcript',
    setNoteTab: vi.fn(),
    sttStatus: 'idle',
    sttStatusNoteId: null,
    summaryStatus: 'idle',
    summaryError: undefined,
    diarStatus: 'idle',
    diarError: undefined,
    canDetectSpeakers: false,
    onDetectSpeakers: vi.fn(),
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
    onCancelSummary: vi.fn(),
    onAsk: vi.fn(),
    onGoSettings: vi.fn(),
    onSetPinned: vi.fn(),
    onAddMarker: vi.fn().mockResolvedValue(undefined),
    onUpdateMarker: vi.fn().mockResolvedValue(undefined),
    onDeleteMarker: vi.fn().mockResolvedValue(undefined),
    onRenameSpeaker: vi.fn(),
    onDismissSpeakerSuggestion: vi.fn(),
    onMergeSpeakers: vi.fn().mockResolvedValue({
      from: 'Speaker 1',
      into: 'Speaker 2',
      segmentIndices: [0],
      checksum: 'merge-checksum',
    }),
    onUndoSpeakerMerge: vi.fn().mockResolvedValue(undefined),
    onDeleteAudio: vi.fn().mockResolvedValue(undefined),
    onStartRecording: vi.fn(),
    processingFailure: null,
    onRetryProcessing: vi.fn(),
    onDismissProcessing: vi.fn(),
    ...overrides,
  }
}

describe('NoteView', () => {
  it('shows an empty-library message when there is no selected note', () => {
    render(<NoteView {...makeProps({ meta: null, selectedMeta: null })} />)
    expect(screen.getByRole('heading', { level: 1, name: /no notes yet/i })).toBeInTheDocument()
  })

  // Issue #24: "All notes" deselects — with notes in the library, the
  // no-selection state is a pick-a-note prompt, not "no notes yet".
  it('shows the pick-a-note state when deselected but the library has notes', () => {
    render(<NoteView {...makeProps({ meta: null, selectedMeta: null, hasNotes: true })} />)
    expect(screen.getByRole('heading', { level: 1, name: 'All notes' })).toBeInTheDocument()
    expect(screen.getByText(/pick a note from the library list/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: /no notes yet/i })).not.toBeInTheDocument()
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

  it('does not mention system audio in the meta line for a mic-only note', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.getByText('48 min · 4 speakers · May 21, 2026 · stored locally')).toBeInTheDocument()
  })

  it('subtly notes system audio in the meta line when sources includes "system"', () => {
    const meta = noteFixture({ sources: ['mic', 'system'] })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
    expect(screen.getByText('48 min · 4 speakers · May 21, 2026 · stored locally · mic + system audio')).toBeInTheDocument()
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

  it('renders a post-recording overview with summary, decisions, actions, and markers', () => {
    const meta = noteFixture({
      status: 'ready',
      markers: [{ seconds: 94, label: 'Pricing decision' }],
    })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          selectedTranscript: [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'Hello.' }],
          selectedSummary: summaryFixture(),
        })}
      />,
    )
    expect(screen.getByText('Discussed the Q3 roadmap.')).toBeInTheDocument()
    expect(screen.getByText('Ship the beta by Friday')).toBeInTheDocument()
    expect(screen.getByText('Write release notes')).toBeInTheDocument()
    expect(screen.getByText('Pricing decision')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open transcript' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask this note' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
  })

  it('keeps overview content usable and offers retry when summarization fails', () => {
    const onRegenerateSummary = vi.fn()
    const meta = noteFixture()
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          summaryStatus: 'error',
          summaryError: 'Model stopped unexpectedly.',
          onRegenerateSummary,
        })}
      />,
    )
    expect(screen.getByText('Model stopped unexpectedly.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open transcript' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry summary' }))
    expect(onRegenerateSummary).toHaveBeenCalledWith(meta.id)
  })

  // Issue #14: the Detailed style's per-topic breakdown, in the overview.
  it('renders the topic breakdown in the overview when the summary has one', () => {
    const meta = noteFixture({ status: 'ready' })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          selectedSummary: summaryFixture({
            topics: [
              { title: 'Pricing', summary: 'Locked at $29.' },
              { title: 'Rollout', summary: 'EU first, then US.' },
            ],
          }),
        })}
      />,
    )
    expect(screen.getByText('Topics · 2')).toBeInTheDocument()
    expect(screen.getByText('Locked at $29.')).toBeInTheDocument()
    expect(screen.getByText('EU first, then US.')).toBeInTheDocument()
  })

  it('omits the overview topics section for a summary without topics', () => {
    const meta = noteFixture({ status: 'ready' })
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, noteTab: 'overview', selectedSummary: summaryFixture({ topics: [] }) })}
      />,
    )
    expect(screen.queryByText(/^Topics ·/)).not.toBeInTheDocument()
  })

  // Issue #11: a note waiting behind another generation must say so, and
  // must not offer a Generate button for work that is already scheduled.
  it('shows the overview as queued without offering to generate it again', () => {
    const meta = noteFixture()
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          llmInstalled: true,
          selectedSummary: null,
          summaryStatus: 'queued',
        })}
      />,
    )
    // Twice, correctly: the visible overview label, and AiNotesPanel's
    // persistent role="status" announcer picking up the same state.
    expect(screen.getAllByText('Summary queued')).toHaveLength(2)
    expect(
      screen.getAllByRole('status').some(node => node.textContent === 'Summary queued'),
    ).toBe(true)
    expect(screen.getByText(/Minute is busy with a recording or another summary/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
    // Still not an error — no retry affordance either.
    expect(screen.queryByRole('button', { name: 'Retry summary' })).not.toBeInTheDocument()
  })

  it('offers Generate summary for an idle un-summarized note', () => {
    const meta = noteFixture()
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, noteTab: 'overview', selectedSummary: null, summaryStatus: 'idle', llmInstalled: true })}
      />,
    )
    expect(screen.getByRole('button', { name: 'Generate summary' })).toBeInTheDocument()
  })

  // Issue #22: a diarization pass that recognized a saved voice writes a
  // suggestion onto the note — the transcript tools offer it as a
  // one-click rename or an explicit dismiss.
  it('offers voice-profile name suggestions with rename and dismiss', () => {
    const onRenameSpeaker = vi.fn()
    const onDismissSpeakerSuggestion = vi.fn()
    const meta = {
      ...noteFixture(),
      speakerSuggestions: { 'Speaker 2': { name: 'Sarah', similarity: 0.82 } },
    }
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' },
      { speaker: 'Speaker 2', start: 4, end: 7, text: 'Second voice.' },
    ]
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          selectedTranscript: segments,
          onRenameSpeaker,
          onDismissSpeakerSuggestion,
        })}
      />,
    )

    expect(screen.getByRole('group', { name: 'Speaker name suggestions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 2 to Sarah' }))
    expect(onRenameSpeaker).toHaveBeenCalledWith(meta.id, 'Speaker 2', 'Sarah')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion for Speaker 2' }))
    expect(onDismissSpeakerSuggestion).toHaveBeenCalledWith(meta.id, 'Speaker 2')
  })

  it('filters transcript turns, submits a speaker rename, and returns focus to the filter', async () => {
    const onRenameSpeaker = vi.fn()
    const meta = noteFixture()
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' },
      { speaker: 'Speaker 2', start: 4, end: 7, text: 'Second voice.' },
    ]
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, onRenameSpeaker })}
      />,
    )
    const speakerFilter = screen.getByRole('combobox', { name: 'Filter transcript by speaker' })
    fireEvent.change(speakerFilter, {
      target: { value: 'Speaker 2' },
    })
    expect(screen.queryByText('First voice.')).not.toBeInTheDocument()
    expect(screen.getByText('Second voice.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rename speaker' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker name' }), {
      target: { value: 'Sam' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onRenameSpeaker).toHaveBeenCalledWith(meta.id, 'Speaker 2', 'Sam')
    await waitFor(() => expect(speakerFilter).toHaveFocus())
  })

  it('hides "Detect speakers" until both diarization models are installed', () => {
    const meta = noteFixture()
    const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' }]
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments })} />)
    expect(screen.queryByRole('button', { name: 'Detect speakers' })).not.toBeInTheDocument()
  })

  it('detects speakers automatically or with a forced count via the toolbar form', () => {
    const onDetectSpeakers = vi.fn()
    const meta = noteFixture()
    const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' }]
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, canDetectSpeakers: true, onDetectSpeakers })}
      />,
    )

    // Auto run.
    fireEvent.click(screen.getByRole('button', { name: 'Detect speakers' }))
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
    expect(onDetectSpeakers).toHaveBeenCalledWith(meta.id, null)

    // Re-run with an exact count.
    fireEvent.click(screen.getByRole('button', { name: 'Detect speakers' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Number of speakers' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
    expect(onDetectSpeakers).toHaveBeenCalledWith(meta.id, 2)
  })

  it('shows a running state and surfaces speaker-detection errors', () => {
    const meta = noteFixture()
    const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' }]
    const { rerender } = render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, canDetectSpeakers: true, diarStatus: 'running' })}
      />,
    )
    expect(screen.getByRole('button', { name: 'Detecting speakers…' })).toBeDisabled()

    rerender(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          selectedTranscript: segments,
          canDetectSpeakers: true,
          diarStatus: 'error',
          diarError: 'no speech was detected in this note’s audio',
        })}
      />,
    )
    expect(screen.getByText(/Speaker detection failed/)).toBeInTheDocument()
  })

  it('returns focus to the speaker rename trigger when editing is cancelled with Escape', async () => {
    const meta = noteFixture()
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' },
      { speaker: 'Speaker 2', start: 4, end: 7, text: 'Second voice.' },
    ]
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments })} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter transcript by speaker' }), {
      target: { value: 'Speaker 2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Rename speaker' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Speaker name' }), { key: 'Escape' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename speaker' })).toHaveFocus())
  })

  it('merges a filtered speaker into another speaker and offers exact undo', async () => {
    const undo = {
      from: 'Speaker 1',
      into: 'Speaker 2',
      segmentIndices: [0],
      checksum: 'merge-checksum',
    }
    const onMergeSpeakers = vi.fn().mockResolvedValue(undo)
    const onUndoSpeakerMerge = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture()
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' },
      { speaker: 'Speaker 2', start: 4, end: 7, text: 'Second voice.' },
    ]
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          selectedTranscript: segments,
          onMergeSpeakers,
          onUndoSpeakerMerge,
        })}
      />,
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter transcript by speaker' }), {
      target: { value: 'Speaker 1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Merge speaker' }))
    expect(screen.getByRole('combobox', { name: 'Merge into speaker' })).toHaveValue('Speaker 2')
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(onMergeSpeakers).toHaveBeenCalledWith(meta.id, 'Speaker 1', 'Speaker 2'))
    expect(await screen.findByText(/merged into/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Filter transcript by speaker' })).toHaveFocus()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(onUndoSpeakerMerge).toHaveBeenCalledWith(meta.id, undo))
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Filter transcript by speaker' })).toHaveFocus()
  })

  it('pins the current note from its header', () => {
    const onSetPinned = vi.fn()
    const meta = noteFixture({ pinned: false })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, onSetPinned })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pin note' }))
    expect(onSetPinned).toHaveBeenCalledWith(meta.id, true)
  })

  it('adds a marker at the captured playback position', async () => {
    const OriginalAudio = window.Audio
    let audio!: HTMLAudioElement
    const audioSpy = vi.spyOn(window, 'Audio').mockImplementation(function (...args: ConstructorParameters<typeof Audio>) {
      audio = new OriginalAudio(...args)
      return audio
    } as unknown as typeof Audio)
    const onAddMarker = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture()

    try {
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: meta,
            selectedAudioPath: '/notes/abc/audio.wav',
            onAddMarker,
          })}
        />,
      )
      Object.defineProperty(audio, 'duration', { configurable: true, value: meta.durationSec })
      audio.currentTime = 94
      act(() => {
        audio.dispatchEvent(new Event('loadedmetadata'))
        audio.dispatchEvent(new Event('timeupdate'))
      })

      fireEvent.click(screen.getByRole('button', { name: 'Add marker at 01:34' }))
      const input = screen.getByRole('textbox', { name: 'New marker label at 01:34' })
      fireEvent.change(input, { target: { value: 'Pricing decision' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save marker' }))

      await waitFor(() => expect(onAddMarker).toHaveBeenCalledWith(meta.id, 94, 'Pricing decision'))
      expect(screen.queryByRole('textbox', { name: 'New marker label at 01:34' })).not.toBeInTheDocument()
    } finally {
      audioSpy.mockRestore()
    }
  })

  it('does not offer a fake marker action when completed audio is unavailable', () => {
    const meta = noteFixture()
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedAudioPath: null })} />)
    expect(screen.getByRole('button', { name: 'Add marker unavailable without audio' })).toBeDisabled()
  })

  it('edits a persisted marker inline and preserves its timestamp', async () => {
    const onUpdateMarker = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture({ markers: [{ seconds: 94, label: 'Old label' }] })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          onUpdateMarker,
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit marker Old label' }))
    const input = screen.getByRole('textbox', { name: 'Marker label at 01:34' })
    expect(input).toHaveValue('Old label')
    fireEvent.change(input, { target: { value: 'Pricing decision' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onUpdateMarker).toHaveBeenCalledWith(meta.id, 0, 'Pricing decision'))
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Marker label at 01:34' })).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit marker Old label' })).toHaveFocus()
    })
  })

  it('returns focus to the marker edit trigger when Escape closes the editor', async () => {
    const meta = noteFixture({ markers: [{ seconds: 94, label: 'Pricing decision' }] })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, noteTab: 'overview' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit marker Pricing decision' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Marker label at 01:34' }), { key: 'Escape' })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit marker Pricing decision' })).toHaveFocus()
    })
  })

  it('requires confirmation before deleting a persisted marker', async () => {
    const onDeleteMarker = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture({ markers: [{ seconds: 94, label: 'Pricing decision' }] })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          onDeleteMarker,
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete marker Pricing decision' }))
    expect(onDeleteMarker).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete marker Pricing decision' }))
    await waitFor(() => expect(onDeleteMarker).toHaveBeenCalledWith(meta.id, 0))
  })

  it('offers exact marker undo and explains per-note audio retention', async () => {
    const onDeleteMarker = vi.fn().mockResolvedValue(undefined)
    const onAddMarker = vi.fn().mockResolvedValue(undefined)
    const onDeleteAudio = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture({ markers: [{ seconds: 94, label: 'Pricing decision' }] })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          noteTab: 'overview',
          onDeleteMarker,
          onAddMarker,
          onDeleteAudio,
        })}
      />,
    )

    expect(screen.getByText('12 MB total · 11 MB audio · 1 MB notes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete marker Pricing decision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete marker Pricing decision' }))
    await waitFor(() => screen.getByText('Marker “Pricing decision” deleted.'))
    const undo = screen.getByRole('button', { name: 'Undo' })
    await waitFor(() => expect(undo).toHaveFocus())
    fireEvent.click(undo)
    await waitFor(() => expect(onAddMarker).toHaveBeenCalledWith(meta.id, 94, 'Pricing decision'))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Recording markers' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Remove original audio' }))
    expect(onDeleteAudio).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove audio' }))
    await waitFor(() => expect(onDeleteAudio).toHaveBeenCalledTimes(1))
  })

  it('offers refresh recovery without hiding the selected note', () => {
    const onRetryProcessing = vi.fn()
    render(
      <NoteView
        {...makeProps({
          processingFailure: { stage: 'preparing', message: 'Library read failed.' },
          onRetryProcessing,
        })}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
    expect(screen.getByText('Library read failed.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
    expect(onRetryProcessing).toHaveBeenCalledTimes(1)
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

    it('shows persistent recovery guidance instead of a success pill after capture failure', () => {
      const meta = noteFixture({
        id: 'note-1',
        status: 'transcribed',
        captureWarning: 'Audio finalization was incomplete: disk full',
      })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)

      expect(screen.getByText('Needs review')).toBeInTheDocument()
      expect(screen.getByText('Part of this recording may be missing.')).toBeInTheDocument()
      expect(screen.getByText(/disk full/)).toBeInTheDocument()
      expect(screen.queryByText('Transcribed')).not.toBeInTheDocument()
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
      // The speaker label itself, set as a small-caps rule above each
      // paragraph — the initials avatar it used to sit beside is gone (the
      // manuscript layout identifies a line by its speaker name and its
      // margin timestamp, not by a coloured disc).
      expect(screen.getAllByText('Speaker 1').length).toBeGreaterThan(0)
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
      expect(screen.getByRole('button', { name: 'Audio unavailable at 00:00' })).toBeDisabled()
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

  // A load failure (audio.wav deleted out from under the app while its path
  // was still cached, or the launch sweep racing the first get_note) can
  // only be reproduced here by firing a genuine `error` event on the real
  // `<audio>` element `useAudioPlayer` creates internally — NoteView doesn't
  // expose a `createAudio` injection seam (that's useAudioPlayer.test.ts's
  // job), so the element is captured by intercepting the global `Audio`
  // constructor for the duration of each test below.
  describe('audio load failure (selectedAudioPath present, but the element errors)', () => {
    let audioInstances: HTMLAudioElement[]

    beforeEach(() => {
      audioInstances = []
      const OriginalAudio = window.Audio
      vi.spyOn(window, 'Audio').mockImplementation(function (...args: ConstructorParameters<typeof Audio>) {
        const el = new OriginalAudio(...args)
        audioInstances.push(el)
        return el
      } as unknown as typeof Audio)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('shows the disabled "Audio unavailable" state (not "Audio removed") once the element errors', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedAudioPath: '/notes/abc/audio.wav' })} />)

      act(() => {
        audioInstances[0].dispatchEvent(new Event('error'))
      })

      expect(screen.getByText('Audio unavailable')).toBeInTheDocument()
      expect(screen.queryByText('Audio removed')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    })

    it('makes transcript timestamps inert once the element errors', () => {
      const meta = noteFixture()
      const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'Thanks for making time.' }]
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, selectedAudioPath: '/notes/abc/audio.wav' })}
        />,
      )

      expect(screen.getByRole('button', { name: 'Play from 00:00' })).not.toBeDisabled()
      act(() => {
        audioInstances[0].dispatchEvent(new Event('error'))
      })
      expect(screen.getByRole('button', { name: 'Audio unavailable at 00:00' })).toBeDisabled()
    })

    it('makes ask-history citations inert once the element errors', () => {
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({
            meta,
            selectedMeta: meta,
            selectedAudioPath: '/notes/abc/audio.wav',
            llmInstalled: true,
            askHistory: [{ id: 1, question: 'When was pricing locked?', answer: 'Pricing was locked at [01:34] during the call.' }],
          })}
        />,
      )

      expect(screen.getByRole('button', { name: 'Play from 01:34' })).not.toBeDisabled()
      act(() => {
        audioInstances[0].dispatchEvent(new Event('error'))
      })
      expect(screen.getByRole('button', { name: 'Play from 01:34' })).toBeDisabled()
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

    // Issue #30: the way out of a stuck or unwanted generation used to be
    // restarting the app.
    it('clicking Cancel while a summary is running calls onCancelSummary with the note id', () => {
      const onCancelSummary = vi.fn()
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: meta, selectedSummary: null, summaryStatus: 'running', onCancelSummary })}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onCancelSummary).toHaveBeenCalledWith(meta.id)
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

    it('pressing Enter commits the new title, exits edit mode, and restores focus', async () => {
      const onRename = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onRename })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith(meta.id, 'New title')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus())
    })

    it('pressing Escape reverts the draft and restores focus without renaming', async () => {
      const onRename = vi.fn()
      render(<NoteView {...makeProps({ onRename })} />)

      fireEvent.click(screen.getByTitle('Rename'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Changed but abandoned' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(onRename).not.toHaveBeenCalled()
      expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus())
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

      fireEvent.click(screen.getByRole('button', { name: `Delete note ${meta.title}` }))
      expect(onDelete).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: `Confirm delete note ${meta.title}` })).toBeInTheDocument()
      expect(screen.getByText(`Press again to confirm deletion of ${meta.title}`)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: `Confirm delete note ${meta.title}` }))
      expect(onDelete).toHaveBeenCalledWith(meta.id)
    })

    it('disarms the confirmation after the timeout elapses without a second click', () => {
      const onDelete = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onDelete })} />)

      fireEvent.click(screen.getByRole('button', { name: `Delete note ${meta.title}` }))
      expect(screen.getByRole('button', { name: `Confirm delete note ${meta.title}` })).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(4000)
      })

      expect(screen.getByRole('button', { name: `Delete note ${meta.title}` })).toBeInTheDocument()
      expect(onDelete).not.toHaveBeenCalled()
    })
  })

  describe('AI notes panel resize', () => {
    it('widens with ArrowLeft and persists the width', () => {
      window.localStorage.removeItem('minute.aiPanelWidth')
      render(<NoteView {...makeProps()} />)
      const separator = screen.getByRole('separator', { name: 'Resize AI notes panel' })
      expect(separator).toHaveAttribute('aria-valuenow', '316')
      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      expect(separator).toHaveAttribute('aria-valuenow', '332')
      expect(window.localStorage.getItem('minute.aiPanelWidth')).toBe('332')
    })

    it('clamps to its bounds and restores the default on Home', () => {
      window.localStorage.setItem('minute.aiPanelWidth', '9999')
      render(<NoteView {...makeProps()} />)
      const separator = screen.getByRole('separator', { name: 'Resize AI notes panel' })
      // A stored out-of-range width loads clamped to the max…
      expect(separator).toHaveAttribute('aria-valuenow', '520')
      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      expect(separator).toHaveAttribute('aria-valuenow', '520')
      // …and Home resets to the default.
      fireEvent.keyDown(separator, { key: 'Home' })
      expect(separator).toHaveAttribute('aria-valuenow', '316')
      expect(window.localStorage.getItem('minute.aiPanelWidth')).toBe('316')
      window.localStorage.removeItem('minute.aiPanelWidth')
    })
  })
})
