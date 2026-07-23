import { describe, expect, it } from 'vitest'
import type { NoteMeta, StoredSegment } from '../ipc/types'
import { noteToMarkdown } from './noteToMarkdown'

function meta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260521-140000',
    title: 'Client call — Acme',
    createdAt: '2026-05-21T14:00:00.000Z',
    durationSec: 48 * 60,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 4,
    ...overrides,
  }
}

describe('noteToMarkdown', () => {
  it('renders the full template shape for a note with segments', () => {
    const segments: StoredSegment[] = [
      { speaker: 'Speaker 1', start: 41, end: 62, text: 'Thanks for making time.' },
      { speaker: 'Speaker 1', start: 94, end: 110, text: "Short answer: nowhere." },
    ]

    const markdown = noteToMarkdown(meta(), segments)

    expect(markdown).toBe(
      `# Client call — Acme

**Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4

## Transcript

**Speaker 1** (00:41)
Thanks for making time.

**Speaker 1** (01:34)
Short answer: nowhere.`,
    )
  })

  it('renders a "No speech detected." placeholder for an empty transcript', () => {
    const markdown = noteToMarkdown(meta(), [])

    expect(markdown).toBe(
      `# Client call — Acme

**Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4

## Transcript

_No speech detected._`,
    )
  })

  it('formats the date from createdAt as "Month D, YYYY"', () => {
    const markdown = noteToMarkdown(meta({ createdAt: '2026-01-03T09:00:00.000Z' }), [])
    expect(markdown).toContain('**Date:** January 3, 2026')
  })

  it('rounds duration to whole minutes and reports the speaker count as-is', () => {
    const markdown = noteToMarkdown(meta({ durationSec: 95, speakers: 1 }), [])
    expect(markdown).toContain('**Duration:** 2 min · **Speakers:** 1')
  })
})
