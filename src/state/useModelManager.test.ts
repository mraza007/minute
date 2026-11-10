import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowseKind, ModelBrowse, ModelStatus, Recommendation, Settings } from '../ipc/types'
import type { View } from '../types'
import { useModelManager } from './useModelManager'
import { DEFAULT_OBSIDIAN_SETTINGS } from './obsidian'

const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }

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
    speakerProfiles: false,
    autoApplySpeakerNames: true,
    obsidian: DEFAULT_OBSIDIAN_SETTINGS,
    libraryRoot: null,
    ...overrides,
  }
}

function sttModelFixture(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    traits: [],
    origin: { kind: 'tested' },
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
    traits: [],
    origin: { kind: 'tested' },
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    sha256: 'b'.repeat(64),
    sizeBytes: 2_600_000_000,
    minRamGb: 8,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

/** `list_models` defaults to `[]` (not `null`) unless `onCmd` says otherwise — matches the real backend, which never returns null. */
function setupIPC(onCmd?: (cmd: string, args: unknown) => unknown) {
  mockIPC(
    (cmd, args) => {
      const result = onCmd?.(cmd, args)
      if (result !== undefined) return result
      return cmd === 'list_models' ? [] : null
    },
    { shouldMockEvents: true },
  )
}

/**
 * Test harness mirroring how useAppState actually drives this hook: `view`
 * lives in the harness (as it would in useAppState), and `loaded` only
 * flips to true in the same act() as the initial model seed — exactly
 * like useAppState's mount effect calls `applyInitialLoad` and
 * `setLoaded(true)` together from the same `.then()` callback.
 */
function useHarness(initialView: View = 'notes') {
  const [view, setView] = useState<View>(initialView)
  const [loaded, setLoaded] = useState(false)
  const manager = useModelManager({ view, setView, loaded })

  function seed(models: ModelStatus[], rec: Recommendation, settings?: Settings) {
    manager.applyInitialLoad(models, rec, settings)
    setLoaded(true)
  }

  return { view, setView, loaded, seed, ...manager }
}

describe('useModelManager', () => {
  afterEach(() => vi.useRealTimers())

  it('applyInitialLoad seeds models, recommendation, and the initial sttModel selection', () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())
    const models = [sttModelFixture({ state: 'installed' }), llmModelFixture()]
    act(() => result.current.seed(models, recommendation))

    expect(result.current.models).toEqual(models)
    expect(result.current.recommendation).toEqual(recommendation)
    expect(result.current.sttModel).toBe('whisper-small')
  })

  it('applyInitialLoad prefers a persisted settings.sttModel/llmModel over the recommendation', () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())
    const models = [
      sttModelFixture({ id: 'whisper-small', state: 'installed' }),
      sttModelFixture({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'installed' }),
      llmModelFixture({ id: 'qwen3.5-4b', state: 'installed' }),
      llmModelFixture({ id: 'gemma-4-e4b', displayName: 'Gemma 4 E4B', state: 'installed' }),
    ]
    act(() => result.current.seed(models, recommendation, settingsFixture({ sttModel: 'whisper-medium', llmModel: 'gemma-4-e4b' })))

    expect(result.current.sttModel).toBe('whisper-medium')
    expect(result.current.llmModel).toBe('gemma-4-e4b')
  })

  it('applyInitialLoad falls back to the recommendation when the persisted settings selection is not installed', () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())
    const models = [sttModelFixture({ state: 'installed' }), llmModelFixture({ state: 'installed' })]
    act(() =>
      result.current.seed(models, recommendation, settingsFixture({ sttModel: 'whisper-medium', llmModel: 'gemma-4-e4b' })),
    )

    expect(result.current.sttModel).toBe('whisper-small')
    expect(result.current.llmModel).toBe('qwen3.5-4b')
  })

  it('applyInitialLoad leaves llmModel null when nothing is installed and nothing is persisted', () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())
    act(() => result.current.seed([sttModelFixture({ state: 'installed' })], recommendation, settingsFixture()))

    expect(result.current.llmModel).toBeNull()
  })

  it('setSttModel updates the selection immediately and persists it via set_settings', () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC((cmd, args) => {
      calls.push({ cmd, args })
    })
    const { result } = renderHook(() => useHarness())
    act(() => result.current.seed([sttModelFixture({ state: 'installed' })], recommendation, settingsFixture()))

    act(() => result.current.setSttModel('whisper-medium'))

    expect(result.current.sttModel).toBe('whisper-medium')
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.sttModel === 'whisper-medium')).toBe(
      true,
    )
  })

  it('setLlmModel updates the selection immediately and persists it via set_settings', () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC((cmd, args) => {
      calls.push({ cmd, args })
    })
    const { result } = renderHook(() => useHarness())
    act(() => result.current.seed([llmModelFixture({ state: 'installed' })], recommendation, settingsFixture()))

    act(() => result.current.setLlmModel('gemma-4-e4b'))

    expect(result.current.llmModel).toBe('gemma-4-e4b')
    expect(calls.some(c => c.cmd === 'set_settings' && (c.args as { patch: Partial<Settings> }).patch.llmModel === 'gemma-4-e4b')).toBe(
      true,
    )
  })

  it('a rejected setSttModel persist call reports the error but keeps the optimistic selection', async () => {
    setupIPC(cmd => {
      if (cmd === 'set_settings') throw new Error('disk full')
    })
    const { result } = renderHook(() => useHarness())
    act(() => result.current.seed([sttModelFixture({ state: 'installed' })], recommendation, settingsFixture()))

    await act(async () => {
      result.current.setSttModel('whisper-medium')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sttModel).toBe('whisper-medium')
    expect(result.current.lastError).toContain('disk full')
  })

  it('downloadModel invokes download_model and optimistically marks the model as downloading', () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC((cmd, args) => {
      calls.push({ cmd, args })
    })
    const { result } = renderHook(() => useHarness())
    act(() => result.current.seed([sttModelFixture()], recommendation))

    act(() => result.current.downloadModel('whisper-small'))
    expect(calls.some(c => c.cmd === 'download_model' && (c.args as { id: string }).id === 'whisper-small')).toBe(true)
    expect(result.current.downloads['whisper-small']).toEqual({ downloaded: 0, total: 466_000_000 })
  })

  it('a model-download-progress event updates the downloads map', async () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())

    await act(async () => {
      await emit('model-download-progress', { modelId: 'whisper-small', downloaded: 100, total: 466_000_000 })
    })

    expect(result.current.downloads['whisper-small']).toEqual({ downloaded: 100, total: 466_000_000 })
  })

  it('a successful model-download-done event clears the download entry and refetches models', async () => {
    let listModelsCalls = 0
    const refreshed = [sttModelFixture({ state: 'installed' })]
    setupIPC(cmd => {
      if (cmd === 'list_models') {
        listModelsCalls += 1
        return refreshed
      }
    })
    const { result } = renderHook(() => useHarness())
    act(() => result.current.downloadModel('whisper-small'))
    expect(result.current.downloads['whisper-small']).toBeDefined()

    await act(async () => {
      await emit('model-download-done', { modelId: 'whisper-small', ok: true, cancelled: false, error: null })
    })

    expect(result.current.downloads['whisper-small']).toBeUndefined()
    expect(listModelsCalls).toBe(1)
    expect(result.current.models).toEqual(refreshed)
  })

  it('a failed model-download-done event reports a transient error that clears after 5s', async () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())

    vi.useFakeTimers()
    await act(async () => {
      await emit('model-download-done', { modelId: 'whisper-small', ok: false, cancelled: false, error: 'checksum mismatch' })
    })
    expect(result.current.lastError).toBe('checksum mismatch')

    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.lastError).toBeNull()
  })

  it('a cancelled model-download-done event does not report an error', async () => {
    setupIPC()
    const { result } = renderHook(() => useHarness())
    await act(async () => {
      await emit('model-download-done', { modelId: 'whisper-small', ok: false, cancelled: true, error: null })
    })
    expect(result.current.lastError).toBeNull()
  })

  it('cancelDownload invokes cancel_download with the model id', () => {
    const calls: Array<{ cmd: string; args: unknown }> = []
    setupIPC((cmd, args) => {
      calls.push({ cmd, args })
    })
    const { result } = renderHook(() => useHarness())
    act(() => result.current.cancelDownload('whisper-small'))
    expect(calls.some(c => c.cmd === 'cancel_download' && (c.args as { id: string }).id === 'whisper-small')).toBe(true)
  })

  it('deleteModel invokes delete_model then refetches list_models', async () => {
    let listModelsCalls = 0
    setupIPC(cmd => {
      if (cmd === 'list_models') {
        listModelsCalls += 1
        return []
      }
    })
    const { result } = renderHook(() => useHarness())
    await act(async () => {
      result.current.deleteModel('whisper-small')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(listModelsCalls).toBe(1)
  })

  it('a rejected downloadModel call reports the error and clears the optimistic download entry', async () => {
    setupIPC(cmd => {
      if (cmd === 'download_model') throw new Error('disk full')
    })
    const { result } = renderHook(() => useHarness())

    await act(async () => {
      result.current.downloadModel('whisper-small')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.lastError).toContain('disk full')
    expect(result.current.downloads['whisper-small']).toBeUndefined()
  })

  it('re-gate: deleting the last installed STT model bounces the view to onboarding and reassigns sttModel', async () => {
    const beforeDelete = [sttModelFixture({ id: 'whisper-small', state: 'installed' })]
    const afterDelete = [sttModelFixture({ id: 'whisper-small', state: 'notInstalled' })]
    // seed() bypasses IPC entirely (it calls applyInitialLoad directly), so
    // the only real `list_models` call this test causes is deleteModel's
    // own post-delete refetch.
    setupIPC(cmd => (cmd === 'list_models' ? afterDelete : undefined))
    const { result } = renderHook(() => useHarness('settings'))
    act(() => result.current.seed(beforeDelete, recommendation))
    expect(result.current.sttModel).toBe('whisper-small')
    expect(result.current.view).toBe('settings')

    act(() => result.current.deleteModel('whisper-small'))

    await waitFor(() => expect(result.current.view).toBe('onboarding'))
    expect(result.current.sttModel).toBe('whisper-small') // reassigned to the (bare) recommendation placeholder
    expect(result.current.models.every(m => m.state !== 'installed')).toBe(true)
  })

  it('re-gate: deleting a non-selected model with another STT model still installed does not change the view', async () => {
    const beforeDelete = [
      sttModelFixture({ id: 'whisper-small', state: 'installed' }),
      sttModelFixture({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'installed' }),
    ]
    const afterDelete = [
      sttModelFixture({ id: 'whisper-small', state: 'installed' }),
      sttModelFixture({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'notInstalled' }),
    ]
    // Same as above — seed() bypasses IPC, so the only real `list_models`
    // call is deleteModel's own post-delete refetch.
    setupIPC(cmd => (cmd === 'list_models' ? afterDelete : undefined))
    const { result } = renderHook(() => useHarness('settings'))
    act(() => result.current.seed(beforeDelete, recommendation))
    expect(result.current.sttModel).toBe('whisper-small')

    act(() => result.current.deleteModel('whisper-medium'))
    await waitFor(() => expect(result.current.models).toEqual(afterDelete))

    expect(result.current.view).toBe('settings')
    expect(result.current.sttModel).toBe('whisper-small')
  })

  it('does not force a redundant setView call once already on the onboarding view', async () => {
    let listModelsCalls = 0
    setupIPC(cmd => {
      if (cmd === 'list_models') {
        listModelsCalls += 1
        return [sttModelFixture({ state: 'notInstalled' })]
      }
    })
    const setViewSpy = vi.fn()
    const { result } = renderHook(() => {
      const [loaded, setLoaded] = useState(false)
      const manager = useModelManager({ view: 'onboarding', setView: setViewSpy, loaded })
      return { ...manager, seed: (models: ModelStatus[], rec: Recommendation) => {
        manager.applyInitialLoad(models, rec)
        setLoaded(true)
      } }
    })
    act(() => result.current.seed([sttModelFixture({ state: 'notInstalled' })], recommendation))

    act(() => result.current.deleteModel('whisper-small'))
    await waitFor(() => expect(listModelsCalls).toBeGreaterThan(0))

    expect(setViewSpy).not.toHaveBeenCalled()
  })

  it('does not re-gate before loaded=true (an unseeded empty models array is not treated as "no STT installed")', () => {
    setupIPC()
    const setViewSpy = vi.fn()
    renderHook(() => useModelManager({ view: 'notes', setView: setViewSpy, loaded: false }))
    expect(setViewSpy).not.toHaveBeenCalled()
  })
})

function hfModelFixture(name: string, overrides: Partial<ModelStatus> = {}): ModelStatus {
  return llmModelFixture({
    id: `hf:jdoe/${name}-GGUF/${name}-Q4_K_M.gguf`,
    displayName: name,
    origin: {
      kind: 'huggingFace',
      repo: `jdoe/${name}-GGUF`,
      file: `${name}-Q4_K_M.gguf`,
      publisher: 'jdoe',
      trusted: false,
      architecture: 'llama',
      parameters: 8_000_000_000,
      quantization: 'Q4_K_M',
      updatedAt: '2026-11-04T12:00:00Z',
      downloads: 120,
    },
    sizeBytes: 4_900_000_000,
    ...overrides,
  })
}

function answer(entries: ModelStatus[], overrides: Partial<ModelBrowse> = {}): ModelBrowse {
  return { entries, fetchedAt: '2026-11-10T08:00:00Z', unsupportedCount: 0, error: null, ...overrides }
}

interface BrowseCall {
  kind: BrowseKind
  query: string | null
  refresh: boolean
}

/** Answers `browse_models` through `respond` and `list_models` through `listed`, and records every call. */
function setupBrowse(respond: (call: BrowseCall) => ModelBrowse | Promise<ModelBrowse>, listed: () => ModelStatus[] = () => []) {
  const calls: BrowseCall[] = []
  const all: Array<{ cmd: string; args: unknown }> = []
  setupIPC((cmd, args) => {
    all.push({ cmd, args })
    if (cmd === 'list_models') return listed()
    if (cmd !== 'browse_models') return undefined
    const call = args as BrowseCall
    calls.push(call)
    return respond(call)
  })
  return { calls, all }
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

describe('useModelManager Hugging Face browsing', () => {
  afterEach(() => vi.useRealTimers())

  it('does not contact Hugging Face until the Models page opens, then asks for both kinds', async () => {
    const { calls } = setupBrowse(call => answer(call.kind === 'llm' ? [hfModelFixture('llama')] : []))
    const { result } = renderHook(() => useHarness())
    act(() => result.current.seed([sttModelFixture({ state: 'installed' })], recommendation))
    await flush()
    expect(calls).toEqual([])

    act(() => result.current.huggingFace.open())
    expect(result.current.huggingFace.state.llm.loading).toBe(true)
    await flush()

    expect(calls).toEqual([
      { kind: 'stt', query: null, refresh: false },
      { kind: 'llm', query: null, refresh: false },
    ])
    expect(result.current.huggingFace.state.llm).toMatchObject({ loading: false, result: answer([hfModelFixture('llama')]) })
    expect(result.current.huggingFace.models.map(m => m.displayName)).toEqual(['llama'])
  })

  it('searches once typing pauses, and at once on Enter', async () => {
    vi.useFakeTimers()
    const { calls } = setupBrowse(() => answer([]))
    const { result } = renderHook(() => useHarness())

    act(() => {
      result.current.huggingFace.setQuery('llm', 'gr')
      result.current.huggingFace.setQuery('llm', 'gran')
      result.current.huggingFace.setQuery('llm', 'granite ')
    })
    expect(result.current.huggingFace.state.llm.query).toBe('granite ')
    act(() => vi.advanceTimersByTime(299))
    expect(calls).toEqual([])
    act(() => vi.advanceTimersByTime(1))
    expect(calls).toEqual([{ kind: 'llm', query: 'granite', refresh: false }])

    act(() => {
      result.current.huggingFace.setQuery('llm', 'qwen')
      result.current.huggingFace.search('llm')
    })
    act(() => vi.advanceTimersByTime(1000))
    expect(calls.slice(1)).toEqual([{ kind: 'llm', query: 'qwen', refresh: false }])

    act(() => {
      result.current.huggingFace.setQuery('llm', '  ')
      result.current.huggingFace.search('llm')
    })
    expect(calls.at(-1)).toEqual({ kind: 'llm', query: null, refresh: false })
  })

  it('refresh skips the backend cache for the current search', async () => {
    const { calls } = setupBrowse(() => answer([]))
    const { result } = renderHook(() => useHarness())
    act(() => {
      result.current.huggingFace.setQuery('llm', 'granite')
      result.current.huggingFace.refresh('llm')
    })
    await flush()
    expect(calls).toEqual([{ kind: 'llm', query: 'granite', refresh: true }])
  })

  it('keeps the newest search when an older answer arrives late', async () => {
    const pending: Array<(value: ModelBrowse) => void> = []
    setupBrowse(() => new Promise<ModelBrowse>(resolve => pending.push(resolve)))
    const { result } = renderHook(() => useHarness())

    act(() => {
      result.current.huggingFace.setQuery('llm', 'llama')
      result.current.huggingFace.search('llm')
      result.current.huggingFace.setQuery('llm', 'qwen')
      result.current.huggingFace.search('llm')
    })
    await flush()
    act(() => pending[1](answer([hfModelFixture('qwen')])))
    await flush()
    act(() => pending[0](answer([hfModelFixture('llama')])))
    await flush()

    expect(result.current.huggingFace.state.llm.result?.entries.map(m => m.displayName)).toEqual(['qwen'])
    expect(result.current.huggingFace.state.llm.loading).toBe(false)
  })

  it('turns a failed request into an answer with an error, so tested models stay usable', async () => {
    setupBrowse(() => Promise.reject('network is offline'))
    const { result } = renderHook(() => useHarness())
    act(() => result.current.huggingFace.open())
    await flush()

    expect(result.current.huggingFace.state.llm).toMatchObject({
      loading: false,
      result: { entries: [], fetchedAt: null, unsupportedCount: 0, error: 'network is offline' },
    })
    expect(result.current.lastError).toBeNull()
  })

  it('downloads a Hugging Face file with consent and keeps it listed until it lands on this Mac', async () => {
    const llama = hfModelFixture('llama')
    let listed: ModelStatus[] = []
    const { all } = setupBrowse(
      call => answer(call.query === 'qwen' ? [hfModelFixture('qwen')] : call.kind === 'llm' ? [llama] : []),
      () => listed,
    )
    const { result } = renderHook(() => useHarness())
    act(() => result.current.huggingFace.open())
    await flush()

    act(() => result.current.downloadModel(llama.id, true))
    expect(all.find(c => c.cmd === 'download_model')?.args).toEqual({ id: llama.id, allowUnknownPublisher: true })
    expect(result.current.downloads[llama.id]).toEqual({ downloaded: 0, total: 4_900_000_000 })

    act(() => {
      result.current.huggingFace.setQuery('llm', 'qwen')
      result.current.huggingFace.search('llm')
    })
    await flush()
    expect(result.current.huggingFace.models.map(m => m.displayName)).toEqual(['qwen', 'llama'])

    listed = [{ ...llama, state: 'installed' }]
    await act(async () => {
      await emit('model-download-done', { modelId: llama.id, ok: true, cancelled: false, error: null })
    })
    await flush()
    expect(result.current.models).toEqual(listed)
    expect(result.current.huggingFace.models.map(m => m.displayName)).toEqual(['qwen'])
  })
})
