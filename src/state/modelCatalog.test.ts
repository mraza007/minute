import { describe, expect, it } from 'vitest'
import type { Hardware, ModelOrigin, ModelStatus, Recommendation } from '../ipc/types'
import { buildModelCatalog, formatAge, formatParameters, modelDetail, type CatalogInput } from './modelCatalog'

const NOW = new Date('2026-11-10T12:00:00Z')
const HARDWARE: Hardware = { totalRamGb: 18, appleSilicon: true, cores: 12 }
const RECOMMENDATION: Recommendation = { stt: 'whisper-large-v3-turbo', llm: 'qwen3.5-4b' }

function hfOrigin(overrides: Partial<Extract<ModelOrigin, { kind: 'huggingFace' }>> = {}): ModelOrigin {
  return {
    kind: 'huggingFace',
    repo: 'ibm-granite/granite-4.0-h-tiny-GGUF',
    file: 'granite-4.0-h-tiny-Q4_K_M.gguf',
    publisher: 'ibm-granite',
    trusted: true,
    architecture: 'granitehybrid',
    parameters: 6_940_000_000,
    quantization: 'Q4_K_M',
    updatedAt: '2026-10-02T12:00:00Z',
    downloads: 48_000,
    ...overrides,
  }
}

function model(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-large-v3-turbo',
    kind: 'stt',
    displayName: 'Whisper large-v3 turbo',
    traits: ['Most accurate', '99 languages'],
    origin: { kind: 'tested' },
    url: '',
    sha256: '',
    sizeBytes: 1_624_555_275,
    minRamGb: 8,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

describe('modelDetail', () => {
  it('lists a tested model’s traits and its size', () => {
    expect(modelDetail(model(), NOW)).toBe('Most accurate · 99 languages · 1.6 GB')
  })

  it('lists a Hugging Face file’s publisher, parameters, quantization, size, and date', () => {
    const granite = model({ kind: 'llm', traits: [], origin: hfOrigin(), sizeBytes: 4_200_000_000 })
    expect(modelDetail(granite, NOW)).toBe('ibm-granite · 6.9B · Q4_K_M · 4.2 GB · Oct 2')
  })

  it('adds the year to a date outside this year and skips facts Hugging Face did not give', () => {
    const old = model({
      kind: 'llm',
      traits: [],
      origin: hfOrigin({ parameters: null, quantization: null, updatedAt: '2025-03-14T12:00:00Z' }),
      sizeBytes: 4_200_000_000,
    })
    expect(modelDetail(old, NOW)).toBe('ibm-granite · 4.2 GB · Mar 14, 2025')
  })

  it('prefers editorial traits over repo facts when a Hugging Face file has them', () => {
    const compact = model({ traits: ['Most accurate', '99 languages'], origin: hfOrigin({ publisher: 'ggerganov' }), sizeBytes: 574_000_000 })
    expect(modelDetail(compact, NOW)).toBe('Most accurate · 99 languages · 574 MB')
  })
})

function tested(id: string, kind: ModelStatus['kind'], overrides: Partial<ModelStatus> = {}): ModelStatus {
  return model({ id, kind, displayName: id, ...overrides })
}

function hf(id: string, origin: Partial<Extract<ModelOrigin, { kind: 'huggingFace' }>> = {}, overrides: Partial<ModelStatus> = {}): ModelStatus {
  return model({ id: `hf:${id}`, kind: 'llm', displayName: id, traits: [], origin: hfOrigin(origin), ...overrides })
}

function catalog(overrides: Partial<CatalogInput> = {}) {
  return buildModelCatalog({
    listed: [],
    browsed: [],
    hardware: HARDWARE,
    recommendation: RECOMMENDATION,
    downloads: {},
    selected: { stt: null, llm: null },
    now: NOW,
    ...overrides,
  })
}

const ids = (rows: { model: ModelStatus }[]) => rows.map(row => row.model.id)

describe('buildModelCatalog', () => {
  it('puts downloaded models on this Mac, other tested models under tested, and browsed files under Hugging Face', () => {
    const result = catalog({
      listed: [
        tested('whisper-small', 'stt', { state: 'installed' }),
        tested('whisper-medium', 'stt'),
        tested('qwen3.5-4b', 'llm', { state: 'installed' }),
        hf('ibm-granite/granite-micro', {}, { state: 'installed' }),
        tested('gemma-4-e4b', 'llm'),
        tested('diar-segmentation', 'diarization', { state: 'installed' }),
      ],
      browsed: [hf('ggml-org/smollm3'), model({ id: 'hf:ggerganov/whisper.cpp/ggml-small.en.bin', origin: hfOrigin({ publisher: 'ggerganov' }) })],
    })

    expect(ids(result.stt.onThisMac)).toEqual(['whisper-small'])
    expect(ids(result.stt.tested)).toEqual(['whisper-medium'])
    expect(ids(result.stt.huggingFace)).toEqual(['hf:ggerganov/whisper.cpp/ggml-small.en.bin'])
    expect(ids(result.llm.onThisMac)).toEqual(['qwen3.5-4b', 'hf:ibm-granite/granite-micro'])
    expect(ids(result.llm.tested)).toEqual(['gemma-4-e4b'])
    expect(ids(result.llm.huggingFace)).toEqual(['hf:ggml-org/smollm3'])
  })

  it('shows a model once, as downloaded, when an older browse answer still lists it', () => {
    const result = catalog({
      listed: [hf('ggml-org/smollm3', {}, { state: 'installed' })],
      browsed: [hf('ggml-org/smollm3'), hf('ggml-org/smollm3')],
    })
    expect(ids(result.llm.onThisMac)).toEqual(['hf:ggml-org/smollm3'])
    expect(result.llm.huggingFace).toEqual([])
  })

  it('lists a browsed file once when two answers both carry it', () => {
    const result = catalog({ browsed: [hf('ggml-org/smollm3'), hf('ggml-org/smollm3')] })
    expect(ids(result.llm.huggingFace)).toEqual(['hf:ggml-org/smollm3'])
  })

  it('keeps on-this-Mac rows in list order and marks the selected one per kind', () => {
    const result = catalog({
      listed: [tested('whisper-small', 'stt', { state: 'installed' }), tested('whisper-medium', 'stt', { state: 'installed' })],
      selected: { stt: 'whisper-medium', llm: 'whisper-small' },
    })
    expect(result.stt.onThisMac.map(row => [row.model.id, row.selected])).toEqual([
      ['whisper-small', false],
      ['whisper-medium', true],
    ])
  })

  it('keeps a downloading model in its subgroup with its progress', () => {
    const result = catalog({
      listed: [tested('gemma-4-e4b', 'llm')],
      browsed: [hf('ggml-org/smollm3')],
      downloads: { 'gemma-4-e4b': { downloaded: 1, total: 4 }, 'hf:ggml-org/smollm3': { downloaded: 0, total: 9 } },
    })
    expect(result.llm.tested.map(row => [row.status, row.progress])).toEqual([['downloading', { downloaded: 1, total: 4 }]])
    expect(result.llm.huggingFace.map(row => row.status)).toEqual(['downloading'])
  })

  it('lists trusted publishers first, then the newest files first', () => {
    const result = catalog({
      browsed: [
        hf('old-trusted', { updatedAt: '2026-08-01T12:00:00Z' }),
        hf('new-unknown', { trusted: false, updatedAt: '2026-11-04T12:00:00Z' }),
        hf('undated-trusted', { updatedAt: null }),
        hf('new-trusted', { updatedAt: '2026-10-02T12:00:00Z' }),
      ],
    })
    expect(ids(result.llm.huggingFace)).toEqual(['hf:new-trusted', 'hf:old-trusted', 'hf:undated-trusted', 'hf:new-unknown'])
  })

  it('folds away models that need more memory than this Mac has, unless downloaded or downloading', () => {
    const result = catalog({
      listed: [
        tested('qwen3.5-9b', 'llm', { minRamGb: 32 }),
        tested('big-installed', 'llm', { minRamGb: 32, state: 'installed' }),
        tested('big-downloading', 'llm', { minRamGb: 32 }),
        tested('fits', 'llm', { minRamGb: 18 }),
      ],
      browsed: [hf('llama-70b', { trusted: false }, { minRamGb: 48 }), hf('granite', {}, { minRamGb: 8 })],
      downloads: { 'big-downloading': { downloaded: 1, total: 2 } },
    })
    expect(ids(result.llm.tooLarge)).toEqual(['qwen3.5-9b', 'hf:llama-70b'])
    expect(ids(result.llm.onThisMac)).toEqual(['big-installed'])
    expect(ids(result.llm.tested)).toEqual(['big-downloading', 'fits'])
    expect(ids(result.llm.huggingFace)).toEqual(['hf:granite'])
  })

  it('folds nothing until the hardware is known', () => {
    const result = catalog({ hardware: null, listed: [tested('qwen3.5-9b', 'llm', { minRamGb: 32 })] })
    expect(result.llm.tooLarge).toEqual([])
    expect(ids(result.llm.tested)).toEqual(['qwen3.5-9b'])
  })

  it('asks before downloading from a publisher Minute has not checked, and only before', () => {
    const result = catalog({
      listed: [hf('jdoe/installed', { trusted: false, publisher: 'jdoe' }, { state: 'installed' })],
      browsed: [hf('jdoe/llama', { trusted: false, publisher: 'jdoe' }), hf('ibm-granite/granite')],
    })
    const [trusted, unknown] = result.llm.huggingFace
    expect(unknown.unknownPublisher).toBe('jdoe')
    expect(unknown.fit).toMatchObject({ tone: 'unverified', label: 'Unknown publisher' })
    expect(trusted.unknownPublisher).toBeNull()
    expect(trusted.fit.label).toBe('Good fit')
    expect(result.llm.onThisMac[0].unknownPublisher).toBeNull()
    expect(result.llm.onThisMac[0].fit.label).toBe('Good fit')
  })

  it('never asks consent for a tested model and keeps Recommended on the tested pick', () => {
    const result = catalog({ listed: [tested('whisper-large-v3-turbo', 'stt')] })
    expect(result.stt.tested[0].unknownPublisher).toBeNull()
    expect(result.stt.tested[0].fit.label).toBe('Recommended')
  })
})

describe('formatAge', () => {
  it('says how long ago a list was fetched, in the largest whole unit', () => {
    expect(formatAge('2026-11-10T11:59:40Z', NOW)).toBe('just now')
    expect(formatAge('2026-11-10T11:48:00Z', NOW)).toBe('12 min ago')
    expect(formatAge('2026-11-10T09:30:00Z', NOW)).toBe('2 h ago')
    expect(formatAge('2026-11-07T12:00:00Z', NOW)).toBe('3 d ago')
    expect(formatAge('not a date', NOW)).toBeNull()
  })
})

describe('formatParameters', () => {
  it('writes counts the way model cards do', () => {
    expect(formatParameters(350_000_000)).toBe('350M')
    expect(formatParameters(3_000_000_000)).toBe('3B')
    expect(formatParameters(3_080_000_000)).toBe('3.1B')
    expect(formatParameters(70_550_000_000)).toBe('71B')
  })
})
