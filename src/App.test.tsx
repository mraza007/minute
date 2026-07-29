import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import type { Hardware, ModelStatus, NoteMeta, NoteWithTranscript, Recommendation, Settings, StorageStats } from './ipc/types'

const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
const storage: StorageStats = { modelsBytes: 500_000_000, audioBytes: 200_000_000, notesBytes: 100_000_000 }
const settings: Settings = {
  sttModel: null,
  llmModel: null,
  deleteAudioAfter30d: true,
  meetingDetection: false,
  captureSystemAudio: false,
  libraryRoot: null,
}

function sttModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    desc: 'good for meetings',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: 'a'.repeat(64),
    sizeBytes: 466_000_000,
    minRamGb: 0,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

function llmModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'qwen3.5-4b',
    kind: 'llm',
    displayName: 'Qwen3.5-4B',
    desc: 'fast default summarizer',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    sha256: 'b'.repeat(64),
    sizeBytes: 2_600_000_000,
    minRamGb: 8,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

function noteFixture(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260722-120000',
    title: 'Client call — Acme',
    createdAt: '2026-07-22T12:00:00.000Z',
    durationSec: 48 * 60,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 4,
    audioDeleted: false,
    sources: ['mic'],
    ...overrides,
  }
}

interface SetupOpts {
  models?: ModelStatus[]
  notes?: NoteMeta[]
  startRecordingId?: string
  stopRecordingResult?: NoteMeta
  stopRecordingReject?: string
  /** Overrides `get_note`'s response — defaults to `{ meta: match, transcript: { segments: [] }, summary: null, markdown: '# {title}' }`. */
  getNote?: (id: string) => NoteWithTranscript
  /** Overrides `list_notes`'s response, evaluated fresh on every call (so it can reflect state mutated after the initial render, e.g. a note flipping to `ready`) — defaults to the static `notes` fixture. */
  listNotes?: () => NoteMeta[]
}

function setupIPC(opts: SetupOpts = {}) {
  const models = opts.models ?? [sttModel({ state: 'installed' }), llmModel()]
  const notes = opts.notes ?? [noteFixture()]
  mockIPC(
    (cmd, args) => {
      switch (cmd) {
        case 'list_models':
          return models
        case 'list_notes':
          // Fresh array each call, like the real store — a same-reference
          // return would let React's setNotes bail out on refetches.
          return opts.listNotes ? opts.listNotes() : [...notes]
        case 'hardware_info':
          return hardware
        case 'recommended_models':
          return recommendation
        case 'storage_stats':
          return storage
        case 'audio_input_status':
          return {
            devices: [{ id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true }],
            defaultDeviceId: 'built-in',
            permission: 'authorized',
          }
        case 'request_microphone_permission':
          return 'authorized'
        case 'start_recording':
          return opts.startRecordingId ?? '20260722-130000'
        case 'stop_recording':
          if (opts.stopRecordingReject) throw opts.stopRecordingReject
          return opts.stopRecordingResult ?? notes[0] ?? noteFixture()
        case 'get_note': {
          const { id } = args as { id: string }
          if (opts.getNote) return opts.getNote(id)
          const match = notes.find(n => n.id === id) ?? notes[0] ?? noteFixture()
          return {
            meta: match,
            transcript: { segments: [] },
            summary: null,
            markdown: `# ${match.title}`,
            audioPath: null,
          } satisfies NoteWithTranscript
        }
        case 'rename_note': {
          const { id, title } = args as { id: string; title: string }
          const match = notes.find(n => n.id === id) ?? notes[0] ?? noteFixture()
          // Mutate the fixture so the follow-up `list_notes` refetch reflects
          // the rename, the way the real store does.
          match.title = title
          return { ...match }
        }
        case 'delete_note': {
          const { id } = args as { id: string }
          const match = notes.find(note => note.id === id) ?? notes[0] ?? noteFixture()
          return { id, title: match.title, trashName: `${id}-trash`, checksum: 'recovery-checksum' }
        }
        case 'note_storage_stats':
          return { totalBytes: 12_000, audioBytes: 10_000, documentBytes: 2_000 }
        case 'delete_notes':
          return []
        case 'restore_notes':
          return notes
        case 'export_notes':
        case 'export_diagnostics':
          return '/tmp/export'
        case 'reveal_note':
          return null
        case 'get_settings':
        case 'set_settings':
          return settings
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}

async function startRecordingFromTitle() {
  await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
  fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
  await waitFor(() => screen.getByRole('dialog', { name: 'Ready to record' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
}

describe('App', () => {
  it('shows a loading state before the initial IPC calls resolve', () => {
    setupIPC()
    render(<App />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('boots to the notes view with the sidebar and NoteView once an STT model is installed', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /new recording/i })).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('lets enlarged-text layouts reflow within the viewport', async () => {
    setupIPC()
    const { container } = render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /new recording/i })).toBeInTheDocument())
    expect(container.querySelector('.app-paper')).toHaveStyle({ minWidth: 'min(1180px, 100vw)' })
  })

  it('boots to the onboarding gate when no STT model is installed', async () => {
    setupIPC({ models: [sttModel({ state: 'notInstalled' }), llmModel()] })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Minute runs entirely on this Mac.')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()
  })

  it('opens a real-source preflight before switching to RecordingView', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'Ready to record' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('built-in')
    expect(screen.queryByText('Live transcript — audio never leaves this machine')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    await waitFor(() => expect(screen.getByText('Live transcript — audio never leaves this machine')).toBeInTheDocument())
    expect(screen.getByText('REC 00:00')).toBeInTheDocument()
  })

  it('keeps global search shortcuts from opening a second dialog behind the preflight', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'Ready to record' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(screen.queryByRole('dialog', { name: 'Search notes' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Ready to record' })).toBeInTheDocument()
  })

  it('opens the shortcut reference with Command-slash and restores invoking focus on close', async () => {
    setupIPC()
    render(<App />)
    const trigger = await screen.findByRole('button', { name: 'Keyboard shortcuts' })
    trigger.focus()
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('returns to the notes view when "Stop & transcribe" is clicked', async () => {
    setupIPC()
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop & transcribe/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop & transcribe/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument())
  })

  it('shows SettingsView when Settings is clicked in the sidebar, and returns to notes via "All notes"', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All notes' }))
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('starts a recording from the Settings view and navigates to RecordingView', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'Ready to record' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    await waitFor(() => expect(screen.getByText('Live transcript — audio never leaves this machine')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('leaves Settings when a note is selected from the sidebar', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    fireEvent.click(screen.getByText('Client call — Acme'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
  })

  describe('note right-click menu', () => {
    async function openMenuOnFirstNote() {
      setupIPC()
      render(<App />)
      const sidebar = within(await screen.findByRole('navigation', { name: 'Notes' }))
      const row = await sidebar.findByRole('button', { name: /Client call — Acme/ })
      fireEvent.contextMenu(row)
      return screen.getByRole('menu', { name: /Actions for .Client call — Acme./ })
    }

    it('opens on right-click with the full action set and closes on Escape', async () => {
      const menu = await openMenuOnFirstNote()
      for (const label of ['Rename', 'Pin', 'Reveal in Finder', 'Export…', 'Delete']) {
        expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument()
      }
      fireEvent.keyDown(menu, { key: 'Escape' })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('deletes the note via the menu, with the undo toast', async () => {
      const menu = await openMenuOnFirstNote()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
      await waitFor(() => expect(screen.getByText(/moved to recovery/)).toBeInTheDocument())
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('renames the note inline via the menu', async () => {
      const menu = await openMenuOnFirstNote()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
      const input = screen.getByRole('textbox', { name: 'Rename Client call — Acme' })
      fireEvent.change(input, { target: { value: 'Acme kickoff' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      const sidebar = within(screen.getByRole('navigation', { name: 'Notes' }))
      await waitFor(() => expect(sidebar.getByRole('button', { name: /Acme kickoff/ })).toBeInTheDocument())
    })

    it('suppresses the default context menu outside editable fields only', async () => {
      setupIPC()
      render(<App />)
      await screen.findByRole('button', { name: /new recording/i })
      const onHeading = fireEvent.contextMenu(screen.getByRole('button', { name: /new recording/i }))
      expect(onHeading).toBe(false)
      const onInput = fireEvent.contextMenu(screen.getByLabelText('Search notes'))
      expect(onInput).toBe(true)
    })
  })

  it('shows the sidebar and NoteView empty states when the note library is empty', async () => {
    setupIPC({ notes: [] })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    expect(screen.getAllByText(/no notes yet/i).length).toBeGreaterThan(0)
  })

  it('clears the "Finalizing transcript…" pill once stop resolves, showing the Transcribed pill instead', async () => {
    // Deliberately not titled "New recording" — that text collides with
    // the title bar's own "New recording" button, which would make the
    // `/new recording/i` role query below ambiguous.
    const finishedNote = noteFixture({ id: '20260722-130000', title: 'Finished smoke test note', status: 'transcribed' })
    setupIPC({
      notes: [finishedNote],
      startRecordingId: '20260722-130000',
      stopRecordingResult: finishedNote,
    })
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop & transcribe/i }))

    // The backend's tail-window flush is still in flight when the user
    // hits stop — the pill should reflect that while stopRecording()'s
    // promise hasn't resolved yet.
    await act(async () => {
      await emit('stt-status', { noteId: '20260722-130000', state: 'finalizing', error: null })
    })

    fireEvent.click(screen.getByRole('button', { name: /stop & transcribe/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Finished smoke test note' })).toBeInTheDocument())
    expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
    expect(screen.getByText('Transcribed')).toBeInTheDocument()
  })

  it('keeps a recording reachable and its live transcript accumulating while navigated away to Settings, and back to Notes, via the REC pill', async () => {
    setupIPC()
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => expect(screen.getByText('Live transcript — audio never leaves this machine')).toBeInTheDocument())

    await act(async () => {
      await emit('transcript-segment', { noteId: '20260722-130000', speaker: 'Speaker 1', start: 0, end: 1, text: 'Hello there' })
    })
    expect(screen.getByText('Hello there')).toBeInTheDocument()

    // Navigate to Settings mid-recording — the REC pill (not "New
    // recording") must still be showing, proving `isRecording` survived
    // the view change instead of collapsing back to false.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()

    // A live segment arriving while a different screen is on-screen must
    // still be captured — the event subscriptions are unconditional.
    await act(async () => {
      await emit('transcript-segment', { noteId: '20260722-130000', speaker: 'Speaker 1', start: 1, end: 2, text: 'how are you' })
    })

    // Also navigate through Notes mid-recording — allowed, and still
    // doesn't lose the recording.
    fireEvent.click(screen.getByRole('button', { name: 'All notes' }))
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()

    // Clicking the REC pill returns to the live recording view with every
    // segment accumulated so far — including the one that arrived while on
    // Settings — visible and merged.
    fireEvent.click(screen.getByRole('button', { name: 'Return to recording' }))
    await waitFor(() => expect(screen.getByText('Live transcript — audio never leaves this machine')).toBeInTheDocument())
    expect(screen.getByText('Hello there how are you')).toBeInTheDocument()
  })

  it('shows an error banner when stopping a recording fails, and not otherwise', async () => {
    setupIPC({ stopRecordingReject: 'wav writer thread panicked' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop & transcribe/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop & transcribe/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('wav writer thread panicked'))
  })

  it('simulates native input and model-worker failures without losing the active recording', async () => {
    const noteId = '20260722-130000'
    setupIPC({ startRecordingId: noteId })
    render(<App />)
    await startRecordingFromTitle()
    await screen.findByText('Live transcript — audio never leaves this machine')

    await act(async () => {
      await emit('recording-state', {
        noteId,
        state: 'recording',
        elapsed: 42,
        systemAudioActive: false,
        microphoneName: 'USB Podcast Mic',
        inputRms: 0,
        inputPeak: 0,
        inputSequence: 2,
        inputError: 'device disconnected',
      })
      await emit('stt-status', {
        noteId,
        state: 'error',
        error: 'model worker exited unexpectedly',
      })
    })

    expect(await screen.findByText('Microphone stopped responding')).toBeInTheDocument()
    expect(screen.getAllByText('Transcript unavailable').length).toBeGreaterThan(0)
    expect(screen.getByText('model worker exited unexpectedly')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop & transcribe/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()
  })

  it('auto-trigger simulation: record, stop, summary-status running then done shows the real summary in the AI notes panel', async () => {
    const noteId = '20260722-130000'
    const finishedNote = noteFixture({ id: noteId, title: 'Auto-summarized note', status: 'transcribed' })
    const readyNote = { ...finishedNote, status: 'ready' as const }
    let summarized = false

    setupIPC({
      notes: [finishedNote],
      startRecordingId: noteId,
      stopRecordingResult: finishedNote,
      listNotes: () => [summarized ? readyNote : finishedNote],
      getNote: id => ({
        meta: summarized && id === noteId ? readyNote : finishedNote,
        transcript: { segments: [] },
        summary: summarized
          ? { summary: 'Auto-generated summary of the call.', decisions: [], actionItems: [] }
          : null,
        markdown: '# Auto-summarized note',
        audioPath: null,
      }),
    })

    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop & transcribe/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop & transcribe/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Auto-summarized note' })).toBeInTheDocument())

    // Backend auto-triggers summarize_note after stop_recording finalizes —
    // simulated here directly via the summary-status events it emits.
    await act(async () => {
      await emit('summary-status', { noteId, state: 'running', error: null })
    })
    expect(screen.getByText('Summarizing…')).toBeInTheDocument()

    summarized = true
    await act(async () => {
      await emit('summary-status', { noteId, state: 'done', error: null })
    })

    await waitFor(() => expect(screen.getByText('Auto-generated summary of the call.')).toBeInTheDocument())
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.queryByText('Summarizing…')).not.toBeInTheDocument()
  })

  describe('⌘K / ⌘F search palette shortcut', () => {
    it('⌘K opens the search palette', async () => {
      setupIPC()
      render(<App />)
      await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
      expect(screen.queryByRole('dialog', { name: 'Search notes' })).not.toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'k', metaKey: true })

      expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeInTheDocument()
    })

    it('a second ⌘K while the palette is already open toggles it closed', async () => {
      setupIPC()
      render(<App />)
      await waitFor(() => screen.getByRole('button', { name: /new recording/i }))

      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeInTheDocument()

      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      expect(screen.queryByRole('dialog', { name: 'Search notes' })).not.toBeInTheDocument()
    })

    it('⌘F also opens the search palette', async () => {
      setupIPC()
      render(<App />)
      await waitFor(() => screen.getByRole('button', { name: /new recording/i }))

      fireEvent.keyDown(window, { key: 'f', metaKey: true })

      expect(screen.getByRole('dialog', { name: 'Search notes' })).toBeInTheDocument()
    })

    it('plain "k" (no ⌘) does nothing', async () => {
      setupIPC()
      render(<App />)
      await waitFor(() => screen.getByRole('button', { name: /new recording/i }))

      fireEvent.keyDown(window, { key: 'k', metaKey: false })

      expect(screen.queryByRole('dialog', { name: 'Search notes' })).not.toBeInTheDocument()
    })
  })
})
