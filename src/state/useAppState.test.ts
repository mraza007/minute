import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Hardware,
  ModelStatus,
  NoteMeta,
  RecordingStateEvent,
  Recommendation,
  StorageStats,
  SttStatusEvent,
  TranscriptSegmentEvent,
} from '../ipc/types'
import { useAppState } from './useAppState'

const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
const storage: StorageStats = { modelsBytes: 500_000_000, audioBytes: 200_000_000, notesBytes: 100_000_000 }

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
  /** What `start_recording` resolves with — defaults to a fixed id. */
  startRecordingId?: string
  /** Controls `stop_recording`'s outcome: resolves with `result` (defaults to `notes[0]`), or rejects with `reject`. */
  stopRecording?: { result?: NoteMeta; reject?: string }
}

function setupIPC(opts: SetupOpts = {}) {
  const models = opts.models ?? [sttModelFixture({ state: 'installed' }), llmModelFixture()]
  const notes = opts.notes ?? [noteFixture()]
  let listModelsCalls = 0
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
          return notes
        case 'hardware_info':
          return hardware
        case 'recommended_models':
          return recommendation
        case 'storage_stats':
          return storage
        case 'start_recording':
          return opts.startRecordingId ?? '20260722-130000'
        case 'pause_recording':
        case 'resume_recording':
          return null
        case 'stop_recording':
          if (opts.stopRecording?.reject) throw opts.stopRecording.reject
          return opts.stopRecording?.result ?? notes[0]
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
    act(() => result.current.completeOnboarding())
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

  it('selectNote updates sel', async () => {
    setupIPC()
    const result = await loaded()
    act(() => result.current.selectNote(3))
    expect(result.current.sel).toBe(3)
  })

  it('toggleDel and toggleEnc flip local state', async () => {
    setupIPC()
    const result = await loaded()
    expect(result.current.tDel).toBe(true)
    act(() => result.current.toggleDel())
    expect(result.current.tDel).toBe(false)
    expect(result.current.tEnc).toBe(false)
    act(() => result.current.toggleEnc())
    expect(result.current.tEnc).toBe(true)
  })

  it('setAskDraft/ask capture the ask-your-notes draft, with a fallback askText', async () => {
    setupIPC()
    const result = await loaded()
    expect(result.current.askText).toBe('What did we promise Acme?')
    act(() => result.current.setAskDraft('what about pricing?'))
    act(() => result.current.ask())
    expect(result.current.asked).toBe(true)
    expect(result.current.askText).toBe('what about pricing?')
  })

  describe('recording flow', () => {
    const noteId = '20260722-130000'

    function recordingState(overrides: Partial<RecordingStateEvent> = {}): RecordingStateEvent {
      return { noteId, state: 'recording', elapsed: 0, ...overrides }
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

      expect(calls.some(c => c.cmd === 'start_recording' && (c.args as { modelId: string }).modelId === 'whisper-small')).toBe(true)
      expect(result.current.recElapsed).toBe(0)
      expect(result.current.recTime).toBe('00:00')
      expect(result.current.liveSegments).toEqual([])
      expect(result.current.sttStatus).toBe('idle')
    })

    it('startRec rejecting reports lastError and stays off the recording view', async () => {
      setupIPC({ reject: true })
      const result = await loaded()

      act(() => result.current.startRec())
      await waitFor(() => expect(result.current.lastError).toContain('backend unavailable'))
      expect(result.current.view).not.toBe('recording')
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
})
