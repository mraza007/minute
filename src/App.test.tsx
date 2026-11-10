import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import type { Hardware, ModelStatus, NoteMeta, NoteWithTranscript, Recommendation, Settings, StorageStats } from './ipc/types'
import { DEFAULT_OBSIDIAN_SETTINGS } from './state/obsidian'

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
  llmContextTokens: null,
  summaryStyle: 'standard',
  summaryInstructions: '',
  autoUpdateCheck: true,
  detectSpeakers: false,
  autoStopRecording: true,
  compressAudioAfterDays: null,
  speakerProfiles: false,
  autoApplySpeakerNames: true,
  obsidian: DEFAULT_OBSIDIAN_SETTINGS,
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
  /** What `summarize_now` resolves with. Defaults to `null`. */
  summarizeNow?: 'started' | 'next' | 'notQueued'
  /** Overrides `audio_input_status`'s response, evaluated fresh on every call (so a test can make a later re-check hang or change its answer) — defaults to one authorized built-in microphone. */
  audioInputStatus?: () => unknown
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
          if (opts.audioInputStatus) return opts.audioInputStatus()
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
        case 'summarize_now':
          return opts.summarizeNow ?? null
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
  await waitFor(() => screen.getByRole('dialog', { name: 'New recording' }))
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
    expect(container.querySelector('.app-paper')).toHaveStyle({ minWidth: 'min(860px, 100vw)' })
  })

  it('boots to the onboarding gate when no STT model is installed', async () => {
    setupIPC({ models: [sttModel({ state: 'notInstalled' }), llmModel()] })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Meeting notes that never leave your Mac')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()
  })

  it('opens a real-source preflight before switching to RecordingView', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'New recording' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('built-in')
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
    const recordingRow = screen.getByRole('button', { name: 'Return to recording' })
    expect(recordingRow).toHaveTextContent('Recording')
    expect(recordingRow).toHaveTextContent('00:00')
  })

  it('keeps Start clickable with the previous devices while a reopened preflight re-checks', async () => {
    let holdRefresh = false
    setupIPC({
      audioInputStatus: () =>
        holdRefresh
          ? new Promise(() => {})
          : {
              devices: [{ id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true }],
              defaultDeviceId: 'built-in',
              permission: 'authorized',
            },
    })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New recording' })).not.toBeInTheDocument())

    // The re-check on this reopen never resolves — the sheet must still be
    // immediately usable with the devices it already knows.
    holdRefresh = true
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'New recording' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('built-in')
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeEnabled()
    expect(screen.queryByText('Checking microphones…')).not.toBeInTheDocument()
  })

  it('applies only the newest device re-check when overlapping refreshes resolve out of order', async () => {
    const pending: Array<(status: unknown) => void> = []
    const status = (id: string) => ({
      devices: [{ id, name: id === 'usb' ? 'USB Interface' : 'MacBook Pro Microphone', isDefault: true }],
      defaultDeviceId: id,
      permission: 'authorized',
    })
    setupIPC({ audioInputStatus: () => new Promise(resolve => { pending.push(resolve) }) })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))

    // Cold open: resolve the first enumeration to establish a warm state.
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => pending[0](status('built-in')))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('built-in'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // Two warm reopens leave two re-checks in flight. The newer one resolves
    // first with the current truth; the older, stale one resolves after and
    // must not clobber it.
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => pending[2](status('usb')))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('usb'))
    await act(async () => pending[1](status('built-in')))
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('usb')
  })

  it('keeps global search shortcuts from opening a second dialog behind the preflight', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'New recording' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(screen.queryByRole('dialog', { name: 'Search notes' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'New recording' })).toBeInTheDocument()
  })

  it('opens the shortcut list in Settings > About with Command-slash', async () => {
    setupIPC()
    render(<App />)
    await screen.findByRole('button', { name: 'Settings' })
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    expect(await screen.findByRole('list', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About' })).toHaveAttribute('aria-current', 'page')
  })

  it('returns to the notes view when Stop is clicked', async () => {
    setupIPC()
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument())
  })

  it('shows the Settings sections in place of the sidebar and returns to the notes via the back link', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Recording' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Notes' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument()

    // Back returns to the note that was open, not the pick-a-note state.
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'All notes' })).not.toBeInTheDocument()
  })

  it('keeps the open note open when the list refreshes during a recording', async () => {
    const older = noteFixture({ id: 'n0', title: 'Older call', createdAt: '2026-07-20T12:00:00.000Z' })
    const newer = noteFixture({ id: 'n1', title: 'Newer call', createdAt: '2026-07-21T12:00:00.000Z' })
    const live = noteFixture({ id: 'rec1', title: 'New recording', status: 'recording' })
    let recording = false
    setupIPC({
      notes: [newer, older, live],
      listNotes: () => (recording ? [live, newer, older] : [newer, older]),
      startRecordingId: 'rec1',
    })
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
    recording = true

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Notes' })).getByText('Older call'))
    await screen.findByRole('heading', { name: 'Older call' })

    // Its summary finishes, which refreshes the list. The live note now sits at index 0.
    await act(async () => {
      await emit('summary-status', { noteId: 'n0', state: 'done', error: null })
    })
    await waitFor(() =>
      expect(within(screen.getByRole('navigation', { name: 'Notes' })).getByText('New recording')).toBeInTheDocument(),
    )
    expect(screen.getByRole('heading', { name: 'Older call' })).toBeInTheDocument()
  })

  // Each control unmounts when it is pressed, so focus moves to the one
  // that undoes it instead of falling to <body>.
  it('moves focus to the toolbar "Notes" button when the sidebar collapses, and to the collapse control when it returns', async () => {
    setupIPC()
    render(<App />)
    await screen.findByRole('heading', { name: 'Client call — Acme' })

    fireEvent.click(screen.getByRole('button', { name: 'Collapse library sidebar' }))
    expect(screen.getByRole('button', { name: 'Show notes' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Show notes' }))
    expect(screen.getByRole('button', { name: 'Collapse library sidebar' })).toHaveFocus()
    window.localStorage.clear()
  })

  it('opens Settings > Recording from the empty library\'s meeting detection link', async () => {
    setupIPC({ notes: [] })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Meeting detection settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Meeting detection settings' }))
    expect(screen.getByRole('button', { name: 'Recording' })).toHaveAttribute('aria-current', 'page')
  })

  it('still says a summary starts next after the user leaves the note and comes back', async () => {
    const waiting = noteFixture({ id: 'n-wait', title: 'Waiting call' })
    const other = noteFixture({ id: 'n-other', title: 'Other call', createdAt: '2026-07-21T12:00:00.000Z' })
    setupIPC({ models: [sttModel({ state: 'installed' }), llmModel({ state: 'installed' })], notes: [waiting, other], summarizeNow: 'next' })
    render(<App />)
    await screen.findByRole('heading', { name: 'Waiting call' })
    await act(async () => {
      await emit('summary-status', { noteId: 'n-other', state: 'running', error: null })
      await emit('summary-status', { noteId: 'n-wait', state: 'queued', error: null })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize now' }))
    expect(await screen.findByRole('button', { name: 'Starts next' })).toBeDisabled()

    const sidebar = within(screen.getByRole('navigation', { name: 'Notes' }))
    fireEvent.click(sidebar.getByText('Other call'))
    await screen.findByRole('heading', { name: 'Other call' })
    fireEvent.click(sidebar.getByText('Waiting call'))
    await screen.findByRole('heading', { name: 'Waiting call' })

    expect(screen.getByRole('button', { name: 'Starts next' })).toBeDisabled()
    expect(screen.getByText(/It starts next, when the summary that is running ends/)).toBeInTheDocument()
  })

  it('ignores Command-slash during onboarding', async () => {
    setupIPC({ models: [sttModel({ state: 'notInstalled' }), llmModel()] })
    render(<App />)
    await screen.findByText('Meeting notes that never leave your Mac')
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    expect(screen.getByText('Meeting notes that never leave your Mac')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
  })

  it('ignores Command-slash while loading', async () => {
    setupIPC()
    render(<App />)
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    await screen.findByRole('heading', { name: 'Client call — Acme' })
    expect(screen.queryByRole('list', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
  })

  it('opens Settings > Models from "Download a summary model", whatever section was open last', async () => {
    setupIPC()
    render(<App />)
    await screen.findByRole('heading', { name: 'Client call — Acme' })
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    await screen.findByRole('list', { name: 'Keyboard shortcuts' })
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))

    fireEvent.click(screen.getByRole('button', { name: 'Download a summary model' }))
    expect(screen.getByRole('button', { name: 'Models' })).toHaveAttribute('aria-current', 'page')

    // The Ask panel's link goes to the same section.
    fireEvent.click(screen.getByRole('button', { name: 'About' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Ask about this meeting' })).getByRole('button', { name: 'Download a summary model' }))
    expect(screen.getByRole('button', { name: 'Models' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens Settings > Models from the preflight, whatever section was open last', async () => {
    setupIPC()
    render(<App />)
    await screen.findByRole('heading', { name: 'Client call — Acme' })
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    await screen.findByRole('list', { name: 'Keyboard shortcuts' })
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))

    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    await screen.findByRole('dialog', { name: 'New recording' })
    fireEvent.click(await screen.findByRole('button', { name: 'Get more models in Settings' }))
    expect(screen.getByRole('button', { name: 'Models' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens Settings > Recording from the automatic-start notice, and keeps the recording automatic', async () => {
    setupIPC()
    render(<App />)
    await screen.findByRole('heading', { name: 'Client call — Acme' })
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    await screen.findByRole('list', { name: 'Keyboard shortcuts' })
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))

    await act(async () => {
      await emit('meeting-popup-start', { origin: { kind: 'automatic', appName: 'Zoom' } })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Return to recording' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    expect(screen.getByRole('button', { name: 'Recording' })).toHaveAttribute('aria-current', 'page')
  })

  it('starts a recording after going back from Settings', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Notes' })).getByRole('button', { name: /new recording/i }))
    expect(await screen.findByRole('dialog', { name: 'New recording' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
  })

  it('leaves Settings when a note is selected after going back', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Notes' })).getByText('Client call — Acme'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument())
    expect(screen.queryByRole('heading', { level: 1, name: 'Recording' })).not.toBeInTheDocument()
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
      const onButton = fireEvent.contextMenu(screen.getByRole('button', { name: /new recording/i }))
      expect(onButton).toBe(false)
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      const onInput = fireEvent.contextMenu(await screen.findByPlaceholderText(/search/i))
      expect(onInput).toBe(true)
    })
  })

  it('shows the sidebar and NoteView empty states when the note library is empty', async () => {
    setupIPC({ notes: [] })
    render(<App />)
    await screen.findByText('Your notes appear here.')
    expect(screen.getByText('Your notes appear here.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Record your first meeting' })).toBeInTheDocument()
  })

  it('clears the "Finalizing transcript…" pill once stop resolves, showing the Transcribed pill instead', async () => {
    // Deliberately not titled "New recording" — that text collides with
    // the sidebar's own "New recording" button, which would make the
    // `/new recording/i` role query below ambiguous.
    const finishedNote = noteFixture({ id: '20260722-130000', title: 'Finished smoke test note', status: 'transcribed' })
    setupIPC({
      notes: [finishedNote],
      startRecordingId: '20260722-130000',
      stopRecordingResult: finishedNote,
    })
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))

    // The backend's tail-window flush is still in flight when the user
    // hits stop — the pill should reflect that while stopRecording()'s
    // promise hasn't resolved yet.
    await act(async () => {
      await emit('stt-status', { noteId: '20260722-130000', state: 'finalizing', error: null })
    })

    fireEvent.click(screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Finished smoke test note' })).toBeInTheDocument())
    expect(screen.queryByText('Finalizing transcript…')).not.toBeInTheDocument()
    expect(screen.getByText('Transcribed')).toBeInTheDocument()
  })

  it('keeps a recording reachable and its live transcript accumulating while navigated away to Settings, and back to Notes, via the REC pill', async () => {
    setupIPC()
    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())

    await act(async () => {
      await emit('transcript-segment', { noteId: '20260722-130000', speaker: 'Speaker 1', start: 0, end: 1, text: 'Hello there' })
    })
    expect(screen.getByText('Hello there')).toBeInTheDocument()

    // Navigate to Settings mid-recording — the REC pill (not "New
    // recording") must still be showing, proving `isRecording` survived
    // the view change instead of collapsing back to false.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Recording' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()

    // A live segment arriving while a different screen is on-screen must
    // still be captured — the event subscriptions are unconditional.
    await act(async () => {
      await emit('transcript-segment', { noteId: '20260722-130000', speaker: 'Speaker 1', start: 1, end: 2, text: 'how are you' })
    })

    // Also navigate through Notes mid-recording — allowed, and still
    // doesn't lose the recording. Back lands on the note that was open,
    // REC pill intact.
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()

    // Clicking the REC pill returns to the live recording view with every
    // segment accumulated so far — including the one that arrived while on
    // Settings — visible and merged.
    fireEvent.click(screen.getByRole('button', { name: 'Return to recording' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument())
    expect(screen.getByText('Hello there how are you')).toBeInTheDocument()
  })

  it('shows an error banner when stopping a recording fails, and not otherwise', async () => {
    setupIPC({ stopRecordingReject: 'wav writer thread panicked' })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('wav writer thread panicked'))
  })

  it('simulates native input and model-worker failures without losing the active recording', async () => {
    const noteId = '20260722-130000'
    setupIPC({ startRecordingId: noteId })
    render(<App />)
    await startRecordingFromTitle()
    await screen.findByRole('button', { name: 'Pause' })

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

    // One message at a time: the lost microphone outranks the lost transcript.
    expect(await screen.findByText('USB Podcast Mic stopped responding')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop and save' })).toBeInTheDocument()
    expect(screen.queryByText('The live transcript stopped')).not.toBeInTheDocument()

    await act(async () => {
      await emit('recording-state', {
        noteId,
        state: 'recording',
        elapsed: 43,
        systemAudioActive: false,
        microphoneName: 'USB Podcast Mic',
        inputRms: 0.08,
        inputPeak: 0.4,
        inputSequence: 3,
        inputError: null,
      })
    })
    expect(await screen.findByText('The live transcript stopped')).toBeInTheDocument()
    expect(screen.getByText('Audio is still recording. model worker exited unexpectedly')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop and (summarize|transcribe)/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()
  })

  it('auto-trigger simulation: record, stop, summary-status running then done shows the real summary on the note page', async () => {
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
          ? { summary: 'Auto-generated summary of the call.', topics: [], decisions: [], actionItems: [] }
          : null,
        markdown: '# Auto-summarized note',
        audioPath: null,
      }),
    })

    render(<App />)
    await startRecordingFromTitle()
    await waitFor(() => screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop and (summarize|transcribe)/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Auto-summarized note' })).toBeInTheDocument())

    // Backend auto-triggers summarize_note after stop_recording finalizes —
    // simulated here directly via the summary-status events it emits.
    await act(async () => {
      await emit('summary-status', { noteId, state: 'running', error: null })
    })
    expect(within(screen.getByRole('navigation', { name: 'Notes' })).getByText('Summarizing…')).toBeInTheDocument()
    // The note that just stopped shows what is still running on it.
    const finishing = screen.getByRole('region', { name: 'Finishing this note' })
    expect(within(finishing).getByText('Audio saved')).toBeInTheDocument()
    expect(within(finishing).getByRole('button', { name: 'Skip summary' })).toBeInTheDocument()

    summarized = true
    await act(async () => {
      await emit('summary-status', { noteId, state: 'done', error: null })
    })

    await waitFor(() => expect(screen.getByText('Auto-generated summary of the call.')).toBeInTheDocument())
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.queryByText('Summarizing…')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Finishing this note' })).not.toBeInTheDocument()
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
