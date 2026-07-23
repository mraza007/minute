import { mockIPC } from '@tauri-apps/api/mocks'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hardware, ModelStatus, NoteMeta, Recommendation, StorageStats } from '../ipc/types'
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

  it('startRec/togglePause/stopRec drive the recording view and local timer', async () => {
    setupIPC()
    const result = await loaded()

    vi.useFakeTimers()
    act(() => result.current.startRec())
    expect(result.current.view).toBe('recording')
    expect(result.current.recSeconds).toBe(0)
    expect(result.current.recTime).toBe('00:00')

    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.recSeconds).toBe(3)

    act(() => result.current.togglePause())
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.recSeconds).toBe(3)

    act(() => result.current.togglePause())
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current.recSeconds).toBe(5)

    act(() => result.current.stopRec())
    expect(result.current.view).toBe('notes')
    vi.useRealTimers()
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
