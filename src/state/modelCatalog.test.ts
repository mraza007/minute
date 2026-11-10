import { describe, expect, it } from 'vitest'
import type { ModelOrigin, ModelStatus } from '../ipc/types'
import { formatParameters, modelDetail } from './modelCatalog'

const NOW = new Date('2026-11-10T12:00:00Z')

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

describe('formatParameters', () => {
  it('writes counts the way model cards do', () => {
    expect(formatParameters(350_000_000)).toBe('350M')
    expect(formatParameters(3_000_000_000)).toBe('3B')
    expect(formatParameters(3_080_000_000)).toBe('3.1B')
    expect(formatParameters(70_550_000_000)).toBe('71B')
  })
})
