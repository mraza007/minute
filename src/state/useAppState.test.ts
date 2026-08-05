import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AudioInputDevice,
  Hardware,
  ModelStatus,
  NoteMeta,
  NoteWithTranscript,
  RecordingStateEvent,
  Recommendation,
  SearchHit,
  Settings,
  StorageStats,
  StoredSegment,
  SttStatusEvent,
  SummaryDoc,
  SummaryStatusEvent,
  SysAudioAvailability,
  TranscriptSegmentEvent,
} from '../ipc/types'
import { useAppState } from './useAppState'

const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
const storage: StorageStats = { modelsBytes: 500_000_000, audioBytes: 200_000_000, notesBytes: 100_000_000 }

function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    sttModel: null,
    llmModel: null,
    deleteAudioAfter30d: true,
    meetingDetection: false,
    captureSystemAudio: false,
    llmContextTokens: null,
    summaryStyle: 'standard' as const,
    summaryInstructions: '',
    autoUpdateCheck: true,
    detectSpeakers: false,
    autoStopRecording: true,
    compressAudioAfterDays: null,
    libraryRoot: null,
    ...overrides,
  }
}

function sttModelFixture(overrides: Partial<ModelStatus> = {}): ModelStatus {
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

function llmModelFixture(overrides: Partial<ModelStatus> = {}): ModelStatus {
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
    durationSec: 600,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 2,
    audioDeleted: false,
    sources: ['mic'],
    ...overrides,
  }
}

interface SetupOpts {
  models?: ModelStatus[]
  notes?: NoteMeta[]
  reject?: boolean
  onCmd?: (cmd: string, args: unknown) => void
  /** Overrides what `list_models` returns after the initial load (e.g. for a post-delete refetch). */
  listModelsAfter?: () => ModelStatus[]
  /** Overrides what `list_notes` returns after the initial load (e.g. for a post-rename/delete refetch). */
  listNotesAfter?: () => NoteMeta[]
  /** What `start_recording` resolves with — defaults to a fixed id. */
  startRecordingId?: string
  /** Controls `stop_recording`'s outcome: resolves with `result` (defaults to `notes[0]`), or rejects with `reject`. */
  stopRecording?: { result?: NoteMeta; reject?: string; wait?: Promise<void> }
  /** Controls `list_notes`/`storage_stats` after a successful `stop_recording`, independent of `stopRecording.reject`. */
  postStopRefreshRejects?: boolean
  /** `get_note(id)`'s response — defaults to `{ meta: notes.find(id) ?? notes[0], transcript: { segments: [] } }`. */
  getNote?: (id: string) => NoteWithTranscript | Promise<NoteWithTranscript>
  /** `rename_note(id, title)`'s response — defaults to the matching note with `title` merged in. */
  renameNoteResult?: (id: string, title: string) => NoteMeta
  /** `get_settings`'s response — defaults to `settingsFixture()`. */
  settings?: Settings
  /** `toggle_action_item(id, index, done)`'s response — defaults to rejecting (tests that need it must supply this). */
  toggleActionItem?: (id: string, index: number, done: boolean) => SummaryDoc | Promise<SummaryDoc>
  /** Forces `toggle_action_item` to reject with this message instead of calling `toggleActionItem`. */
  toggleActionItemReject?: string
  /** Forces `summarize_note` to reject with this message (defaults to resolving `null`). */
  summarizeNoteReject?: string
  /** `search_notes(query)`'s response — defaults to `[]`. */
  searchNotes?: (query: string) => SearchHit[] | Promise<SearchHit[]>
  /** `sys_audio_status`'s initial-load response — defaults to `'unsupported'`. */
  sysAudioAvailability?: SysAudioAvailability
  /** `request_sys_audio_permission`'s response — defaults to whatever `sysAudioAvailability` currently is (a no-op re-check); override to simulate the prompt actually changing the result. */
  requestSysAudioPermissionResult?: SysAudioAvailability
  /** Default microphone returned to the recording preflight. */
  audioInputName?: string | null
  /** Full microphone list returned to the recording preflight. */
  audioInputDevices?: AudioInputDevice[]
}

function setupIPC(opts: SetupOpts = {}) {
  const models = opts.models ?? [sttModelFixture({ state: 'installed' }), llmModelFixture()]
  const notes = opts.notes ?? [noteFixture()]
  const settings = opts.settings ?? settingsFixture()
  let listModelsCalls = 0
  let listNotesCalls = 0
  mockIPC(
    (cmd, args) => {
      opts.onCmd?.(cmd, args)
      if (opts.reject) throw new Error('backend unavailable')
      switch (cmd) {
        case 'list_models':
          listModelsCalls += 1
          if (listModelsCalls > 1 && opts.listModelsAfter) return opts.listModelsAfter()
          return models
        case 'list_notes':
          listNotesCalls += 1
          if (listNotesCalls > 1) {
            if (opts.postStopRefreshRejects) throw new Error('list_notes unavailable')
            if (opts.listNotesAfter) return opts.listNotesAfter()
          }
          return notes
        case 'hardware_info':
          return hardware
        case 'recommended_models':
          return recommendation
        case 'storage_stats':
          return storage
        case 'audio_input_status':
          {
            const devices = opts.audioInputDevices ?? (
              opts.audioInputName === null
                ? []
                : [{
                    id: 'default-input',
                    name: opts.audioInputName ?? 'MacBook Pro Microphone',
                    isDefault: true,
                  }]
            )
            return {
              devices,
              defaultDeviceId: devices.find(device => device.isDefault)?.id ?? null,
              permission: 'authorized',
            }
          }
        case 'request_microphone_permission':
          return 'authorized'
        case 'start_recording':
          return opts.startRecordingId ?? '20260722-130000'
        case 'pause_recording':
        case 'resume_recording':
          return null
        case 'stop_recording':
          if (opts.stopRecording?.reject) throw opts.stopRecording.reject
          if (opts.stopRecording?.wait) {
            return opts.stopRecording.wait.then(() => opts.stopRecording?.result ?? notes[0])
          }
          return opts.stopRecording?.result ?? notes[0]
        case 'get_note': {
          const { id } = args as { id: string }
          if (opts.getNote) return opts.getNote(id)
          const match = notes.find(n => n.id === id) ?? notes[0]
          return { meta: match, transcript: { segments: [] }, summary: null, markdown: '', audioPath: null } satisfies NoteWithTranscript
        }
        case 'rename_note': {
          const { id, title } = args as { id: string; title: string }
          if (opts.renameNoteResult) return opts.renameNoteResult(id, title)
          const match = notes.find(n => n.id === id) ?? notes[0]
          return { ...match, title }
        }
        case 'set_note_pinned': {
          const { id, pinned } = args as { id: string; pinned: boolean }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return { ...match, pinned }
        }
        case 'add_note_marker': {
          const { id, seconds, label } = args as { id: string; seconds: number; label: string }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return { ...match, markers: [...(match.markers ?? []), { seconds, label }] }
        }
        case 'update_note_marker': {
          const { id, index, label } = args as { id: string; index: number; label: string }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return {
            ...match,
            markers: (match.markers ?? []).map((marker, markerIndex) => (
              markerIndex === index ? { ...marker, label } : marker
            )),
          }
        }
        case 'delete_note_marker': {
          const { id, index } = args as { id: string; index: number }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return {
            ...match,
            markers: (match.markers ?? []).filter((_, markerIndex) => markerIndex !== index),
          }
        }
        case 'rename_speaker':
          return { segments: [] }
        case 'merge_speakers': {
          const { id, from, into } = args as { id: string; from: string; into: string }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return {
            transcript: { segments: [] },
            meta: { ...match, speakers: Math.max(1, match.speakers - 1) },
            undo: {
              from,
              into,
              segmentIndices: [0],
              checksum: 'merge-checksum',
            },
          }
        }
        case 'undo_speaker_merge': {
          const { id } = args as { id: string }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return {
            transcript: { segments: [] },
            meta: match,
          }
        }
        case 'delete_note': {
          const { id } = args as { id: string }
          const match = notes.find(note => note.id === id) ?? notes[0]
          return {
            id,
            title: match.title,
            trashName: `${id}-trash`,
            checksum: 'recovery-checksum',
          }
        }
        case 'note_storage_stats':
          return { totalBytes: 12_000, audioBytes: 10_000, documentBytes: 2_000 }
        case 'delete_note_audio': {
          const { id } = args as { id: string }
          const match = notes.find(note => note.id === id) ?? notes[0]
          return { ...match, audioDeleted: true }
        }
        case 'delete_notes':
          return []
        case 'restore_note':
          return notes[0]
        case 'restore_notes':
          return notes
        case 'export_notes':
        case 'export_diagnostics':
          return '/tmp/export'
        case 'reveal_note':
          return null
        case 'get_settings':
          return settings
        case 'set_settings':
          return settings
        case 'toggle_action_item': {
          if (opts.toggleActionItemReject) throw opts.toggleActionItemReject
          const { id, index, done } = args as { id: string; index: number; done: boolean }
          if (opts.toggleActionItem) return opts.toggleActionItem(id, index, done)
          throw new Error('toggle_action_item called without a toggleActionItem fixture')
        }
        case 'summarize_note':
          if (opts.summarizeNoteReject) throw opts.summarizeNoteReject
          return null
        case 'search_notes': {
          const { query } = args as { query: string }
          return opts.searchNotes ? opts.searchNotes(query) : []
        }
        case 'sys_audio_status':
          return { availability: opts.sysAudioAvailability ?? 'unsupported' }
        case 'request_sys_audio_permission':
          return { availability: opts.requestSysAudioPermissionResult ?? opts.sysAudioAvailability ?? 'unsupported' }
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}

async function loaded() {
  const { result } = renderHook(() => useAppState())
  await waitFor(() => expect(result.current.view).not.toBe('loading'))
  return result
}

describe('useAppState', () => {
  afterEach(() => vi.useRealTimers())

  it('starts in the loading view before the initial IPC calls resolve', () => {
    setupIPC()
    const { result } = renderHook(() => useAppState())
    expect(result.current.view).toBe('loading')
  })

  it('resolves to the notes view with real notes and models when an STT model is installed', async () => {
    setupIPC()
    const result = await loaded()
    expect(result.current.view).toBe('notes')
    expect(result.current.notes).toEqual([noteFixture()])
    expect(result.current.models).toHaveLength(2)
    expect(result.current.hardware).toEqual(hardware)
    expect(result.current.recommendation).toEqual(recommendation)
    expect(result.current.storage).toEqual(storage)
  })

  it('derives the onboarding view when no STT model is installed', async () => {
    setupIPC({ models: [sttModelFixture({ state: 'notInstalled' }), llmModelFixture()] })
    const result = await loaded()
    expect(result.current.view).toBe('onboarding')
  })

  it('falls back to the notes view (with a reported error) when the initial load rejects', async () => {
    setupIPC({ reject: true })
    const result = await loaded()
    expect(result.current.view).toBe('notes')
    expect(result.current.lastError).toContain('backend unavailable')
  })

  it('derives sidebarNotes via the adapter and a real stats line', async () => {
    setupIPC({ notes: [noteFixture(), noteFixture({ id: '2', title: 'Second' })] })
    const result = await loaded()
    expect(result.current.sidebarNotes).toHaveLength(2)
    expect(result.current.sidebarNotes[0].title).toBe('Client call — Acme')
    expect(result.current.statsLine).toBe('2 notes · 800 MB local · nothing synced')
  })

  it('handles an empty note library', async () => {
    setupIPC({ notes: [] })
    const result = await loaded()
    expect(result.current.notes).toEqual([])
    expect(result.current.sidebarNotes).toEqual([])
    expect(result.current.statsLine).toBe('0 notes · 800 MB local · nothing synced')
  })

  it('initializes sttModel to the recommendation when it is installed', async () => {
    setupIPC({ models: [sttModelFixture({ id: 'whisper-small', state: 'installed' })] })
    const result = await loaded()
    expect(result.current.sttModel).toBe('whisper-small')
  })

  it('setSttModel updates the local selection', async () => {
    setupIPC()
    const result = await loaded()
    act(() => result.current.setSttModel('whisper-medium'))
    expect(result.current.sttModel).toBe('whisper-medium')
  })

  it('completeOnboarding switches the view to notes', async () => {
    setupIPC({ models: [sttModelFixture({ state: 'notInstalled' })] })
    const result = await loaded()
    expect(result.current.view).toBe('onboarding')
    act(() => result.current.completeOnboarding(false))
    expect(result.current.view).toBe('notes')
  })

  it('goSettings / goNotes switch views', async () => {
    setupIPC()
    const result = await loaded()
    act(() => result.current.goSettings())
    expect(result.current.view).toBe('settings')
    act(() => result.current.goNotes())
    expect(result.current.view).toBe('notes')
  })

  it('selectNoteById updates sel/selectedNoteId to the matching note', async () => {
    const notes = [
      noteFixture({ id: 'note-0' }),
      noteFixture({ id: 'note-1' }),
      noteFixture({ id: 'note-2' }),
      noteFixture({ id: 'note-3' }),
    ]
    setupIPC({ notes })
    const result = await loaded()
    act(() => result.current.selectNoteById('note-3'))
    expect(result.current.sel).toBe(3)
    expect(result.current.selectedNoteId).toBe('note-3')
  })

  it('toggleDel flips local state', async () => {
    setupIPC()
    const result = await loaded()
    expect(result.current.tDel).toBe(true)
    act(() => result.current.toggleDel())
    expect(result.current.tDel).toBe(false)
  })

  it('initializes tDel from persisted settings rather than the hardcoded default', async () => {
    setupIPC({ settings: settingsFixture({ deleteAudioAfter30d: false }) })
    const result = await loaded()
    expect(result.current.tDel).toBe(false)
  })

  it('toggleDel persists the flipped value via set_settings', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    act(() => result.current.toggleDel())
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.deleteAudioAfter30d === false)).toBe(
      true,
    )
  })

  it('initializes tCompressAudioAfterDays from persisted settings, defaulting to null (off)', async () => {
    setupIPC({ settings: settingsFixture({ compressAudioAfterDays: 14 }) })
    const result = await loaded()
    expect(result.current.tCompressAudioAfterDays).toBe(14)
  })

  it('setCompressAudioAfterDays sets local state and persists the value via set_settings', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    act(() => result.current.setCompressAudioAfterDays(7))

    expect(result.current.tCompressAudioAfterDays).toBe(7)
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.compressAudioAfterDays === 7)).toBe(
      true,
    )
  })

  it('setCompressAudioAfterDays(null) sends the 0 sentinel to clear the override', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ settings: settingsFixture({ compressAudioAfterDays: 30 }), onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    act(() => result.current.setCompressAudioAfterDays(null))

    expect(result.current.tCompressAudioAfterDays).toBe(null)
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.compressAudioAfterDays === 0)).toBe(
      true,
    )
  })

  it('setSttModel/setLlmModel persist the selection via set_settings', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({
      models: [sttModelFixture({ state: 'installed' }), llmModelFixture({ state: 'installed' })],
      onCmd: (cmd, args) => calls.push({ cmd, args }),
    })
    const result = await loaded()

    act(() => result.current.setSttModel('whisper-medium'))
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.sttModel === 'whisper-medium')).toBe(
      true,
    )

    act(() => result.current.setLlmModel('gemma-4-e4b'))
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.llmModel === 'gemma-4-e4b')).toBe(
      true,
    )
  })

  it('completeOnboarding persists the recommended STT + LLM pair when both finished installing', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({
      models: [sttModelFixture({ id: 'whisper-small', state: 'installed' }), llmModelFixture({ id: 'qwen3.5-4b', state: 'installed' })],
      onCmd: (cmd, args) => calls.push({ cmd, args }),
    })
    const result = await loaded()

    act(() => result.current.completeOnboarding(false))

    expect(result.current.view).toBe('notes')
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.sttModel === 'whisper-small')).toBe(
      true,
    )
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.llmModel === 'qwen3.5-4b')).toBe(
      true,
    )
  })

  it('completeOnboarding does not persist an llmModel pick when the recommended LLM was not installed', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({
      models: [sttModelFixture({ id: 'whisper-small', state: 'installed' }), llmModelFixture({ id: 'qwen3.5-4b', state: 'notInstalled' })],
      onCmd: (cmd, args) => calls.push({ cmd, args }),
    })
    const result = await loaded()

    act(() => result.current.completeOnboarding(false))

    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.sttModel === 'whisper-small')).toBe(
      true,
    )
    expect(calls.some(c => c.cmd === 'set_settings' && 'llmModel' in (c.args as { patch: Partial<Settings> }).patch)).toBe(false)
  })

  it('toggleMeetingDetection flips local state and persists it via set_settings', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    expect(result.current.tMeetingDetection).toBe(false)
    act(() => result.current.toggleMeetingDetection())
    expect(result.current.tMeetingDetection).toBe(true)
    expect(
      calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.meetingDetection === true),
    ).toBe(true)
  })

  it('initializes tMeetingDetection from persisted settings rather than the hardcoded default', async () => {
    setupIPC({ settings: settingsFixture({ meetingDetection: true }) })
    const result = await loaded()
    expect(result.current.tMeetingDetection).toBe(true)
  })

  it('completeOnboarding(true) persists meetingDetection when the opt-in row was checked', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({
      models: [sttModelFixture({ id: 'whisper-small', state: 'notInstalled' })],
      onCmd: (cmd, args) => calls.push({ cmd, args }),
    })
    const result = await loaded()

    act(() => result.current.completeOnboarding(true))

    expect(result.current.view).toBe('notes')
    expect(result.current.tMeetingDetection).toBe(true)
    expect(
      calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.meetingDetection === true),
    ).toBe(true)
  })

  it('completeOnboarding(false) does not touch meetingDetection at all', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({
      models: [sttModelFixture({ id: 'whisper-small', state: 'notInstalled' })],
      onCmd: (cmd, args) => calls.push({ cmd, args }),
    })
    const result = await loaded()

    act(() => result.current.completeOnboarding(false))

    expect(result.current.tMeetingDetection).toBe(false)
    expect(
      calls.some(c => c.cmd === 'set_settings' && 'meetingDetection' in (c.args as { patch: Partial<Settings> }).patch),
    ).toBe(false)
  })

  // --- captureSystemAudio / sysAudioAvailability (Stage 5 Task 5) ---------

  it('initializes sysAudioAvailability from the initial sys_audio_status load', async () => {
    setupIPC({ sysAudioAvailability: 'ready' })
    const result = await loaded()
    expect(result.current.sysAudioAvailability).toBe('ready')
  })

  it('defaults sysAudioAvailability to unsupported when not otherwise specified', async () => {
    setupIPC()
    const result = await loaded()
    expect(result.current.sysAudioAvailability).toBe('unsupported')
  })

  it('initializes tCaptureSystemAudio from persisted settings rather than the hardcoded default', async () => {
    setupIPC({ settings: settingsFixture({ captureSystemAudio: true }) })
    const result = await loaded()
    expect(result.current.tCaptureSystemAudio).toBe(true)
  })

  it('toggleCaptureSystemAudio flips local state and persists it via set_settings', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    expect(result.current.tCaptureSystemAudio).toBe(false)
    act(() => result.current.toggleCaptureSystemAudio())
    expect(result.current.tCaptureSystemAudio).toBe(true)
    expect(
      calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.captureSystemAudio === true),
    ).toBe(true)
  })

  it('requestSysAudioPermission updates sysAudioAvailability with the resulting status', async () => {
    setupIPC({ sysAudioAvailability: 'notGranted', requestSysAudioPermissionResult: 'ready' })
    const result = await loaded()
    expect(result.current.sysAudioAvailability).toBe('notGranted')

    await act(async () => {
      result.current.requestSysAudioPermission()
    })
    await waitFor(() => expect(result.current.sysAudioAvailability).toBe('ready'))
  })

  it('requestSysAudioPermission reports an error and leaves sysAudioAvailability unchanged on rejection', async () => {
    setupIPC({
      sysAudioAvailability: 'notGranted',
      onCmd: cmd => {
        if (cmd === 'request_sys_audio_permission') throw new Error('permission check unavailable')
      },
    })
    const result = await loaded()

    await act(async () => {
      result.current.requestSysAudioPermission()
    })
    await waitFor(() => expect(result.current.lastError).toContain('permission check unavailable'))
    expect(result.current.sysAudioAvailability).toBe('notGranted')
  })

  describe('recording flow', () => {
    const noteId = '20260722-130000'

    function recordingState(overrides: Partial<RecordingStateEvent> = {}): RecordingStateEvent {
      return {
        noteId,
        state: 'recording',
        elapsed: 0,
        systemAudioActive: false,
        microphoneName: 'MacBook Pro Microphone',
        inputRms: 0.08,
        inputPeak: 0.4,
        inputSequence: 1,
        inputError: null,
        ...overrides,
      }
    }

    function segment(overrides: Partial<TranscriptSegmentEvent> = {}): TranscriptSegmentEvent {
      return { noteId, speaker: 'Speaker 1', start: 0, end: 1, text: 'hello', ...overrides }
    }

    function sttStatus(overrides: Partial<SttStatusEvent> = {}): SttStatusEvent {
      return { noteId, state: 'ready', error: null, ...overrides }
    }

    async function loadedAndRecording(opts: SetupOpts = {}) {
      setupIPC({ startRecordingId: noteId, ...opts })
      const result = await loaded()
      act(() => result.current.startRec())
      await waitFor(() => expect(result.current.view).toBe('recording'))
      return result
    }

    it('startRec invokes start_recording with the selected model and switches to the recording view', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      const result = await loadedAndRecording({ onCmd: (cmd, args) => calls.push({ cmd, args }) })

      expect(
        calls.some(
          c =>
            c.cmd === 'start_recording' &&
            (c.args as { modelId: string; includeSystemAudio: boolean }).modelId === 'whisper-small' &&
            (c.args as { modelId: string; includeSystemAudio: boolean }).includeSystemAudio === false,
        ),
      ).toBe(true)
      expect(result.current.recElapsed).toBe(0)
      expect(result.current.recTime).toBe('00:00')
      expect(result.current.liveSegments).toEqual([])
      expect(result.current.sttStatus).toBe('idle')
    })

    it('renames the active recording through the persisted note title', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      const result = await loadedAndRecording({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
      expect(result.current.recordingTitle).toBe('New recording')

      await act(async () => {
        await result.current.renameActiveRecording('Onboarding flow review')
      })

      expect(
        calls.some(
          call =>
            call.cmd === 'rename_note' &&
            (call.args as { id: string; title: string }).id === noteId &&
            (call.args as { id: string; title: string }).title === 'Onboarding flow review',
        ),
      ).toBe(true)
      expect(result.current.recordingTitle).toBe('Onboarding flow review')
    })

    it('opens the preflight and refreshes the real microphone list each time', async () => {
      setupIPC({ audioInputName: 'Studio Display Microphone' })
      const result = await loaded()

      act(() => result.current.openRecordingPreflight())
      expect(result.current.recordingPreflightOpen).toBe(true)
      await waitFor(() => expect(result.current.preflightMicrophoneLoading).toBe(false))
      expect(result.current.preflightMicrophoneDevices).toEqual([
        { id: 'default-input', name: 'Studio Display Microphone', isDefault: true },
      ])
      expect(result.current.selectedPreflightMicrophoneId).toBe('default-input')

      act(() => result.current.closeRecordingPreflight())
      expect(result.current.recordingPreflightOpen).toBe(false)
    })

    it('passes the chosen microphone id explicitly to start_recording', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        audioInputDevices: [
          { id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true },
          { id: 'studio', name: 'Studio Display Microphone', isDefault: false },
        ],
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })
      const result = await loaded()

      act(() => result.current.openRecordingPreflight())
      await waitFor(() => expect(result.current.preflightMicrophoneLoading).toBe(false))
      act(() => result.current.selectPreflightMicrophone('studio'))
      act(() => result.current.closeRecordingPreflight())
      act(() => result.current.openRecordingPreflight())
      await waitFor(() => expect(result.current.preflightMicrophoneLoading).toBe(false))
      expect(result.current.selectedPreflightMicrophoneId).toBe('studio')
      act(() => result.current.startRec())

      await waitFor(() => expect(result.current.view).toBe('recording'))
      expect(
        calls.some(
          call =>
            call.cmd === 'start_recording' &&
            (call.args as { inputDeviceId: string | null }).inputDeviceId === 'studio',
        ),
      ).toBe(true)
      expect(result.current.microphoneName).toBe('Studio Display Microphone')
    })

    it('passes an enabled, available system-audio choice explicitly to start_recording', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      await loadedAndRecording({
        settings: settingsFixture({ captureSystemAudio: true }),
        sysAudioAvailability: 'ready',
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })

      expect(
        calls.some(
          c =>
            c.cmd === 'start_recording' &&
            (c.args as { includeSystemAudio: boolean }).includeSystemAudio === true,
        ),
      ).toBe(true)
    })

    it('startRec rejecting reports lastError and stays off the recording view', async () => {
      setupIPC({ reject: true })
      const result = await loaded()

      act(() => result.current.startRec())
      await waitFor(() => expect(result.current.lastError).toContain('backend unavailable'))
      expect(result.current.view).not.toBe('recording')
    })

    it('isRecording is derived from backend truth (activeNoteId), not the current view — stays true after navigating to notes/settings mid-recording', async () => {
      const result = await loadedAndRecording()
      expect(result.current.isRecording).toBe(true)

      act(() => result.current.goSettings())
      expect(result.current.view).toBe('settings')
      expect(result.current.isRecording).toBe(true)

      act(() => result.current.goNotes())
      expect(result.current.view).toBe('notes')
      expect(result.current.isRecording).toBe(true)

      act(() => result.current.goRecording())
      expect(result.current.view).toBe('recording')
      expect(result.current.isRecording).toBe(true)
    })

    it('isRecording is false before starting and after stopping', async () => {
      setupIPC()
      const result = await loaded()
      expect(result.current.isRecording).toBe(false)

      act(() => result.current.startRec())
      await waitFor(() => expect(result.current.isRecording).toBe(true))

      act(() => result.current.stopRec())
      await waitFor(() => expect(result.current.view).toBe('notes'))
      expect(result.current.isRecording).toBe(false)
    })

    it('keeps accumulating transcript-segment events while navigated away to notes/settings, visible again after navigating back', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('transcript-segment', segment({ start: 0, end: 1, text: 'Hello there' }))
      })
      expect(result.current.liveSegments).toEqual([{ speaker: 'Speaker 1', start: 0, end: 1, text: 'Hello there' }])

      act(() => result.current.goSettings())
      expect(result.current.view).toBe('settings')

      await act(async () => {
        await emit('transcript-segment', segment({ start: 1, end: 2, text: 'how are you' }))
      })
      // The subscriptions are unconditional (not gated on view === 'recording'),
      // so events keep landing even while a different screen is on-screen.
      expect(result.current.liveSegments).toEqual([
        { speaker: 'Speaker 1', start: 0, end: 2, text: 'Hello there how are you' },
      ])

      act(() => result.current.goRecording())
      expect(result.current.view).toBe('recording')
      expect(result.current.liveSegments).toEqual([
        { speaker: 'Speaker 1', start: 0, end: 2, text: 'Hello there how are you' },
      ])
    })

    it('appends transcript-segment events, grouped, and filters out events for a different noteId', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('transcript-segment', segment({ start: 0, end: 1, text: 'Hello there' }))
        await emit('transcript-segment', segment({ start: 1, end: 2, text: 'how are you' }))
        await emit('transcript-segment', segment({ noteId: 'some-other-note', text: 'ignored' }))
      })

      expect(result.current.liveSegments).toEqual([
        { speaker: 'Speaker 1', start: 0, end: 2, text: 'Hello there how are you' },
      ])
    })

    it('recording-state events update recElapsed/recTime and drive paused from the state field', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('recording-state', recordingState({ state: 'recording', elapsed: 12.5 }))
      })
      expect(result.current.recElapsed).toBe(12.5)
      expect(result.current.recTime).toBe('00:12')
      expect(result.current.paused).toBe(false)

      await act(async () => {
        await emit('recording-state', recordingState({ state: 'paused', elapsed: 12.5 }))
      })
      expect(result.current.paused).toBe(true)
    })

    it('recording-state events for a different noteId are ignored', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('recording-state', recordingState({ noteId: 'some-other-note', elapsed: 99 }))
      })
      expect(result.current.recElapsed).toBe(0)
    })

    it('recording-state events drive systemAudioActive from the real, backend-confirmed field', async () => {
      const result = await loadedAndRecording()
      expect(result.current.systemAudioActive).toBe(false)

      await act(async () => {
        await emit('recording-state', recordingState({ state: 'recording', elapsed: 1, systemAudioActive: true }))
      })
      expect(result.current.systemAudioActive).toBe(true)
    })

    it('recording-state events expose the microphone opened by the backend', async () => {
      const result = await loadedAndRecording()
      expect(result.current.microphoneName).toBe('Default microphone')

      await act(async () => {
        await emit('recording-state', recordingState({ microphoneName: 'Studio Display Microphone' }))
      })
      expect(result.current.microphoneName).toBe('Studio Display Microphone')
    })

    it('recording-state telemetry escalates sustained silence and repeated clipping without stopping capture', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('recording-state', recordingState({ elapsed: 1, inputRms: 0, inputPeak: 0.2, inputSequence: 10 }))
        await emit('recording-state', recordingState({ elapsed: 11, inputRms: 0, inputPeak: 0.2, inputSequence: 11 }))
      })
      expect(result.current.captureHealth).toBe('silent')
      expect(result.current.isRecording).toBe(true)

      await act(async () => {
        await emit('recording-state', recordingState({ elapsed: 12, inputRms: 0.2, inputPeak: 0.99, inputSequence: 12 }))
        await emit('recording-state', recordingState({ elapsed: 13, inputRms: 0.2, inputPeak: 0.99, inputSequence: 13 }))
      })
      expect(result.current.captureHealth).toBe('clipping')
      expect(result.current.isRecording).toBe(true)
    })

    it('recording-state telemetry identifies a stream whose callback sequence stops moving', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('recording-state', recordingState({ elapsed: 1, inputSequence: 40 }))
        await emit('recording-state', recordingState({ elapsed: 2, inputSequence: 40 }))
        await emit('recording-state', recordingState({ elapsed: 3, inputSequence: 40 }))
        await emit('recording-state', recordingState({ elapsed: 4, inputSequence: 40 }))
      })
      expect(result.current.captureHealth).toBe('disconnected')
    })

    it('a systemAudioActive recording-state event for a different noteId is ignored', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('recording-state', recordingState({ noteId: 'some-other-note', systemAudioActive: true }))
      })
      expect(result.current.systemAudioActive).toBe(false)
    })

    it('resets systemAudioActive to false once a recording stops', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('recording-state', recordingState({ state: 'recording', elapsed: 1, systemAudioActive: true }))
      })
      expect(result.current.systemAudioActive).toBe(true)

      act(() => result.current.stopRec())
      await waitFor(() => expect(result.current.view).toBe('notes'))
      expect(result.current.systemAudioActive).toBe(false)
    })

    it('stt-status events update sttStatus/sttError for the active note', async () => {
      const result = await loadedAndRecording()

      await act(async () => {
        await emit('stt-status', sttStatus({ state: 'loading', error: null }))
      })
      expect(result.current.sttStatus).toBe('loading')

      await act(async () => {
        await emit('stt-status', sttStatus({ state: 'error', error: 'model not installed' }))
      })
      expect(result.current.sttStatus).toBe('error')
      expect(result.current.sttError).toBe('model not installed')
      expect(result.current.sttStatusNoteId).toBe(noteId)
    })

    it('togglePause optimistically flips paused and calls pause_recording, then resume_recording', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      const result = await loadedAndRecording({ onCmd: (cmd, args) => calls.push({ cmd, args }) })

      expect(result.current.paused).toBe(false)
      act(() => result.current.togglePause())
      expect(result.current.paused).toBe(true)
      await waitFor(() => expect(calls.some(c => c.cmd === 'pause_recording')).toBe(true))

      act(() => result.current.togglePause())
      expect(result.current.paused).toBe(false)
      await waitFor(() => expect(calls.some(c => c.cmd === 'resume_recording')).toBe(true))
    })

    it('togglePause ignores a re-entrant call while the previous pause/resume IPC call is still in flight', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      const result = await loadedAndRecording({ onCmd: (cmd, args) => calls.push({ cmd, args }) })

      // Two calls back to back, synchronously — the second must be a no-op
      // while the first's promise hasn't resolved yet (it hasn't: nothing
      // async has happened between the two calls).
      act(() => {
        result.current.togglePause()
        result.current.togglePause()
      })

      expect(result.current.paused).toBe(true)
      await waitFor(() => expect(calls.some(c => c.cmd === 'pause_recording')).toBe(true))
      expect(calls.filter(c => c.cmd === 'pause_recording' || c.cmd === 'resume_recording')).toHaveLength(1)
    })

    it('togglePause reconciles from the next recording-state event regardless of the optimistic flip', async () => {
      const result = await loadedAndRecording()

      act(() => result.current.togglePause())
      expect(result.current.paused).toBe(true)

      // The backend's own tick (or the pause/resume command's own emit) is
      // the source of truth — it wins even if it disagrees with the
      // optimistic flip (e.g. a command that failed server-side).
      await act(async () => {
        await emit('recording-state', recordingState({ state: 'recording', elapsed: 4 }))
      })
      expect(result.current.paused).toBe(false)
    })

    it('togglePause reports lastError when the backend call rejects', async () => {
      setupIPC({ startRecordingId: noteId, onCmd: (cmd) => {
        if (cmd === 'pause_recording') throw 'no active recording'
      } })
      const result = await loaded()
      act(() => result.current.startRec())
      await waitFor(() => expect(result.current.view).toBe('recording'))

      act(() => result.current.togglePause())
      await waitFor(() => expect(result.current.lastError).toContain('no active recording'))
    })

    it('persists a timestamped marker against the current recording time', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      const result = await loadedAndRecording({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
      await act(async () => {
        await emit('recording-state', recordingState({ elapsed: 74 }))
      })

      await act(async () => {
        await result.current.addRecordingMarker('Pricing decision')
      })

      expect(calls).toContainEqual({
        cmd: 'add_note_marker',
        args: { id: noteId, seconds: 74, label: 'Pricing decision' },
      })
      expect(result.current.recordingMarkers).toEqual([
        { seconds: 74, label: 'Pricing decision' },
      ])
    })

    it('stopRec sets stopping, then on success refreshes notes/storage, selects the new note, and returns to notes', async () => {
      const newNote = noteFixture({ id: noteId, title: 'New recording' })
      const otherNote = noteFixture({ id: 'older-note', title: 'Older note' })
      const result = await loadedAndRecording({
        notes: [newNote, otherNote],
        stopRecording: { result: newNote },
      })

      act(() => result.current.stopRec())
      expect(result.current.stopping).toBe(true)

      await waitFor(() => expect(result.current.view).toBe('notes'))
      expect(result.current.stopping).toBe(false)
      expect(result.current.notes).toEqual([newNote, otherNote])
      expect(result.current.sel).toBe(0)
      expect(result.current.liveSegments).toEqual([])
      expect(result.current.processingStage).toBe('idle')
      expect(result.current.noteTab).toBe('overview')
      expect(result.current.processingFailure).toBeNull()
    })

    it('stopRec exposes saving and finalizing phases before preparing the completed note', async () => {
      let releaseStop!: () => void
      const wait = new Promise<void>(resolve => {
        releaseStop = resolve
      })
      const newNote = noteFixture({ id: noteId, title: 'New recording' })
      const result = await loadedAndRecording({
        notes: [newNote],
        stopRecording: { result: newNote, wait },
      })

      act(() => result.current.stopRec())
      expect(result.current.processingStage).toBe('saving')

      await act(async () => {
        await emit('stt-status', sttStatus({ state: 'finalizing' }))
      })
      expect(result.current.processingStage).toBe('finalizing')

      await act(async () => {
        releaseStop()
      })
      await waitFor(() => expect(result.current.view).toBe('notes'))
      expect(result.current.processingStage).toBe('idle')
    })

    it('stopRec selects the correct index when the new note is not first in the refreshed list', async () => {
      const newNote = noteFixture({ id: noteId, title: 'New recording' })
      const olderNote = noteFixture({ id: 'older-note', title: 'Older note' })
      const result = await loadedAndRecording({
        notes: [olderNote, newNote],
        stopRecording: { result: newNote },
      })

      act(() => result.current.stopRec())
      await waitFor(() => expect(result.current.view).toBe('notes'))
      expect(result.current.sel).toBe(1)
    })

    it('stopRec rejecting reports lastError, clears stopping, and stays on the recording view', async () => {
      const result = await loadedAndRecording({ stopRecording: { reject: 'wav writer thread panicked' } })

      act(() => result.current.stopRec())
      expect(result.current.stopping).toBe(true)

      await waitFor(() => expect(result.current.lastError).toContain('wav writer thread panicked'))
      expect(result.current.stopping).toBe(false)
      expect(result.current.view).toBe('recording')
      expect(result.current.processingFailure).toEqual({
        stage: 'saving',
        message: 'wav writer thread panicked',
      })
    })

    it('stopRec: when stop_recording succeeds but the post-stop list_notes/storage_stats refresh rejects, still clears sttStatus and navigates to notes (stale list) instead of getting stuck on the recording view', async () => {
      const newNote = noteFixture({ id: noteId, title: 'New recording' })
      const result = await loadedAndRecording({
        notes: [newNote],
        stopRecording: { result: newNote },
        postStopRefreshRejects: true,
      })

      await act(async () => {
        await emit('stt-status', sttStatus({ state: 'finalizing' }))
      })
      expect(result.current.sttStatus).toBe('finalizing')

      act(() => result.current.stopRec())
      expect(result.current.stopping).toBe(true)

      await waitFor(() => expect(result.current.view).toBe('notes'))
      expect(result.current.stopping).toBe(false)
      expect(result.current.lastError).toContain('list_notes unavailable')
      // The refresh never landed — `notes` stays whatever it was before
      // (stale, but present) rather than being wiped out.
      expect(result.current.notes).toEqual([newNote])
      expect(result.current.sttStatus).toBe('idle')
      expect(result.current.sttError).toBeNull()
      expect(result.current.sttStatusNoteId).toBeNull()
      expect(result.current.processingFailure).toEqual({
        stage: 'preparing',
        message: 'Error: list_notes unavailable',
      })
    })
  })

  describe('meeting-popup-start event', () => {
    it('re-runs the normal startRec flow when an STT model is installed', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        models: [sttModelFixture({ id: 'whisper-small', state: 'installed' })],
        startRecordingId: '20260722-140000',
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })
      const result = await loaded()
      expect(result.current.view).toBe('notes')

      await act(async () => {
        await emit('meeting-popup-start', null)
      })

      await waitFor(() => expect(result.current.view).toBe('recording'))
      expect(calls.some(c => c.cmd === 'start_recording' && (c.args as { modelId: string }).modelId === 'whisper-small')).toBe(true)
    })

    it('navigates to onboarding with an honest error instead of recording when no STT model is installed (and the view is not already onboarding)', async () => {
      // No STT installed would normally already land (and stay) on
      // 'onboarding' via the initial-load gate — which the guard below
      // ignores meeting-popup-start on for a *different* reason (there's
      // nothing useful to do, the user is already exactly where they need
      // to be). To exercise this branch's own logic (the actual "no model
      // -> navigate + honest error" behavior) independent of that guard,
      // this moves off onboarding first via `completeOnboarding` — the same
      // "Start using Minute" bypass a real user could trigger without
      // actually finishing model setup, landing on 'notes' with no STT
      // model installed regardless.
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        models: [sttModelFixture({ id: 'whisper-small', state: 'notInstalled' })],
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })
      const result = await loaded()
      expect(result.current.view).toBe('onboarding')
      act(() => result.current.completeOnboarding(false))
      expect(result.current.view).toBe('notes')

      await act(async () => {
        await emit('meeting-popup-start', null)
      })

      expect(result.current.view).toBe('onboarding')
      expect(result.current.lastError).toContain('Install a transcription model')
      expect(calls.some(c => c.cmd === 'start_recording')).toBe(false)
    })

    it('ignores meeting-popup-start entirely while already viewing onboarding (nothing useful to do there)', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        models: [sttModelFixture({ id: 'whisper-small', state: 'notInstalled' })],
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })
      const result = await loaded()
      expect(result.current.view).toBe('onboarding')

      await act(async () => {
        await emit('meeting-popup-start', null)
      })

      expect(result.current.view).toBe('onboarding')
      expect(result.current.lastError).toBeNull()
      expect(calls.some(c => c.cmd === 'start_recording')).toBe(false)
    })

    it('ignores meeting-popup-start while a recording is already active, without an error toast', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        models: [sttModelFixture({ id: 'whisper-small', state: 'installed' })],
        startRecordingId: '20260722-150000',
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })
      const result = await loaded()
      act(() => result.current.startRec())
      await waitFor(() => expect(result.current.view).toBe('recording'))
      expect(result.current.isRecording).toBe(true)
      const startRecordingCallsBefore = calls.filter(c => c.cmd === 'start_recording').length

      await act(async () => {
        await emit('meeting-popup-start', null)
      })

      // Still exactly the one active recording, no *second*
      // start_recording call, and no confusing "already recording" error
      // toast surfaced to the user (the backend would have rejected a
      // second start_recording with exactly that message).
      expect(result.current.view).toBe('recording')
      expect(calls.filter(c => c.cmd === 'start_recording')).toHaveLength(startRecordingCallsBefore)
      expect(result.current.lastError).toBeNull()
    })
  })

  describe('note detail (real transcript loading)', () => {
    const noteA = noteFixture({ id: 'note-a', title: 'Note A' })
    const noteB = noteFixture({ id: 'note-b', title: 'Note B' })
    const segmentsA: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 1, text: 'hello from A' }]
    const segmentsB: StoredSegment[] = [{ speaker: 'Speaker 1', start: 5, end: 6, text: 'hello from B' }]

    function getNoteFixture(id: string): NoteWithTranscript {
      if (id === 'note-a') return { meta: noteA, transcript: { segments: segmentsA }, summary: null, markdown: '', audioPath: null }
      if (id === 'note-b') return { meta: noteB, transcript: { segments: segmentsB }, summary: null, markdown: '', audioPath: null }
      throw new Error(`unexpected id ${id}`)
    }

    it('fetches get_note for the initially selected note and exposes selectedMeta/selectedTranscript', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA, noteB], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })

      const result = await loaded()

      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))
      expect(result.current.selectedTranscript).toEqual(segmentsA)
      expect(calls.some(c => c.cmd === 'get_note' && (c.args as { id: string }).id === 'note-a')).toBe(true)
    })

    it('sets transcriptLoading true while the fetch is in flight, then false once it resolves', async () => {
      let resolveGetNote: (v: NoteWithTranscript) => void = () => {}
      const pending = new Promise<NoteWithTranscript>(resolve => {
        resolveGetNote = resolve
      })
      setupIPC({ notes: [noteA], getNote: () => pending })

      const result = await loaded()
      expect(result.current.transcriptLoading).toBe(true)

      await act(async () => {
        resolveGetNote(getNoteFixture('note-a'))
        await pending
      })
      await waitFor(() => expect(result.current.transcriptLoading).toBe(false))
      expect(result.current.selectedTranscript).toEqual(segmentsA)
    })

    it('fetches a fresh transcript when a different note is selected', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA, noteB], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })

      const result = await loaded()
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))

      act(() => result.current.selectNoteById('note-b'))
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteB))
      expect(result.current.selectedTranscript).toEqual(segmentsB)
      expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(2)
    })

    it('an out-of-order get_note response for an abandoned note selection does not clobber the newer note’s audioPath', async () => {
      // note-a's fetch (kicked off by the initial selection) is still
      // in flight when the user switches to note-b; note-b's fetch resolves
      // first, then note-a's stale one resolves late — it must not overwrite
      // what's now on screen for note-b (selectedAudioPath in particular —
      // the requestId guard this pins covers every selected* field, but
      // audioPath is the one that motivated this test).
      let resolveA: (v: NoteWithTranscript) => void = () => {}
      const pendingA = new Promise<NoteWithTranscript>(resolve => {
        resolveA = resolve
      })
      let resolveB: (v: NoteWithTranscript) => void = () => {}
      const pendingB = new Promise<NoteWithTranscript>(resolve => {
        resolveB = resolve
      })
      setupIPC({
        notes: [noteA, noteB],
        getNote: (id: string) => (id === 'note-a' ? pendingA : pendingB),
      })

      const result = await loaded()
      expect(result.current.transcriptLoading).toBe(true) // note-a's fetch is in flight

      act(() => result.current.selectNoteById('note-b')) // switch to note-b before note-a resolves

      await act(async () => {
        resolveB({
          meta: noteB,
          transcript: { segments: segmentsB },
          summary: null,
          markdown: '',
          audioPath: '/notes/note-b/audio.wav',
        })
        await pendingB
      })
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteB))
      expect(result.current.selectedAudioPath).toBe('/notes/note-b/audio.wav')

      // note-a's stale response finally arrives — must be a no-op for what's displayed.
      await act(async () => {
        resolveA({
          meta: noteA,
          transcript: { segments: segmentsA },
          summary: null,
          markdown: '',
          audioPath: '/notes/note-a/audio.wav',
        })
        await pendingA
      })

      expect(result.current.selectedMeta).toEqual(noteB)
      expect(result.current.selectedAudioPath).toBe('/notes/note-b/audio.wav')
    })

    it('reuses the cache instead of refetching when switching back to an already-loaded note', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA, noteB], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })

      const result = await loaded()
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))

      act(() => result.current.selectNoteById('note-b'))
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteB))

      act(() => result.current.selectNoteById('note-a'))
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))

      expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(2)
    })

    it('reports lastError when get_note rejects', async () => {
      setupIPC({
        notes: [noteA],
        getNote: () => {
          throw new Error('disk read failed')
        },
      })
      const result = await loaded()
      await waitFor(() => expect(result.current.lastError).toContain('disk read failed'))
      expect(result.current.transcriptLoading).toBe(false)
    })

    describe('renameNote', () => {
      it('invokes rename_note, refreshes notes, and force-reloads the transcript for the (still-selected) renamed note', async () => {
        // `currentTitle` simulates the backend's on-disk state so that
        // `get_note`'s post-rename refetch (and the `list_notes` refresh)
        // actually reflect the rename, the same way real disk-backed
        // `get_note`/`list_notes` calls would after a real `rename_note`.
        let currentTitle = noteA.title
        const calls: Array<{ cmd: string; args: unknown }> = []
        setupIPC({
          notes: [noteA],
          getNote: () => ({
            meta: { ...noteA, title: currentTitle },
            transcript: { segments: segmentsA },
            summary: null,
            markdown: '',
            audioPath: null,
          }),
          renameNoteResult: (_id, title) => {
            currentTitle = title
            return { ...noteA, title }
          },
          listNotesAfter: () => [{ ...noteA, title: currentTitle }],
          onCmd: (cmd, args) => calls.push({ cmd, args }),
        })

        const result = await loaded()
        await waitFor(() => expect(result.current.selectedMeta?.title).toBe('Note A'))

        act(() => result.current.renameNote('note-a', 'Renamed A'))

        expect(calls.some(c => c.cmd === 'rename_note' && (c.args as { id: string; title: string }).id === 'note-a')).toBe(true)
        await waitFor(() => expect(result.current.notes).toEqual([{ ...noteA, title: 'Renamed A' }]))
        await waitFor(() => expect(result.current.selectedMeta?.title).toBe('Renamed A'))
      })

      it('reports lastError when rename_note rejects', async () => {
        setupIPC({
          notes: [noteA],
          getNote: getNoteFixture,
          onCmd: cmd => {
            if (cmd === 'rename_note') throw 'note not found'
          },
        })
        const result = await loaded()
        act(() => result.current.renameNote('note-a', 'New title'))
        await waitFor(() => expect(result.current.lastError).toContain('note not found'))
      })
    })

    it('updates a note’s pinned state from the backend response', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })
      const result = await loaded()

      act(() => result.current.setNotePinned('note-a', true))

      await waitFor(() => expect(result.current.notes[0].pinned).toBe(true))
      expect(calls).toContainEqual({
        cmd: 'set_note_pinned',
        args: { id: 'note-a', pinned: true },
      })
    })

    it('adds a marker to a completed note and refreshes selected detail', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })
      const result = await loaded()
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))
      const initialGetCalls = calls.filter(call => call.cmd === 'get_note').length

      await act(async () => {
        await result.current.addNoteMarker('note-a', 94, 'Pricing decision')
      })

      expect(calls).toContainEqual({
        cmd: 'add_note_marker',
        args: { id: 'note-a', seconds: 94, label: 'Pricing decision' },
      })
      expect(result.current.notes[0].markers).toEqual([{ seconds: 94, label: 'Pricing decision' }])
      expect(calls.filter(call => call.cmd === 'get_note')).toHaveLength(initialGetCalls + 1)
    })

    it('renames a speaker and force-refreshes the selected transcript', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })
      const result = await loaded()
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))
      const initialGetCalls = calls.filter(call => call.cmd === 'get_note').length

      act(() => result.current.renameSpeaker('note-a', 'Speaker 1', 'Sam'))

      await waitFor(() => expect(calls.filter(call => call.cmd === 'get_note')).toHaveLength(initialGetCalls + 1))
      expect(calls).toContainEqual({
        cmd: 'rename_speaker',
        args: { id: 'note-a', from: 'Speaker 1', to: 'Sam' },
      })
    })

    it('merges speakers, updates note metadata, and reverses with the exact undo token', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes: [noteA], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })
      const result = await loaded()
      await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))

      let undo!: Awaited<ReturnType<typeof result.current.mergeSpeakers>>
      await act(async () => {
        undo = await result.current.mergeSpeakers('note-a', 'Speaker 1', 'Speaker 2')
      })

      expect(undo).toEqual({
        from: 'Speaker 1',
        into: 'Speaker 2',
        segmentIndices: [0],
        checksum: 'merge-checksum',
      })
      expect(result.current.notes[0].speakers).toBe(noteA.speakers - 1)
      expect(calls).toContainEqual({
        cmd: 'merge_speakers',
        args: { id: 'note-a', from: 'Speaker 1', into: 'Speaker 2' },
      })

      await act(async () => {
        await result.current.undoSpeakerMerge('note-a', undo)
      })
      expect(result.current.notes[0].speakers).toBe(noteA.speakers)
      expect(calls).toContainEqual({
        cmd: 'undo_speaker_merge',
        args: { id: 'note-a', undo },
      })
    })

    describe('deleteNote', () => {
      it('invokes delete_note, refreshes notes, and keeps the same index (selecting the next note)', async () => {
        const calls: Array<{ cmd: string; args: unknown }> = []
        setupIPC({
          notes: [noteA, noteB],
          getNote: getNoteFixture,
          listNotesAfter: () => [noteB],
          onCmd: (cmd, args) => calls.push({ cmd, args }),
        })

        const result = await loaded()
        await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))

        act(() => result.current.deleteNote('note-a'))

        expect(calls.some(c => c.cmd === 'delete_note' && (c.args as { id: string }).id === 'note-a')).toBe(true)
        await waitFor(() => expect(result.current.notes).toEqual([noteB]))
        expect(result.current.sel).toBe(0)
        expect(result.current.deletedNoteUndo).toEqual([
          {
            id: 'note-a',
            title: noteA.title,
            trashName: 'note-a-trash',
            checksum: 'recovery-checksum',
          },
        ])
      })

      it('clamps the selection index when the deleted note was last in the list', async () => {
        setupIPC({
          notes: [noteA, noteB],
          getNote: getNoteFixture,
          listNotesAfter: () => [noteA],
        })
        const result = await loaded()
        act(() => result.current.selectNoteById('note-b'))
        await waitFor(() => expect(result.current.selectedMeta).toEqual(noteB))

        act(() => result.current.deleteNote('note-b'))
        await waitFor(() => expect(result.current.notes).toEqual([noteA]))
        expect(result.current.sel).toBe(0)
      })

      it('clamps to 0 when deleting the last remaining note (empty library)', async () => {
        setupIPC({
          notes: [noteA],
          getNote: getNoteFixture,
          listNotesAfter: () => [],
        })
        const result = await loaded()
        act(() => result.current.deleteNote('note-a'))
        await waitFor(() => expect(result.current.notes).toEqual([]))
        expect(result.current.sel).toBe(0)
      })

      it('reports lastError when delete_note rejects', async () => {
        setupIPC({
          notes: [noteA],
          getNote: getNoteFixture,
          onCmd: cmd => {
            if (cmd === 'delete_note') throw 'note not found'
          },
        })
        const result = await loaded()
        act(() => result.current.deleteNote('note-a'))
        await waitFor(() => expect(result.current.lastError).toContain('note not found'))
      })

      it('prunes the deleted note\'s summarization/ask state (summaryStatus/summaryError/askHistory/askStatus) without touching another note or llmBusy', async () => {
        setupIPC({
          notes: [noteA, noteB],
          getNote: getNoteFixture,
          listNotesAfter: () => [noteB],
        })
        const result = await loaded()
        await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))

        await act(async () => {
          await emit('summary-status', { noteId: 'note-a', state: 'error', error: 'boom' })
        })
        await act(async () => {
          await emit('ask-answer', { noteId: 'note-a', question: 'Q for A', answer: 'A for A' })
        })
        // note-b's own state must survive note-a's deletion untouched, and
        // keep llmBusy true throughout.
        await act(async () => {
          await emit('summary-status', { noteId: 'note-b', state: 'running', error: null })
        })

        expect(result.current.summaryStatus['note-a']).toBe('error')
        expect(result.current.summaryError['note-a']).toBe('boom')
        expect(result.current.askHistory).toHaveLength(1)

        act(() => result.current.deleteNote('note-a'))
        await waitFor(() => expect(result.current.notes).toEqual([noteB]))

        expect(result.current.summaryStatus['note-a']).toBeUndefined()
        expect(result.current.summaryError['note-a']).toBeUndefined()
        expect(result.current.summaryStatus['note-b']).toBe('running')
        expect(result.current.llmBusy).toBe(true)
      })
    })

    describe('revealNote', () => {
      it('invokes reveal_note with the given id', async () => {
        const calls: Array<{ cmd: string; args: unknown }> = []
        setupIPC({ notes: [noteA], getNote: getNoteFixture, onCmd: (cmd, args) => calls.push({ cmd, args }) })
        const result = await loaded()

        act(() => result.current.revealNote('note-a'))

        expect(calls.some(c => c.cmd === 'reveal_note' && (c.args as { id: string }).id === 'note-a')).toBe(true)
      })

      it('reports lastError when reveal_note rejects', async () => {
        setupIPC({
          notes: [noteA],
          getNote: getNoteFixture,
          onCmd: cmd => {
            if (cmd === 'reveal_note') throw 'no such file'
          },
        })
        const result = await loaded()
        act(() => result.current.revealNote('note-a'))
        await waitFor(() => expect(result.current.lastError).toContain('no such file'))
      })
    })
  })

  describe('summarization', () => {
    const noteA = noteFixture({ id: 'note-a', title: 'Note A' })
    const segmentsA: StoredSegment[] = [{ speaker: 'Speaker 1', start: 0, end: 1, text: 'hello from A' }]
    const noteSummary: SummaryDoc = {
      summary: 'Discussed Q3 roadmap.',
      topics: [],
      decisions: ['Ship by Friday'],
      actionItems: [{ text: 'Write release notes', done: false }],
    }

    function summaryStatusEvent(overrides: Partial<SummaryStatusEvent> = {}): SummaryStatusEvent {
      return { noteId: 'note-a', state: 'running', error: null, ...overrides }
    }

    describe('summary-status event flow', () => {
      it('running then done invalidates the cache, refetches the selected note, and refreshes the notes list (status ready)', async () => {
        let summarized = false
        const readyNote: NoteMeta = { ...noteA, status: 'ready' }
        const calls: Array<{ cmd: string; args: unknown }> = []
        setupIPC({
          notes: [noteA],
          getNote: () => ({
            meta: summarized ? readyNote : noteA,
            transcript: { segments: segmentsA },
            summary: summarized ? noteSummary : null,
            markdown: summarized ? '# with summary' : '# no summary',
            audioPath: null,
          }),
          listNotesAfter: () => [readyNote],
          onCmd: (cmd, args) => calls.push({ cmd, args }),
        })

        const result = await loaded()
        await waitFor(() => expect(result.current.selectedMeta).toEqual(noteA))
        expect(result.current.selectedSummary).toBeNull()

        await act(async () => {
          await emit('summary-status', summaryStatusEvent({ state: 'running' }))
        })
        expect(result.current.summaryStatus['note-a']).toBe('running')

        summarized = true
        await act(async () => {
          await emit('summary-status', summaryStatusEvent({ state: 'done' }))
        })

        await waitFor(() => expect(result.current.selectedSummary).toEqual(noteSummary))
        expect(result.current.summaryStatus['note-a']).toBe('done')
        expect(result.current.notes).toEqual([readyNote])
        expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(2)
      })

      it('error sets summaryStatus/summaryError for that note only, without touching another note', async () => {
        setupIPC({ notes: [noteA] })
        const result = await loaded()

        await act(async () => {
          await emit('summary-status', summaryStatusEvent({ state: 'error', error: 'no summary model installed' }))
        })

        expect(result.current.summaryStatus['note-a']).toBe('error')
        expect(result.current.summaryError['note-a']).toBe('no summary model installed')
        expect(result.current.summaryStatus['note-b']).toBeUndefined()
        expect(result.current.summaryError['note-b']).toBeUndefined()
      })

      it('falls back to a generic message when an error event carries none', async () => {
        setupIPC({ notes: [noteA] })
        const result = await loaded()

        await act(async () => {
          await emit('summary-status', summaryStatusEvent({ state: 'error', error: null }))
        })

        expect(result.current.summaryError['note-a']).toBe('Summarization failed')
      })

      it('a later running/done event clears a previously recorded error for the same note', async () => {
        setupIPC({ notes: [noteA] })
        const result = await loaded()

        await act(async () => {
          await emit('summary-status', summaryStatusEvent({ state: 'error', error: 'boom' }))
        })
        expect(result.current.summaryError['note-a']).toBe('boom')

        await act(async () => {
          await emit('summary-status', summaryStatusEvent({ state: 'running' }))
        })
        expect(result.current.summaryError['note-a']).toBeUndefined()
        expect(result.current.summaryStatus['note-a']).toBe('running')
      })
    })

    describe('regenerateSummary', () => {
      it('invokes summarize_note with the given id', async () => {
        const calls: Array<{ cmd: string; args: unknown }> = []
        setupIPC({ notes: [noteA], onCmd: (cmd, args) => calls.push({ cmd, args }) })
        const result = await loaded()

        act(() => result.current.regenerateSummary('note-a'))

        expect(calls.some(c => c.cmd === 'summarize_note' && (c.args as { id: string }).id === 'note-a')).toBe(true)
      })

      it('sets per-note summaryStatus/summaryError when summarize_note rejects synchronously (e.g. already busy)', async () => {
        setupIPC({ notes: [noteA], summarizeNoteReject: 'summarization already running' })
        const result = await loaded()

        act(() => result.current.regenerateSummary('note-a'))

        await waitFor(() => expect(result.current.summaryStatus['note-a']).toBe('error'))
        expect(result.current.summaryError['note-a']).toBe('summarization already running')
      })
    })

    describe('toggleActionItem', () => {
      function summaryFixture(overrides: Partial<SummaryDoc> = {}): NoteWithTranscript {
        return {
          meta: noteA,
          transcript: { segments: segmentsA },
          summary: { summary: 'x', topics: [], decisions: [], actionItems: [{ text: 'Write release notes', done: false }], ...overrides },
          markdown: '# note',
          audioPath: null,
        }
      }

      it('optimistically flips the action item, calls toggle_action_item, then refetches the note', async () => {
        const calls: Array<{ cmd: string; args: unknown }> = []
        let resolveToggle: (v: SummaryDoc) => void = () => {}
        const pending = new Promise<SummaryDoc>(resolve => {
          resolveToggle = resolve
        })
        setupIPC({
          notes: [noteA],
          getNote: () => summaryFixture(),
          toggleActionItem: () => pending,
          onCmd: (cmd, args) => calls.push({ cmd, args }),
        })

        const result = await loaded()
        await waitFor(() => expect(result.current.selectedSummary?.actionItems[0].done).toBe(false))

        act(() => result.current.toggleActionItem('note-a', 0, true))

        // Optimistic: flips immediately, before the IPC call has resolved.
        expect(result.current.selectedSummary?.actionItems[0].done).toBe(true)
        expect(
          calls.some(
            c =>
              c.cmd === 'toggle_action_item' &&
              (c.args as { id: string; index: number; done: boolean }).id === 'note-a' &&
              (c.args as { id: string; index: number; done: boolean }).index === 0 &&
              (c.args as { id: string; index: number; done: boolean }).done === true,
          ),
        ).toBe(true)

        await act(async () => {
          resolveToggle({ summary: 'x', topics: [], decisions: [], actionItems: [{ text: 'Write release notes', done: true }] })
          await pending
        })

        // A confirmed toggle re-fetches the note (rather than trusting the
        // command's bare SummaryDoc response) so the Markdown tab's
        // checkbox stays in sync with the backend's re-rendered note.md.
        await waitFor(() => expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(2))
      })

      it('reverts the optimistic flip and reports lastError when toggle_action_item rejects', async () => {
        setupIPC({
          notes: [noteA],
          getNote: () => summaryFixture(),
          toggleActionItemReject: 'note note-a has no summary yet',
        })

        const result = await loaded()
        await waitFor(() => expect(result.current.selectedSummary?.actionItems[0].done).toBe(false))

        act(() => result.current.toggleActionItem('note-a', 0, true))
        expect(result.current.selectedSummary?.actionItems[0].done).toBe(true)

        await waitFor(() => expect(result.current.lastError).toContain('note note-a has no summary yet'))
        expect(result.current.selectedSummary?.actionItems[0].done).toBe(false)
      })

      it('rapid A-then-B: when B succeeds and A later fails, the scoped revert only undoes A — B\'s confirmed change survives', async () => {
        let rejectA: (e: unknown) => void = () => {}
        const pendingA = new Promise<SummaryDoc>((_resolve, reject) => {
          rejectA = reject
        })
        let resolveB: (v: SummaryDoc) => void = () => {}
        const pendingB = new Promise<SummaryDoc>(resolve => {
          resolveB = resolve
        })

        let getNoteCalls = 0
        setupIPC({
          notes: [noteA],
          getNote: () => {
            getNoteCalls += 1
            // Call 1: initial load — nothing toggled yet. Call 2+: the
            // forced refetch B's confirmed toggle triggers — backend truth
            // at that point is "B landed, A did not" (A's command hasn't
            // resolved server-side by the time this refetch runs).
            const actionItems =
              getNoteCalls === 1
                ? [{ text: 'Item A', done: false }, { text: 'Item B', done: false }]
                : [{ text: 'Item A', done: false }, { text: 'Item B', done: true }]
            return {
              meta: noteA,
              transcript: { segments: segmentsA },
              summary: { summary: 'x', topics: [], decisions: [], actionItems },
              markdown: '# note',
              audioPath: null,
            }
          },
          toggleActionItem: (_id, index) => (index === 0 ? pendingA : pendingB),
        })

        const result = await loaded()
        await waitFor(() => expect(result.current.selectedSummary?.actionItems).toHaveLength(2))

        // A: toggles index 0 — stays pending (not yet resolved/rejected).
        act(() => result.current.toggleActionItem('note-a', 0, true))
        expect(result.current.selectedSummary?.actionItems[0].done).toBe(true)

        // B: toggles index 1 — also stays pending, layered on top of A's
        // still-in-flight optimistic edit.
        act(() => result.current.toggleActionItem('note-a', 1, true))
        expect(result.current.selectedSummary?.actionItems[1].done).toBe(true)

        // B resolves first: confirmed, triggers a forced refetch.
        await act(async () => {
          resolveB({ summary: 'x', topics: [], decisions: [], actionItems: [{ text: 'Item A', done: false }, { text: 'Item B', done: true }] })
          await pendingB
        })
        await waitFor(() => expect(getNoteCalls).toBeGreaterThanOrEqual(2))
        await waitFor(() => expect(result.current.selectedSummary?.actionItems[1].done).toBe(true))

        // A now fails.
        await act(async () => {
          rejectA('note note-a has no summary yet')
          await pendingA.catch(() => {})
        })
        await waitFor(() => expect(result.current.lastError).toContain('note note-a has no summary yet'))

        // B's confirmed change must survive A's revert — the bug this test
        // guards against: an old, full-document-snapshot revert (captured
        // before B ever ran) would clobber it back to `false`.
        expect(result.current.selectedSummary?.actionItems[1].done).toBe(true)
        // A's own toggle is still reverted.
        expect(result.current.selectedSummary?.actionItems[0].done).toBe(false)
      })
    })
  })

  describe('transcript cache LRU (cap 20)', () => {
    it('evicts the oldest note once a 21st distinct note is viewed, but keeps recently viewed notes cached', async () => {
      const manyNotes = Array.from({ length: 21 }, (_, i) => noteFixture({ id: `note-${i}`, title: `Note ${i}` }))
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        notes: manyNotes,
        getNote: id => ({
          meta: manyNotes.find(n => n.id === id) as NoteMeta,
          transcript: { segments: [] },
          summary: null,
          markdown: '',
          audioPath: null,
        }),
        onCmd: (cmd, args) => calls.push({ cmd, args }),
      })

      const result = await loaded()
      await waitFor(() => expect(result.current.selectedMeta?.id).toBe('note-0'))

      // Select every other note in order: 21 distinct notes viewed in total
      // (note-0 from the initial selection, plus note-1..note-20 here).
      for (let i = 1; i < 21; i++) {
        act(() => result.current.selectNoteById(`note-${i}`))
        // eslint-disable-next-line no-await-in-loop
        await waitFor(() => expect(result.current.selectedMeta?.id).toBe(`note-${i}`))
      }
      expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(21)

      // note-0 was the oldest entry and is now past the 20-entry cap —
      // reselecting it must refetch rather than serve from cache.
      act(() => result.current.selectNoteById('note-0'))
      await waitFor(() => expect(result.current.selectedMeta?.id).toBe('note-0'))
      expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(22)

      // note-20 (recently viewed, well within the cap) must still be served
      // from cache — no extra fetch.
      act(() => result.current.selectNoteById('note-20'))
      await waitFor(() => expect(result.current.selectedMeta?.id).toBe('note-20'))
      expect(calls.filter(c => c.cmd === 'get_note')).toHaveLength(22)
    })
  })

  // Model-manager internals (download progress/done events, cancel, plain
  // delete-then-refetch, transient error timing) are unit-tested directly
  // in useModelManager.test.ts. These are kept here as end-to-end wiring
  // smoke tests through the real composed useAppState surface, plus the
  // re-gate scenarios the coordinator asked to verify at this level too.
  it('downloadModel invokes download_model and optimistically marks the model as downloading', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    act(() => result.current.downloadModel('whisper-small'))
    expect(calls.some(c => c.cmd === 'download_model' && (c.args as { id: string }).id === 'whisper-small')).toBe(true)
    expect(result.current.downloads['whisper-small']).toEqual({ downloaded: 0, total: 466_000_000 })
  })

  it('deleteModel invokes delete_model then refetches list_models', async () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
    const result = await loaded()

    act(() => result.current.deleteModel('whisper-small'))
    await waitFor(() => expect(calls.filter(c => c.cmd === 'list_models')).toHaveLength(2))
    expect(calls.some(c => c.cmd === 'delete_model' && (c.args as { id: string }).id === 'whisper-small')).toBe(true)
  })

  it('re-gate: deleting the last installed STT model bounces the view to onboarding and reassigns sttModel', async () => {
    setupIPC({
      models: [sttModelFixture({ id: 'whisper-small', state: 'installed' })],
      listModelsAfter: () => [sttModelFixture({ id: 'whisper-small', state: 'notInstalled' })],
    })
    const result = await loaded()
    expect(result.current.view).toBe('notes')
    expect(result.current.sttModel).toBe('whisper-small')

    act(() => result.current.deleteModel('whisper-small'))

    await waitFor(() => expect(result.current.view).toBe('onboarding'))
    expect(result.current.sttModel).toBe('whisper-small') // reassigned to the (bare) recommendation placeholder
    expect(result.current.models.every(m => m.state !== 'installed')).toBe(true)
  })

  it('deleting a non-selected model does not change the view', async () => {
    setupIPC({
      models: [
        sttModelFixture({ id: 'whisper-small', state: 'installed' }),
        sttModelFixture({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'installed' }),
      ],
      listModelsAfter: () => [
        sttModelFixture({ id: 'whisper-small', state: 'installed' }),
        sttModelFixture({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'notInstalled' }),
      ],
    })
    const result = await loaded()
    expect(result.current.view).toBe('notes')

    act(() => result.current.deleteModel('whisper-medium'))
    await waitFor(() => expect(result.current.models.find(m => m.id === 'whisper-medium')?.state).toBe('notInstalled'))

    expect(result.current.view).toBe('notes')
    expect(result.current.sttModel).toBe('whisper-small')
  })

  describe('⌘K search palette state', () => {
    it('openSearch/closeSearch toggle searchOpen', async () => {
      setupIPC()
      const result = await loaded()
      expect(result.current.searchOpen).toBe(false)

      act(() => result.current.openSearch())
      expect(result.current.searchOpen).toBe(true)

      act(() => result.current.closeSearch())
      expect(result.current.searchOpen).toBe(false)
    })

    it('searchNotes passes the query through to search_notes and resolves with the fixture hits', async () => {
      const hits: SearchHit[] = [
        { noteId: '20260722-120000', title: 'Client call — Acme', snippet: 'roadmap', segmentStart: 12, kind: 'transcript' },
      ]
      setupIPC({ searchNotes: () => hits })
      const result = await loaded()

      await expect(result.current.searchNotes('roadmap')).resolves.toEqual(hits)
    })
  })

  describe('selectNoteById', () => {
    it('selects the note matching the given id, regardless of its list position', async () => {
      const notes = [noteFixture({ id: 'note-a', title: 'A' }), noteFixture({ id: 'note-b', title: 'B' }), noteFixture({ id: 'note-c', title: 'C' })]
      setupIPC({ notes })
      const result = await loaded()
      expect(result.current.selectedNoteId).toBe('note-a')

      act(() => result.current.selectNoteById('note-c'))

      expect(result.current.selectedNoteId).toBe('note-c')
    })

    it('is a no-op when the id is not found in the current note list', async () => {
      const notes = [noteFixture({ id: 'note-a' }), noteFixture({ id: 'note-b' })]
      setupIPC({ notes })
      const result = await loaded()
      expect(result.current.selectedNoteId).toBe('note-a')

      act(() => result.current.selectNoteById('does-not-exist'))

      expect(result.current.selectedNoteId).toBe('note-a')
    })
  })

  describe('requestSeek / pendingSeek (transcript-hit palette selection)', () => {
    it('requestSeek selects the note by id and records the pending seek', async () => {
      const notes = [noteFixture({ id: 'note-a', title: 'A' }), noteFixture({ id: 'note-b', title: 'B' })]
      setupIPC({ notes })
      const result = await loaded()
      expect(result.current.selectedNoteId).toBe('note-a')

      act(() => result.current.requestSeek('note-b', 42))

      expect(result.current.selectedNoteId).toBe('note-b')
      expect(result.current.pendingSeek).toEqual({ noteId: 'note-b', seconds: 42 })
    })

    it('clearPendingSeek resets pendingSeek back to null', async () => {
      const notes = [noteFixture({ id: 'note-a' })]
      setupIPC({ notes })
      const result = await loaded()

      act(() => result.current.requestSeek('note-a', 10))
      expect(result.current.pendingSeek).not.toBeNull()

      act(() => result.current.clearPendingSeek())
      expect(result.current.pendingSeek).toBeNull()
    })

    describe('invalidation (stale seeks must not fire late)', () => {
      it('regression: the direct search-hit flow still leaves a matching pendingSeek in place (requestSeek selecting its own target does not self-invalidate)', async () => {
        const notes = [noteFixture({ id: 'note-a' }), noteFixture({ id: 'note-b' })]
        setupIPC({ notes })
        const result = await loaded()

        act(() => result.current.requestSeek('note-b', 42))

        expect(result.current.selectedNoteId).toBe('note-b')
        expect(result.current.pendingSeek).toEqual({ noteId: 'note-b', seconds: 42 })
      })

      it('selecting a different note clears a pending seek for the note just navigated away from', async () => {
        const notes = [noteFixture({ id: 'note-a' }), noteFixture({ id: 'note-b' }), noteFixture({ id: 'note-c' })]
        setupIPC({ notes })
        const result = await loaded()

        act(() => result.current.requestSeek('note-b', 42))
        expect(result.current.pendingSeek).toEqual({ noteId: 'note-b', seconds: 42 })

        act(() => result.current.selectNoteById('note-c'))
        expect(result.current.pendingSeek).toBeNull()
      })

      it('navigate-away-then-reopen: reselecting the original pending note after navigating away does not resurrect the seek', async () => {
        const notes = [noteFixture({ id: 'note-a' }), noteFixture({ id: 'note-b' }), noteFixture({ id: 'note-c' })]
        setupIPC({ notes })
        const result = await loaded()

        // A transcript hit for note-b arms a pending seek...
        act(() => result.current.requestSeek('note-b', 42))
        expect(result.current.pendingSeek).toEqual({ noteId: 'note-b', seconds: 42 })

        // ...but the user wanders off to a different note before it's ever
        // applied (note-b's audio never actually loaded in this scenario).
        act(() => result.current.selectNoteById('note-c'))
        expect(result.current.pendingSeek).toBeNull()

        // Minutes later, opening note-b again normally must NOT resurrect
        // the old seek request — there is nothing left to reapply.
        act(() => result.current.selectNoteById('note-b'))
        expect(result.current.selectedNoteId).toBe('note-b')
        expect(result.current.pendingSeek).toBeNull()
      })

      it('navigating to Settings clears a pending seek even though the selected note itself never changes', async () => {
        const notes = [noteFixture({ id: 'note-a' })]
        setupIPC({ notes })
        const result = await loaded()

        act(() => result.current.requestSeek('note-a', 15))
        expect(result.current.pendingSeek).toEqual({ noteId: 'note-a', seconds: 15 })

        act(() => result.current.goSettings())
        expect(result.current.pendingSeek).toBeNull()
      })

      it('navigating to Settings and back to Notes on the same note does not resurrect the seek', async () => {
        const notes = [noteFixture({ id: 'note-a' })]
        setupIPC({ notes })
        const result = await loaded()

        act(() => result.current.requestSeek('note-a', 15))
        act(() => result.current.goSettings())
        act(() => result.current.goNotes())

        expect(result.current.selectedNoteId).toBe('note-a')
        expect(result.current.pendingSeek).toBeNull()
      })
    })
  })

  describe('sidebar search filter', () => {
    afterEach(() => vi.useRealTimers())

    it('setSidebarQuery debounces a search_notes call and populates sidebarMatchedIds with the matched ids', async () => {
      const notes = [noteFixture({ id: 'note-a', title: 'Roadmap review' }), noteFixture({ id: 'note-b', title: 'Standup' })]
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({
        notes,
        onCmd: (cmd, args) => calls.push({ cmd, args }),
        searchNotes: () => [{ noteId: 'note-a', title: 'Roadmap review', snippet: 'Roadmap review', segmentStart: null, kind: 'title' }],
      })
      const result = await loaded()
      vi.useFakeTimers()
      expect(result.current.sidebarMatchedIds).toBeNull()

      act(() => result.current.setSidebarQuery('roadmap'))
      expect(result.current.sidebarQuery).toBe('roadmap')
      // Not yet called — still inside the debounce window.
      expect(calls.some(c => c.cmd === 'search_notes')).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(150)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(result.current.sidebarMatchedIds).toEqual(new Set(['note-a']))
    })

    it('clearing the query resets sidebarMatchedIds to null synchronously, without a backend call', async () => {
      const notes = [noteFixture({ id: 'note-a' })]
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes, onCmd: (cmd, args) => calls.push({ cmd, args }), searchNotes: () => [] })
      const result = await loaded()
      vi.useFakeTimers()

      act(() => result.current.setSidebarQuery('roadmap'))
      await act(async () => {
        vi.advanceTimersByTime(150)
        await Promise.resolve()
      })
      const searchCallsAfterFirstQuery = calls.filter(c => c.cmd === 'search_notes').length

      act(() => result.current.setSidebarQuery(''))

      expect(result.current.sidebarMatchedIds).toBeNull()
      expect(calls.filter(c => c.cmd === 'search_notes').length).toBe(searchCallsAfterFirstQuery)
    })

    it('restarts the debounce on every keystroke rather than firing per keystroke', async () => {
      const notes = [noteFixture({ id: 'note-a' })]
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ notes, onCmd: (cmd, args) => calls.push({ cmd, args }), searchNotes: () => [] })
      const result = await loaded()
      vi.useFakeTimers()

      act(() => result.current.setSidebarQuery('r'))
      act(() => {
        vi.advanceTimersByTime(100)
      })
      act(() => result.current.setSidebarQuery('ro'))
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(calls.some(c => c.cmd === 'search_notes')).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(150)
        await Promise.resolve()
      })
      expect(calls.filter(c => c.cmd === 'search_notes')).toHaveLength(1)
    })

    it('clearing the query while a search is still in flight discards the stale response instead of repopulating sidebarMatchedIds', async () => {
      const notes = [noteFixture({ id: 'note-a' })]
      let resolveSearch: (hits: SearchHit[]) => void = () => {}
      const pending = new Promise<SearchHit[]>(resolve => {
        resolveSearch = resolve
      })
      setupIPC({ notes, searchNotes: () => pending })
      const result = await loaded()
      vi.useFakeTimers()

      act(() => result.current.setSidebarQuery('roadmap'))
      await act(async () => {
        vi.advanceTimersByTime(150)
        await Promise.resolve()
      })
      // The debounced call has fired (the promise is pending, unresolved) —
      // clear the query before it settles.
      act(() => result.current.setSidebarQuery(''))
      expect(result.current.sidebarMatchedIds).toBeNull()

      // The stale "roadmap" response resolves only now, after the clear —
      // it must not repopulate sidebarMatchedIds.
      await act(async () => {
        resolveSearch([{ noteId: 'note-a', title: 'note-a', snippet: 'note-a', segmentStart: null, kind: 'title' }])
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(result.current.sidebarMatchedIds).toBeNull()
    })
  })
})
