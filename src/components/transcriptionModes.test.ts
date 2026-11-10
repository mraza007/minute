import type { Hardware, ModelStatus } from '../ipc/types'
import { transcriptionModeOf, transcriptionModeOptions } from './transcriptionModes'

function stt(id: string, displayName: string, state: ModelStatus['state'], minRamGb = 0): ModelStatus {
  return { id, kind: 'stt', displayName, traits: [], origin: { kind: 'tested' }, url: '', sha256: '', sizeBytes: 1, minRamGb, requiresAppleSilicon: false, state }
}

const models: ModelStatus[] = [
  stt('whisper-small', 'Whisper small', 'installed'),
  stt('whisper-medium', 'Whisper medium', 'notInstalled', 16),
  stt('whisper-large-v3-turbo', 'Whisper large-v3-turbo', 'installed', 16),
  { ...stt('qwen', 'Qwen small', 'installed'), kind: 'llm' },
]
const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 10 }
const recommendation = { stt: 'whisper-small', llm: 'qwen' }

describe('transcriptionModeOf', () => {
  it('reads the tier from the model name', () => {
    expect(transcriptionModeOf('Whisper small')).toBe('fast')
    expect(transcriptionModeOf('Whisper medium')).toBe('balanced')
    expect(transcriptionModeOf('Whisper large-v3-turbo')).toBe('accurate')
  })

  it('counts tiny and base models as fast, whatever their suffix', () => {
    expect(transcriptionModeOf('Whisper tiny, English (q5_1)')).toBe('fast')
    expect(transcriptionModeOf('Whisper base, compressed (q5_1)')).toBe('fast')
    expect(transcriptionModeOf('Whisper medium, compact')).toBe('balanced')
    expect(transcriptionModeOf('Whisper large-v3, compact')).toBe('accurate')
  })
})

describe('transcriptionModeOptions', () => {
  const options = transcriptionModeOptions(models, 'whisper-small', hardware, recommendation)

  it('offers Fast, Balanced, and Most accurate in that order, from transcription models only', () => {
    expect(options.map(option => [option.label, option.modelName])).toEqual([
      ['Fast', 'Whisper small'],
      ['Balanced', 'Whisper medium'],
      ['Most accurate', 'Whisper large-v3-turbo'],
    ])
  })

  it('marks the model in use and which modes can be chosen', () => {
    expect(options.map(option => [option.mode, option.selected, option.installed])).toEqual([
      ['fast', true, true],
      ['balanced', false, false],
      ['accurate', false, true],
    ])
  })

  it('says how each model fits this Mac', () => {
    expect(options.map(option => option.fit)).toEqual([
      'recommended for this Mac',
      'near the memory limit of this Mac',
      'near the memory limit of this Mac',
    ])
  })

  it('says nothing about fit while the hardware is unknown', () => {
    expect(transcriptionModeOptions(models, 'whisper-small', null, recommendation)[0].fit).toBeNull()
  })

  it('keeps a mode with no model in the catalog visible but not choosable', () => {
    const [fast, balanced] = transcriptionModeOptions([models[0]], 'whisper-small', hardware, recommendation)
    expect(fast.selected).toBe(true)
    expect(balanced).toMatchObject({ modelId: null, installed: false, selected: false })
  })
})
