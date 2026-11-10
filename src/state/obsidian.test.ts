import { describe, expect, it } from 'vitest'
import type { NoteMeta } from '../ipc/types'
import { describeSavedAt, latestObsidianSave, previewObsidianPath, sanitizeFileName } from './obsidian'

describe('sanitizeFileName', () => {
  it('matches the Rust sanitizer', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(sanitizeFileName('Plan #1 [draft] ^x')).toBe('Plan -1 -draft- -x')
    expect(sanitizeFileName('  ..hidden  name.. ')).toBe('hidden name')
    expect(sanitizeFileName('tab\tand\nnewline')).toBe('tab and newline')
    expect(sanitizeFileName('///')).toBe('---')
    expect(sanitizeFileName('')).toBe('Untitled')
    expect(sanitizeFileName(' . ')).toBe('Untitled')
    expect(sanitizeFileName('x'.repeat(300))).toHaveLength(100)
  })
})

describe('previewObsidianPath', () => {
  it('renders the default template inside the folder', () => {
    expect(previewObsidianPath({ folder: 'Meetings', fileNameTemplate: '{date} - {title}' }, 'Aurora launch sync', '2026-11-09')).toBe(
      'Meetings/2026-11-09 - Aurora launch sync.md',
    )
  })

  it('sanitizes the title before it joins the template', () => {
    expect(previewObsidianPath({ folder: '', fileNameTemplate: '{title}' }, 'Weekly/Sync: Plan', '2026-11-09')).toBe('Weekly-Sync- Plan.md')
  })

  it('keeps unknown tokens and nests folders', () => {
    expect(previewObsidianPath({ folder: 'Work / Notes', fileNameTemplate: '{unknown} {date}' }, 'x', '2026-11-09')).toBe(
      'Work/Notes/{unknown} 2026-11-09.md',
    )
  })

  it('refuses a folder that leaves the vault', () => {
    expect(previewObsidianPath({ folder: '../out', fileNameTemplate: '{title}' }, 'x', '2026-11-09')).toBeNull()
  })
})

describe('latestObsidianSave', () => {
  const note = (title: string, savedAt?: string) => ({ title, obsidian: savedAt ? { savedAt } : undefined }) as NoteMeta

  it('picks the most recent save across notes', () => {
    expect(
      latestObsidianSave([note('Old', '2026-11-01T09:00:00Z'), note('New', '2026-11-08T09:00:00Z'), note('Never')]),
    ).toEqual({ title: 'New', savedAt: '2026-11-08T09:00:00Z' })
  })

  it('is null when nothing was saved', () => {
    expect(latestObsidianSave([note('Never')])).toBeNull()
  })
})

describe('describeSavedAt', () => {
  const now = new Date(2026, 10, 9, 12, 0)
  it('says today, yesterday, or the date', () => {
    expect(describeSavedAt(new Date(2026, 10, 9, 10, 31).toISOString(), now)).toBe('today at 10:31')
    expect(describeSavedAt(new Date(2026, 10, 8, 16, 5).toISOString(), now)).toBe('yesterday at 16:05')
    expect(describeSavedAt(new Date(2026, 10, 3, 9, 12).toISOString(), now)).toBe('Nov 3 at 09:12')
  })
})
