import { describe, expect, it } from 'vitest'
import type { ModelStatus, NoteMeta, Recommendation, StoredSegment, TranscriptSegmentEvent } from '../ipc/types'
import {
  formatBytes,
  formatMmSs,
  groupLiveSegments,
  modelDisplayName,
  modelStatusToSttInfo,
  noteMetaToListItem,
  notesToSidebarItems,
  pickInitialLlmModel,
  pickInitialSttModel,
  speakerInitials,
  storedSegmentsToDisplay,
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

  it('formats sub-KB sizes as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(80)).toBe('80 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('formats sub-MB sizes as KB with one decimal, trimmed when whole', () => {
    expect(formatBytes(1_000)).toBe('1 KB')
    expect(formatBytes(4_200)).toBe('4.2 KB')
    expect(formatBytes(999_000)).toBe('999 KB')
  })
})

describe('speakerInitials', () => {
  it('derives initials from a "Speaker N" placeholder label', () => {
    expect(speakerInitials('Speaker 1')).toBe('S1')
    expect(speakerInitials('Speaker 12')).toBe('S12')
  })

  it('derives initials from a two-word human name', () => {
    expect(speakerInitials('Priya Shah')).toBe('PS')
  })

  it('derives initials from a single-word label by taking its first two letters', () => {
    expect(speakerInitials('Unknown')).toBe('UN')
  })

  it('falls back to "?" for an empty/blank label', () => {
    expect(speakerInitials('')).toBe('?')
    expect(speakerInitials('   ')).toBe('?')
  })
})

describe('storedSegmentsToDisplay', () => {
  it('maps speaker/text through and derives initials + mm:ss time from start', () => {
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 3.2, text: 'Hello there.' },
      { speaker: 'Speaker 1', start: 41, end: 45, text: 'Second segment.' },
    ]
    expect(storedSegmentsToDisplay(segments)).toEqual([
      { initials: 'S1', speaker: 'Speaker 1', time: '00:00', text: 'Hello there.' },
      { initials: 'S1', speaker: 'Speaker 1', time: '00:41', text: 'Second segment.' },
    ])
  })

  it('never sets isMe or highlight — real segments render neutral', () => {
    const [display] = storedSegmentsToDisplay([{ speaker: 'Speaker 1', start: 0, end: 1, text: 'Hi' }])
    expect(display.isMe).toBeUndefined()
    expect(display.highlight).toBeUndefined()
  })

  it('does not merge consecutive same-speaker segments — each stored segment renders as its own row', () => {
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 0, end: 1, text: 'First.' },
      { speaker: 'Speaker 1', start: 1, end: 2, text: 'Second.' },
    ]
    expect(storedSegmentsToDisplay(segments)).toHaveLength(2)
  })

  it('returns an empty array for an empty transcript', () => {
    expect(storedSegmentsToDisplay([])).toEqual([])
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

  it('prefers a persisted settings.sttModel over the recommendation when both are installed', () => {
    const models = [
      model({ id: 'whisper-small', state: 'installed' }),
      model({ id: 'whisper-medium', state: 'installed' }),
    ]
    expect(pickInitialSttModel(models, recommendation, 'whisper-medium')).toBe('whisper-medium')
  })

  it('falls back past a persisted settings.sttModel that is not installed', () => {
    const models = [
      model({ id: 'whisper-small', state: 'installed' }),
      model({ id: 'whisper-medium', state: 'notInstalled' }),
    ]
    expect(pickInitialSttModel(models, recommendation, 'whisper-medium')).toBe('whisper-small')
  })

  it('falls back to the existing rule when no preferred id is given', () => {
    const models = [model({ id: 'whisper-small', state: 'installed' })]
    expect(pickInitialSttModel(models, recommendation, null)).toBe('whisper-small')
  })
})

describe('pickInitialLlmModel', () => {
  const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }

  function llmModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
    return model({ id: 'qwen3.5-4b', kind: 'llm', ...overrides })
  }

  it('prefers a persisted settings.llmModel over the recommendation when both are installed', () => {
    const models = [llmModel({ id: 'qwen3.5-4b', state: 'installed' }), llmModel({ id: 'gemma-4-e4b', state: 'installed' })]
    expect(pickInitialLlmModel(models, recommendation, 'gemma-4-e4b')).toBe('gemma-4-e4b')
  })

  it('falls back past a persisted settings.llmModel that is not installed', () => {
    const models = [llmModel({ id: 'qwen3.5-4b', state: 'installed' }), llmModel({ id: 'gemma-4-e4b', state: 'notInstalled' })]
    expect(pickInitialLlmModel(models, recommendation, 'gemma-4-e4b')).toBe('qwen3.5-4b')
  })

  it('falls back to the recommended LLM when it is installed and nothing is preferred', () => {
    const models = [llmModel({ id: 'qwen3.5-4b', state: 'installed' })]
    expect(pickInitialLlmModel(models, recommendation)).toBe('qwen3.5-4b')
  })

  it('returns null when nothing is installed and nothing is preferred', () => {
    const models = [llmModel({ id: 'qwen3.5-4b', state: 'notInstalled' })]
    expect(pickInitialLlmModel(models, recommendation)).toBeNull()
  })

  it('ignores STT entries when picking an LLM model', () => {
    const models = [
      model({ id: 'whisper-small', kind: 'stt', state: 'installed' }),
      llmModel({ id: 'gemma-4-e4b', state: 'installed' }),
    ]
    expect(pickInitialLlmModel(models, recommendation, 'gemma-4-e4b')).toBe('gemma-4-e4b')
  })
})

describe('modelDisplayName', () => {
  it('returns the display name for a known model id', () => {
    const models = [model({ id: 'whisper-small', displayName: 'Whisper small' })]
    expect(modelDisplayName(models, 'whisper-small')).toBe('Whisper small')
  })

  it('falls back to the bare id when the model is not (yet) in the loaded catalog', () => {
    expect(modelDisplayName([], 'whisper-small')).toBe('whisper-small')
  })
})

describe('formatMmSs', () => {
  it('formats whole seconds as mm:ss, zero-padded', () => {
    expect(formatMmSs(0)).toBe('00:00')
    expect(formatMmSs(5)).toBe('00:05')
    expect(formatMmSs(65)).toBe('01:05')
    expect(formatMmSs(3661)).toBe('61:01')
  })

  it('floors fractional seconds', () => {
    expect(formatMmSs(59.9)).toBe('00:59')
  })

  it('clamps negative values to zero', () => {
    expect(formatMmSs(-5)).toBe('00:00')
  })
})

function segEvent(overrides: Partial<TranscriptSegmentEvent> = {}): TranscriptSegmentEvent {
  return {
    noteId: '20260722-120000',
    speaker: 'Speaker 1',
    start: 0,
    end: 1,
    text: 'hello',
    ...overrides,
  }
}

describe('groupLiveSegments', () => {
  it('returns an empty array for no segments', () => {
    expect(groupLiveSegments([])).toEqual([])
  })

  it('keeps a single segment as its own group', () => {
    const groups = groupLiveSegments([segEvent({ start: 0, end: 1, text: 'hello' })])
    expect(groups).toEqual([{ speaker: 'Speaker 1', start: 0, end: 1, text: 'hello' }])
  })

  it('merges consecutive same-speaker segments into one group with a joined-text and extended end', () => {
    const groups = groupLiveSegments([
      segEvent({ speaker: 'Speaker 1', start: 0, end: 2, text: 'Hello there' }),
      segEvent({ speaker: 'Speaker 1', start: 2, end: 4, text: 'how are you' }),
    ])
    expect(groups).toEqual([{ speaker: 'Speaker 1', start: 0, end: 4, text: 'Hello there how are you' }])
  })

  it('starts a new group when the speaker changes', () => {
    const groups = groupLiveSegments([
      segEvent({ speaker: 'Speaker 1', start: 0, end: 2, text: 'first' }),
      segEvent({ speaker: 'Speaker 2', start: 2, end: 4, text: 'second' }),
    ])
    expect(groups).toEqual([
      { speaker: 'Speaker 1', start: 0, end: 2, text: 'first' },
      { speaker: 'Speaker 2', start: 2, end: 4, text: 'second' },
    ])
  })

  it('handles speaker A -> B -> A as three separate groups (does not re-merge into the earlier A group)', () => {
    const groups = groupLiveSegments([
      segEvent({ speaker: 'Speaker 1', start: 0, end: 1, text: 'a1' }),
      segEvent({ speaker: 'Speaker 2', start: 1, end: 2, text: 'b1' }),
      segEvent({ speaker: 'Speaker 1', start: 2, end: 3, text: 'a2' }),
    ])
    expect(groups.map(g => g.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1'])
    expect(groups[2]).toEqual({ speaker: 'Speaker 1', start: 2, end: 3, text: 'a2' })
  })

  it('keeps the first segment start when merging a run of more than two', () => {
    const groups = groupLiveSegments([
      segEvent({ speaker: 'Speaker 1', start: 0, end: 1, text: 'one' }),
      segEvent({ speaker: 'Speaker 1', start: 1, end: 2, text: 'two' }),
      segEvent({ speaker: 'Speaker 1', start: 2, end: 3, text: 'three' }),
    ])
    expect(groups).toEqual([{ speaker: 'Speaker 1', start: 0, end: 3, text: 'one two three' }])
  })
})
