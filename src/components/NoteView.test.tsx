import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    onExport: vi.fn(),
    obsidianEnabled: false,
    obsidianSaving: false,
    onSaveToObsidian: vi.fn(),
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
    onMarkSpeakerUnknown: vi.fn().mockResolvedValue({
      from: 'Speaker 1',
      into: null,
      segmentIndices: [0],
      summaryMentions: [],
      summaryFingerprint: null,
      checksum: 'unknown-checksum',
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

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More note actions' }))
}

function openAsk() {
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

const twoSpeakers: StoredSegment[] = [
  { speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' },
  { speaker: 'Speaker 2', start: 4, end: 7, text: 'Second voice.' },
]

describe('NoteView', () => {
  it('shows an empty-library message when there is no selected note', () => {
    render(<NoteView {...makeProps({ meta: null, selectedMeta: null })} />)
    expect(screen.getByRole('heading', { level: 1, name: /record your first meeting/i })).toBeInTheDocument()
  })

  // Issue #24: "All notes" deselects — with notes in the library, the
  // no-selection state is a pick-a-note prompt, not "no notes yet".
  it('shows the pick-a-note state when deselected but the library has notes', () => {
    render(<NoteView {...makeProps({ meta: null, selectedMeta: null, hasNotes: true })} />)
    expect(screen.getByRole('heading', { level: 1, name: 'All notes' })).toBeInTheDocument()
    expect(screen.getByText(/pick a note from the library list/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: /record your first meeting/i })).not.toBeInTheDocument()
  })

  it('renders the selected note title from real note metadata', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('shows the meta line with the date and time, duration, and speaker count', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.getByText(/^May 21, 2026, \d\d:\d\d · 48 min · 4 speakers$/)).toBeInTheDocument()
  })

  it('writes a note from today as "Today" with its time', () => {
    const meta = noteFixture({ createdAt: new Date().toISOString() })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
    expect(screen.getByText(/^Today, \d\d:\d\d · 48 min · 4 speakers$/)).toBeInTheDocument()
  })

  it('omits the speaker count when the note has a single speaker', () => {
    const meta = noteFixture({ speakers: 1 })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
    expect(screen.getByText(/^May 21, 2026, \d\d:\d\d · 48 min$/)).toBeInTheDocument()
  })

  it('does not mention system audio in the meta line for a mic-only note', () => {
    render(<NoteView {...makeProps()} />)
    expect(screen.queryByText(/system audio/i)).not.toBeInTheDocument()
  })

  it('notes system audio in the meta line when sources includes "system"', () => {
    const meta = noteFixture({ sources: ['mic', 'system'] })
    render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
    expect(screen.getByText(/· 48 min · 4 speakers · Mic \+ system audio$/)).toBeInTheDocument()
  })

  it('puts the summary, the transcript, and the player on one page with no tabs', () => {
    render(<NoteView {...makeProps({ selectedSummary: summaryFixture(), selectedTranscript: twoSpeakers })} />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Decisions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Action items' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transcript' })).toBeInTheDocument()
    expect(screen.getByText('First voice.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('renders a finished note with summary, decisions, actions, markers, and transcript', () => {
    const meta = noteFixture({
      status: 'ready',
      markers: [{ seconds: 94, label: 'Pricing decision' }],
    })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          selectedTranscript: [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'Hello.' }],
          selectedSummary: summaryFixture(),
        })}
      />,
    )
    expect(screen.getByText('Discussed the Q3 roadmap.')).toBeInTheDocument()
    expect(screen.getByText('Ship the beta by Friday')).toBeInTheDocument()
    expect(screen.getByText('Write release notes')).toBeInTheDocument()
    expect(screen.getByText('Pricing decision')).toBeInTheDocument()
    expect(screen.getByText('Hello.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
  })

  it('keeps the note usable and offers retry when summarization fails', () => {
    const onRegenerateSummary = vi.fn()
    const meta = noteFixture()
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          summaryStatus: 'error',
          summaryError: 'Model stopped unexpectedly.',
          onRegenerateSummary,
        })}
      />,
    )
    expect(screen.getByText(/Model stopped unexpectedly\./)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Transcript' })).toBeInTheDocument()
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
          selectedSummary: summaryFixture({
            topics: [
              { title: 'Pricing', summary: 'Locked at $29.' },
              { title: 'Rollout', summary: 'EU first, then US.' },
            ],
          }),
        })}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
    expect(screen.getByText('Locked at $29.')).toBeInTheDocument()
    expect(screen.getByText('EU first, then US.')).toBeInTheDocument()
  })

  it('omits the overview topics section for a summary without topics', () => {
    const meta = noteFixture({ status: 'ready' })
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedSummary: summaryFixture({ topics: [] }) })}
      />,
    )
    expect(screen.queryByRole('heading', { name: 'Topics' })).not.toBeInTheDocument()
  })

  // Issue #11: a note waiting behind another generation must say so, and
  // must not offer a Generate button for work that is already scheduled.
  it('shows a queued summary without offering to generate it again', () => {
    const meta = noteFixture()
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          llmInstalled: true,
          selectedSummary: null,
          summaryStatus: 'queued',
        })}
      />,
    )
    expect(screen.getByText('Queued. Starts when the engine is free.')).toBeInTheDocument()
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
        {...makeProps({ meta, selectedMeta: meta, selectedSummary: null, summaryStatus: 'idle', llmInstalled: true })}
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

  // Issue #32: a confident match the pass applied on its own shows as a
  // notice with an Undo — the undo is a plain rename back to the raw label.
  it('shows auto-applied speaker names with a working Undo', () => {
    const onRenameSpeaker = vi.fn()
    const meta = {
      ...noteFixture(),
      speakerAutoApplied: { 'Speaker 1': { name: 'Sarah', similarity: 0.91 } },
    }
    const segments: StoredSegment[] = [{ speaker: 'Sarah', start: 0, end: 3, text: 'First voice.' }]
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments, onRenameSpeaker })}
      />,
    )

    expect(screen.getByRole('group', { name: 'Automatically applied speaker names' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo renaming Speaker 1 to Sarah' }))
    expect(onRenameSpeaker).toHaveBeenCalledWith(meta.id, 'Sarah', 'Speaker 1')
  })

  it('filters transcript turns by speaker and can show them all again', () => {
    const meta = noteFixture()
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers })} />)
    const speakerFilter = screen.getByRole('combobox', { name: 'Filter transcript by speaker' })
    fireEvent.change(speakerFilter, { target: { value: 'Speaker 2' } })
    expect(screen.queryByText('First voice.')).not.toBeInTheDocument()
    expect(screen.getByText('Second voice.')).toBeInTheDocument()
    fireEvent.change(speakerFilter, { target: { value: 'all' } })
    expect(screen.getByText('First voice.')).toBeInTheDocument()
  })

  it('offers an Unknown speaker filter only when unknown turns exist, and filters to them', () => {
    const meta = noteFixture()
    const { rerender } = render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers })} />)
    const speakerFilter = screen.getByRole('combobox', { name: 'Filter transcript by speaker' })
    expect(within(speakerFilter).queryByRole('option', { name: 'Unknown speaker' })).not.toBeInTheDocument()

    const withUnknown: StoredSegment[] = [...twoSpeakers, { speaker: null, start: 8, end: 9, text: 'Mystery voice.' }]
    rerender(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: withUnknown })} />)
    expect(screen.queryByRole('button', { name: 'Rename Unknown speaker' })).not.toBeInTheDocument()
    fireEvent.change(speakerFilter, { target: { value: within(speakerFilter).getByRole('option', { name: 'Unknown speaker' }).getAttribute('value') } })
    expect(screen.getByText('Mystery voice.')).toBeInTheDocument()
    expect(screen.queryByText('First voice.')).not.toBeInTheDocument()
    expect(screen.queryByText('Second voice.')).not.toBeInTheDocument()
  })

  it('marks a speaker\'s turns as unknown from the popover and undoes it', async () => {
    const undo = {
      from: 'Speaker 2',
      into: null,
      segmentIndices: [1],
      summaryMentions: [],
      summaryFingerprint: null,
      checksum: 'unknown-checksum',
    }
    const onMarkSpeakerUnknown = vi.fn().mockResolvedValue(undo)
    const onUndoSpeakerMerge = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture()
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers, onMarkSpeakerUnknown, onUndoSpeakerMerge })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 2' }))
    const popover = within(screen.getByRole('dialog', { name: 'Rename Speaker 2' }))
    expect(popover.getByText('Speaker 2 · 1 turn')).toBeInTheDocument()
    fireEvent.click(popover.getByRole('button', { name: 'Mark these turns as unknown' }))

    await waitFor(() => expect(onMarkSpeakerUnknown).toHaveBeenCalledWith(meta.id, 'Speaker 2'))
    expect(await screen.findByText(/marked as unknown/)).toHaveTextContent('Turns from Speaker 2 marked as unknown.')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename Speaker 2' })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(onUndoSpeakerMerge).toHaveBeenCalledWith(meta.id, undo))
  })

  it('keeps the popover open for a retry when marking turns unknown fails', async () => {
    const onMarkSpeakerUnknown = vi.fn().mockRejectedValue(new Error('disk full'))
    const meta = noteFixture()
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: [twoSpeakers[0]], onMarkSpeakerUnknown })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 1' }))
    const popover = within(screen.getByRole('dialog', { name: 'Rename Speaker 1' }))
    expect(popover.queryByRole('button', { name: 'Merge with another speaker…' })).not.toBeInTheDocument()
    fireEvent.click(popover.getByRole('button', { name: 'Mark these turns as unknown' }))

    await waitFor(() => expect(popover.getByRole('button', { name: 'Mark these turns as unknown' })).toBeEnabled())
    expect(screen.getByRole('dialog', { name: 'Rename Speaker 1' })).toBeInTheDocument()
  })

  it('shows one coloured chip per speaker, blue for You', () => {
    const meta = noteFixture()
    const segments: StoredSegment[] = [
      { speaker: 'Marcus Chen', start: 0, end: 3, text: 'First voice.' },
      { speaker: 'You', start: 4, end: 7, text: 'Second voice.' },
    ]
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments })} />)
    expect(screen.getByRole('button', { name: 'Rename You' }).style.getPropertyValue('--speaker-color')).toBe('var(--speaker-1)')
    expect(screen.getByRole('button', { name: 'Rename Marcus Chen' }).style.getPropertyValue('--speaker-tint')).toBe('var(--speaker-2-tint)')
    // The transcript label carries the same colour as the chip.
    expect(screen.getByText('Marcus Chen', { selector: '.turn-who' }).style.getPropertyValue('--speaker-color')).toBe('var(--speaker-2)')
  })

  it('renames a speaker from the popover under its chip and returns focus to the chip row', async () => {
    const onRenameSpeaker = vi.fn()
    const meta = noteFixture()
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers, onRenameSpeaker })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 2' }))
    const popover = screen.getByRole('dialog', { name: 'Rename Speaker 2' })
    expect(popover).toHaveTextContent('Speaker 2 · 1 turn')
    const input = screen.getByRole('textbox', { name: 'Speaker name' })
    expect(input).toHaveValue('Speaker 2')
    fireEvent.change(input, { target: { value: 'Sam' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    expect(onRenameSpeaker).toHaveBeenCalledWith(meta.id, 'Speaker 2', 'Sam')
    expect(screen.queryByRole('dialog', { name: 'Rename Speaker 2' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Speaker 2' })).toHaveFocus())
  })

  it('opens the popover on the first unnamed speaker from "Rename speakers"', () => {
    const meta = noteFixture()
    const segments: StoredSegment[] = [
      { speaker: 'You', start: 0, end: 3, text: 'First voice.' },
      { speaker: 'Speaker 2', start: 4, end: 7, text: 'Second voice.' },
    ]
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename speakers' }))
    expect(screen.getByRole('dialog', { name: 'Rename Speaker 2' })).toBeInTheDocument()
  })

  it('does not rename when the name is unchanged', () => {
    const onRenameSpeaker = vi.fn()
    const meta = noteFixture()
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers, onRenameSpeaker })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRenameSpeaker).not.toHaveBeenCalled()
  })

  it('offers the voice-profile match inside the popover', () => {
    const onRenameSpeaker = vi.fn()
    const onDismissSpeakerSuggestion = vi.fn()
    const meta = { ...noteFixture(), speakerSuggestions: { 'Speaker 2': { name: 'Sarah', similarity: 0.82 } } }
    render(
      <NoteView
        {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers, onRenameSpeaker, onDismissSpeakerSuggestion })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 2' }))
    const popover = within(screen.getByRole('dialog', { name: 'Rename Speaker 2' }))
    expect(popover.getByText('Sounds like Sarah')).toBeInTheDocument()
    fireEvent.click(popover.getByRole('button', { name: 'Dismiss suggestion' }))
    expect(onDismissSpeakerSuggestion).toHaveBeenCalledWith(meta.id, 'Speaker 2')
    fireEvent.click(popover.getByRole('button', { name: 'Use this name' }))
    expect(onRenameSpeaker).toHaveBeenCalledWith(meta.id, 'Speaker 2', 'Sarah')
    expect(screen.queryByRole('dialog', { name: 'Rename Speaker 2' })).not.toBeInTheDocument()
  })

  it('hides "Detect speakers" until both diarization models are installed', () => {
    const meta = noteFixture()
    const segments: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'First voice.' }]
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: segments })} />)
    expect(screen.queryByRole('button', { name: 'Detect speakers' })).not.toBeInTheDocument()
  })

  it('detects speakers automatically or with a forced count', () => {
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

  it('returns focus to the speaker chip when the popover is cancelled with Escape', async () => {
    const onRenameSpeaker = vi.fn()
    const meta = noteFixture()
    render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedTranscript: twoSpeakers, onRenameSpeaker })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 2' }))
    const input = screen.getByRole('textbox', { name: 'Speaker name' })
    fireEvent.change(input, { target: { value: 'Abandoned' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onRenameSpeaker).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Speaker 2' })).toHaveFocus())
  })

  it('merges a speaker into another from the popover and offers exact undo', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Rename Speaker 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Merge with another speaker…' }))
    expect(screen.getByRole('combobox', { name: 'Merge into speaker' })).toHaveValue('Speaker 2')
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(onMergeSpeakers).toHaveBeenCalledWith(meta.id, 'Speaker 1', 'Speaker 2'))
    expect(await screen.findByText(/merged into/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename Speaker 1' })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(onUndoSpeakerMerge).toHaveBeenCalledWith(meta.id, undo))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument())
  })

  it('pins and unpins the current note from the note menu', () => {
    const onSetPinned = vi.fn()
    const meta = noteFixture({ pinned: false })
    const { rerender } = render(<NoteView {...makeProps({ meta, selectedMeta: meta, onSetPinned })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin note' }))
    expect(onSetPinned).toHaveBeenCalledWith(meta.id, true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    const pinned = noteFixture({ pinned: true })
    rerender(<NoteView {...makeProps({ meta: pinned, selectedMeta: pinned, onSetPinned })} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin note' }))
    expect(onSetPinned).toHaveBeenLastCalledWith(meta.id, false)
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
    render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
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
          onDeleteMarker,
        })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete marker Pricing decision' }))
    expect(onDeleteMarker).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete marker Pricing decision' }))
    await waitFor(() => expect(onDeleteMarker).toHaveBeenCalledWith(meta.id, 0))
  })

  it('offers exact marker undo after a delete', async () => {
    const onDeleteMarker = vi.fn().mockResolvedValue(undefined)
    const onAddMarker = vi.fn().mockResolvedValue(undefined)
    const meta = noteFixture({ markers: [{ seconds: 94, label: 'Pricing decision' }] })
    render(
      <NoteView
        {...makeProps({
          meta,
          selectedMeta: meta,
          onDeleteMarker,
          onAddMarker,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete marker Pricing decision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete marker Pricing decision' }))
    await waitFor(() => screen.getByText('Marker “Pricing decision” deleted.'))
    const undo = screen.getByRole('button', { name: 'Undo' })
    await waitFor(() => expect(undo).toHaveFocus())
    fireEvent.click(undo)
    await waitFor(() => expect(onAddMarker).toHaveBeenCalledWith(meta.id, 94, 'Pricing decision'))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Recording markers' })).toHaveFocus())
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

      openAsk()
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

  describe('toolbar', () => {
    it('exports the note from the Export button', () => {
      const onExport = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onExport })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      expect(onExport).toHaveBeenCalledWith(meta.id)
    })

    it('shows no Obsidian status while export is off', () => {
      const meta = noteFixture({ obsidian: { path: '/vault/Meetings/a.md', savedAt: '2026-05-21T15:00:00.000Z' } })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
      expect(screen.queryByText('Saved to Obsidian')).not.toBeInTheDocument()
    })

    it('shows "Saved to Obsidian" once the note has a good save', () => {
      const meta = noteFixture({ obsidian: { path: '/vault/Meetings/a.md', savedAt: '2026-05-21T15:00:00.000Z' } })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, obsidianEnabled: true })} />)
      expect(screen.getByText('Saved to Obsidian')).toHaveAttribute('title', '/vault/Meetings/a.md')
    })

    it('shows a short error line, with the reason on hover, after a failed save', () => {
      const meta = noteFixture({ obsidian: { path: '/vault/Meetings/a.md', savedAt: '2026-05-21T15:00:00.000Z', error: 'vault folder is missing' } })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, obsidianEnabled: true })} />)
      expect(screen.getByText('Not saved to Obsidian')).toHaveAttribute('title', 'vault folder is missing')
      expect(screen.queryByText('Saved to Obsidian')).not.toBeInTheDocument()
    })

    it('says so while a manual save runs, and shows nothing before the first export', () => {
      const meta = noteFixture()
      const { rerender } = render(<NoteView {...makeProps({ meta, selectedMeta: meta, obsidianEnabled: true })} />)
      expect(screen.queryByText(/Obsidian/)).not.toBeInTheDocument()
      rerender(<NoteView {...makeProps({ meta, selectedMeta: meta, obsidianEnabled: true, obsidianSaving: true })} />)
      expect(screen.getByText('Saving to Obsidian…')).toBeInTheDocument()
    })

    it('renders the controls passed for a hidden sidebar at the start of the toolbar', () => {
      render(<NoteView {...makeProps({ toolbarLead: <button type="button">Notes</button> })} />)
      expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument()
    })
  })

  describe('note menu', () => {
    const writeText = vi.fn()

    beforeEach(() => {
      writeText.mockReset()
      writeText.mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    })

    it('opens with focus on the first item and closes on Escape, returning focus to its button', async () => {
      render(<NoteView {...makeProps()} />)
      openMenu()
      const menu = screen.getByRole('menu', { name: 'Actions for “Client call — Acme”' })
      expect(within(menu).getByRole('menuitem', { name: 'Pin note' })).toHaveFocus()
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
      expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
      fireEvent.keyDown(menu, { key: 'Escape' })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'More note actions' })).toHaveFocus())
    })

    it('copies the backend-provided Markdown', () => {
      const meta = noteFixture()
      const markdown = '# Client call — Acme\n\n## Transcript\n\nThanks for making time.'
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedMarkdown: markdown })} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }))
      expect(writeText).toHaveBeenCalledWith(markdown)
    })

    it('does not copy Markdown from a different (stale) note while still loading', () => {
      const meta = noteFixture({ id: 'note-1' })
      const staleMeta = noteFixture({ id: 'note-0' })
      render(<NoteView {...makeProps({ meta, selectedMeta: staleMeta, selectedMarkdown: '# stale note', transcriptLoading: true })} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }))
      expect(writeText).toHaveBeenCalledWith('')
    })

    it('reports a clipboard rejection through onCopyError', async () => {
      const onCopyError = vi.fn()
      const failure = new Error('denied')
      writeText.mockRejectedValue(failure)
      render(<NoteView {...makeProps({ onCopyError })} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }))
      await waitFor(() => expect(onCopyError).toHaveBeenCalledWith(failure))
    })

    it('reports a clear error when the clipboard is unavailable', () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      const onCopyError = vi.fn()
      render(<NoteView {...makeProps({ onCopyError })} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }))
      expect(onCopyError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Clipboard unavailable' }))
    })

    it('shows the note in Finder, with its size on the row', () => {
      const onReveal = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onReveal })} />)
      openMenu()
      const item = screen.getByRole('menuitem', { name: /Show in Finder/ })
      expect(item).toHaveTextContent('12 MB')
      fireEvent.click(item)
      expect(onReveal).toHaveBeenCalledWith(meta.id)
    })

    it('starts the title editor from Rename', () => {
      render(<NoteView {...makeProps()} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
      const input = screen.getByRole('textbox', { name: 'Note title' })
      expect(input).toHaveValue('Client call — Acme')
      expect(input).toHaveFocus()
    })

    it('offers "Save to Obsidian again" only while export is on', () => {
      const onSaveToObsidian = vi.fn()
      const meta = noteFixture()
      const { rerender } = render(<NoteView {...makeProps({ meta, selectedMeta: meta, onSaveToObsidian })} />)
      openMenu()
      expect(screen.queryByRole('menuitem', { name: 'Save to Obsidian again' })).not.toBeInTheDocument()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

      rerender(<NoteView {...makeProps({ meta, selectedMeta: meta, onSaveToObsidian, obsidianEnabled: true })} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save to Obsidian again' }))
      expect(onSaveToObsidian).toHaveBeenCalledWith(meta.id)
    })

    it('locks "Save to Obsidian again" while a save is in flight', () => {
      render(<NoteView {...makeProps({ obsidianEnabled: true, obsidianSaving: true })} />)
      openMenu()
      expect(screen.getByRole('menuitem', { name: 'Saving to Obsidian…' })).toBeDisabled()
    })

    it('offers "Detect speakers again…" only when the speaker models are installed', () => {
      const onDetectSpeakers = vi.fn()
      const meta = noteFixture()
      const { rerender } = render(<NoteView {...makeProps({ meta, selectedMeta: meta, onDetectSpeakers })} />)
      openMenu()
      expect(screen.queryByRole('menuitem', { name: 'Detect speakers again…' })).not.toBeInTheDocument()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

      rerender(<NoteView {...makeProps({ meta, selectedMeta: meta, onDetectSpeakers, canDetectSpeakers: true })} />)
      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Detect speakers again…' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Number of speakers' }), { target: { value: '3' } })
      fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
      expect(onDetectSpeakers).toHaveBeenCalledWith(meta.id, 3)
    })

    it('deletes only the audio after a second press, and says what stays', async () => {
      const onDeleteAudio = vi.fn().mockResolvedValue(undefined)
      render(<NoteView {...makeProps({ onDeleteAudio })} />)
      openMenu()
      const item = screen.getByRole('menuitem', { name: /Delete audio only/ })
      expect(item).toHaveTextContent('11 MB')
      fireEvent.click(item)
      expect(onDeleteAudio).not.toHaveBeenCalled()
      expect(screen.getByText('Keeps the transcript, summary, markers, and Markdown. This cannot be undone.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: /Confirm delete audio/ }))
      await waitFor(() => expect(onDeleteAudio).toHaveBeenCalledTimes(1))
    })

    it('shows the audio as already removed instead of offering to delete it', () => {
      const meta = noteFixture({ audioDeleted: true })
      render(<NoteView {...makeProps({ meta, selectedMeta: meta })} />)
      openMenu()
      expect(screen.getByRole('menuitem', { name: 'Audio removed' })).toBeDisabled()
    })
  })

  describe('summary and Ask wiring', () => {
    it('shows the real summary on the page', () => {
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


    it('shows the "Generate summary" empty state when llmInstalled and no summary yet', () => {
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: null, llmInstalled: true })} />)
      expect(screen.getByRole('button', { name: 'Generate summary' })).toBeInTheDocument()
    })

    it('shows the no-LLM placeholder and calls onGoSettings when no summary yet and no LLM installed', () => {
      const onGoSettings = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, selectedSummary: null, llmInstalled: false, onGoSettings })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Download a summary model' }))
      expect(onGoSettings).toHaveBeenCalledTimes(1)
    })

    it('shows the ask history in the Ask panel once it is opened', () => {
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
      expect(screen.queryByText('What did they decide?')).not.toBeInTheDocument()
      openAsk()
      expect(screen.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('What did they decide?')).toBeInTheDocument()
      expect(screen.getByText('They locked pricing.')).toBeInTheDocument()
    })

    it('submitting a question in the ask input calls onAsk with the note id and question', () => {
      const onAsk = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, llmInstalled: true, onAsk })} />)

      openAsk()
      const input = screen.getByPlaceholderText('Ask a question')
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
      openAsk()
      const citation = screen.getByRole('button', { name: 'Play from 01:34' })
      expect(() => fireEvent.click(citation)).not.toThrow()
      // A citation plays without closing the panel.
      expect(screen.getByRole('dialog', { name: 'Ask about this meeting' })).toBeInTheDocument()
    })

    it('closes the Ask panel on Escape and returns focus to the Ask button', async () => {
      render(<NoteView {...makeProps({ llmInstalled: true })} />)
      openAsk()
      fireEvent.keyDown(screen.getByPlaceholderText('Ask a question'), { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Ask about this meeting' })).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' })).toHaveFocus())
    })

    it('announces summarizing, queued, and answering through one status region', () => {
      const announced = (text: string) => screen.getAllByRole('status').some(node => node.textContent === text)
      const { rerender } = render(<NoteView {...makeProps({ summaryStatus: 'running' })} />)
      expect(announced('Summarizing on this Mac…')).toBe(true)
      rerender(<NoteView {...makeProps({ summaryStatus: 'queued' })} />)
      expect(announced('Summary queued')).toBe(true)
      rerender(<NoteView {...makeProps({ askStatus: 'running' })} />)
      expect(announced('Answering…')).toBe(true)
    })

    it('shows the summary error on the page', () => {
      const meta = noteFixture()
      render(
        <NoteView
          {...makeProps({ meta, selectedMeta: meta, summaryStatus: 'error', summaryError: 'no summary model installed' })}
        />,
      )
      expect(screen.getByRole('alert')).toHaveTextContent('no summary model installed')
    })
  })

  describe('rename', () => {
    it('clicking the pencil button reveals an input pre-filled with the current title', () => {
      render(<NoteView {...makeProps()} />)
      fireEvent.click(screen.getByTitle('Rename note'))
      expect(screen.getByRole('textbox')).toHaveValue('Client call — Acme')
      expect(screen.queryByRole('heading', { name: 'Client call — Acme' })).not.toBeInTheDocument()
    })

    it('pressing Enter commits the new title, exits edit mode, and restores focus', async () => {
      const onRename = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onRename })} />)

      fireEvent.click(screen.getByTitle('Rename note'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'New title' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith(meta.id, 'New title')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename note' })).toHaveFocus())
    })

    it('pressing Escape reverts the draft and restores focus without renaming', async () => {
      const onRename = vi.fn()
      render(<NoteView {...makeProps({ onRename })} />)

      fireEvent.click(screen.getByTitle('Rename note'))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Changed but abandoned' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(onRename).not.toHaveBeenCalled()
      expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename note' })).toHaveFocus())
    })

    it('does not call onRename when the title is unchanged', () => {
      const onRename = vi.fn()
      render(<NoteView {...makeProps({ onRename })} />)

      fireEvent.click(screen.getByTitle('Rename note'))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

      expect(onRename).not.toHaveBeenCalled()
    })

    it('committing on blur also calls onRename', () => {
      const onRename = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onRename })} />)

      fireEvent.click(screen.getByTitle('Rename note'))
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

    it('first press arms a confirmation without deleting; second press deletes', () => {
      const onDelete = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onDelete })} />)

      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete note' }))
      expect(onDelete).not.toHaveBeenCalled()
      expect(screen.getByText('Press again to confirm.')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('menuitem', { name: 'Confirm delete note' }))
      expect(onDelete).toHaveBeenCalledWith(meta.id)
    })

    it('disarms the confirmation after the timeout elapses without a second press', () => {
      const onDelete = vi.fn()
      const meta = noteFixture()
      render(<NoteView {...makeProps({ meta, selectedMeta: meta, onDelete })} />)

      openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete note' }))
      expect(screen.getByRole('menuitem', { name: 'Confirm delete note' })).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(4000)
      })

      expect(screen.getByRole('menuitem', { name: 'Delete note' })).toBeInTheDocument()
      expect(onDelete).not.toHaveBeenCalled()
    })
  })

  it('restores each note’s scroll position after switching notes', () => {
    const noteA = noteFixture({ id: 'note-a' })
    const noteB = noteFixture({ id: 'note-b' })
    const { rerender } = render(<NoteView {...makeProps({ meta: noteA, selectedMeta: noteA })} />)
    const scroller = screen.getByTestId('note-scroll')
    scroller.scrollTop = 240
    fireEvent.scroll(scroller)

    rerender(<NoteView {...makeProps({ meta: noteB, selectedMeta: noteB })} />)
    expect(screen.getByTestId('note-scroll').scrollTop).toBe(0)
    screen.getByTestId('note-scroll').scrollTop = 80
    fireEvent.scroll(screen.getByTestId('note-scroll'))

    rerender(<NoteView {...makeProps({ meta: noteA, selectedMeta: noteA })} />)
    expect(screen.getByTestId('note-scroll').scrollTop).toBe(240)
  })
})
