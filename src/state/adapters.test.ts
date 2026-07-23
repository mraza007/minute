import { describe, expect, it } from 'vitest'
import type { ModelStatus, NoteMeta, Recommendation } from '../ipc/types'
import {
  formatBytes,
  modelStatusToSttInfo,
  noteMetaToListItem,
  notesToSidebarItems,
  pickInitialSttModel,
} from './adapters'

function meta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260722-120000',
    title: 'Client call — Acme',
    createdAt: '2026-07-22T12:00:00.000Z',
    durationSec: 600,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 1,
    ...overrides,
  }
}

function model(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    desc: '62× realtime · good for meetings',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: 'a'.repeat(64),
    sizeBytes: 466_000_000,
    minRamGb: 0,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

describe('noteMetaToListItem', () => {
  const now = new Date('2026-07-23T15:00:00.000Z')

  it('groups a note created earlier today as Today', () => {
    const item = noteMetaToListItem(meta({ createdAt: '2026-07-23T09:00:00.000Z' }), now)
    expect(item.group).toBe('Today')
  })

  it('groups a note created one calendar day ago as Yesterday', () => {
    const item = noteMetaToListItem(meta({ createdAt: '2026-07-22T23:00:00.000Z' }), now)
    expect(item.group).toBe('Yesterday')
  })

  it('groups a note 2-6 calendar days ago as Last week', () => {
    expect(noteMetaToListItem(meta({ createdAt: '2026-07-21T09:00:00.000Z' }), now).group).toBe('Last week')
    expect(noteMetaToListItem(meta({ createdAt: '2026-07-17T09:00:00.000Z' }), now).group).toBe('Last week')
  })

  it('groups a note 7+ calendar days ago by month name', () => {
    const item = noteMetaToListItem(meta({ createdAt: '2026-06-30T09:00:00.000Z' }), now)
    expect(item.group).toBe('June')
  })

  it('rounds duration to the nearest minute', () => {
    expect(noteMetaToListItem(meta({ durationSec: 90 }), now).meta).toBe('2 min')
    expect(noteMetaToListItem(meta({ durationSec: 65 }), now).meta).toBe('1 min')
    expect(noteMetaToListItem(meta({ durationSec: 29 }), now).meta).toBe('0 min')
  })

  it('appends speaker count only when more than one speaker', () => {
    expect(noteMetaToListItem(meta({ speakers: 1 }), now).meta).toBe('10 min')
    expect(noteMetaToListItem(meta({ speakers: 4 }), now).meta).toBe('10 min · 4 speakers')
  })
})

describe('notesToSidebarItems', () => {
  const now = new Date('2026-07-23T15:00:00.000Z')

  it('keeps the group label only on the first note of each consecutive run', () => {
    const notes = [
      meta({ id: 'a', createdAt: '2026-07-23T09:00:00.000Z' }), // Today
      meta({ id: 'b', createdAt: '2026-07-23T08:00:00.000Z' }), // Today
      meta({ id: 'c', createdAt: '2026-07-22T09:00:00.000Z' }), // Yesterday
    ]
    const items = notesToSidebarItems(notes, now)
    expect(items[0].group).toBe('Today')
    expect(items[1].group).toBeUndefined()
    expect(items[2].group).toBe('Yesterday')
  })

  it('returns an empty array for an empty note list', () => {
    expect(notesToSidebarItems([], now)).toEqual([])
  })
})

describe('formatBytes', () => {
  it('formats sub-GB sizes as rounded MB', () => {
    expect(formatBytes(466_000_000)).toBe('466 MB')
    expect(formatBytes(1_000_000)).toBe('1 MB')
  })

  it('formats GB-and-above sizes with one decimal, trimmed when whole', () => {
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB')
    expect(formatBytes(1_000_000_000)).toBe('1 GB')
    expect(formatBytes(5_335_291_936)).toBe('5.3 GB')
  })
})

describe('modelStatusToSttInfo', () => {
  it('notInstalled → "Not downloaded · X GB/MB"', () => {
    const info = modelStatusToSttInfo(model({ state: 'notInstalled', sizeBytes: 466_000_000 }), '', {})
    expect(info.sub).toBe('Not downloaded · 466 MB')
    expect(info.state).toBe('notInstalled')
    expect(info.inUse).toBe(false)
  })

  it('downloading → "Downloading n%" computed from the downloads map', () => {
    const info = modelStatusToSttInfo(model({ state: 'downloading' }), '', {
      'whisper-small': { downloaded: 233_000_000, total: 466_000_000 },
    })
    expect(info.sub).toBe('Downloading 50%')
    expect(info.state).toBe('downloading')
    expect(info.progressPercent).toBe(50)
  })

  it('installed and not in use → "Installed"', () => {
    const info = modelStatusToSttInfo(model({ state: 'installed' }), 'whisper-medium', {})
    expect(info.sub).toBe('Installed')
    expect(info.inUse).toBe(false)
  })

  it('installed and in use → "Installed · in use"', () => {
    const info = modelStatusToSttInfo(model({ state: 'installed' }), 'whisper-small', {})
    expect(info.sub).toBe('Installed · in use')
    expect(info.inUse).toBe(true)
  })

  it('a live downloads entry wins over a stale "installed" ModelStatus', () => {
    const info = modelStatusToSttInfo(model({ state: 'installed' }), '', {
      'whisper-small': { downloaded: 100, total: 200 },
    })
    expect(info.state).toBe('downloading')
    expect(info.sub).toBe('Downloading 50%')
  })

  it('reports 0% when total is not yet known', () => {
    const info = modelStatusToSttInfo(model({ state: 'downloading' }), '', {
      'whisper-small': { downloaded: 0, total: 0 },
    })
    expect(info.sub).toBe('Downloading 0%')
  })
})

describe('pickInitialSttModel', () => {
  const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }

  it('prefers the recommended model when it is installed', () => {
    const models = [model({ id: 'whisper-small', state: 'installed' }), model({ id: 'whisper-medium', state: 'installed' })]
    expect(pickInitialSttModel(models, recommendation)).toBe('whisper-small')
  })

  it('falls back to the first installed STT model when the recommendation is not installed', () => {
    const models = [
      model({ id: 'whisper-small', state: 'notInstalled' }),
      model({ id: 'whisper-medium', state: 'installed' }),
    ]
    expect(pickInitialSttModel(models, recommendation)).toBe('whisper-medium')
  })

  it('falls back to the bare recommendation id when nothing is installed', () => {
    const models = [model({ id: 'whisper-small', state: 'notInstalled' })]
    expect(pickInitialSttModel(models, recommendation)).toBe('whisper-small')
  })

  it('ignores LLM entries when picking an STT model', () => {
    const models = [
      model({ id: 'qwen3.5-4b', kind: 'llm', state: 'installed' }),
      model({ id: 'whisper-medium', kind: 'stt', state: 'installed' }),
    ]
    expect(pickInitialSttModel(models, recommendation)).toBe('whisper-medium')
  })
})
