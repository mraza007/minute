import type { NoteMeta, ObsidianSettings } from '../ipc/types'

/** Mirrors `settings::ObsidianSettings::default()` on the Rust side. */
export const DEFAULT_OBSIDIAN_SETTINGS: ObsidianSettings = {
  enabled: false,
  vaultPath: '',
  folder: 'Meetings',
  fileNameTemplate: '{date} - {title}',
  addProperties: true,
  includeTranscript: false,
}

const MAX_FILE_STEM_CHARS = 100

/** Mirrors `obsidian::sanitize_file_name`, so the preview shows the name Minute will write. */
export function sanitizeFileName(raw: string): string {
  const replaced = Array.from(raw)
    // eslint-disable-next-line no-control-regex
    .filter(c => /\s/.test(c) || !/[\u0000-\u001f\u007f-\u009f]/.test(c))
    .map(c => (/[/\\:*?"<>|#^[\]]/.test(c) ? '-' : c))
    .join('')
  const collapsed = replaced.split(/\s+/).filter(Boolean).join(' ')
  const capped = Array.from(collapsed).slice(0, MAX_FILE_STEM_CHARS).join('')
  const trimmed = capped.replace(/^[.\s]+|[.\s]+$/g, '')
  return trimmed === '' ? 'Untitled' : trimmed
}

/** Mirrors `obsidian::folder_segments`; `null` when the folder tries to leave the vault. */
function folderSegments(folder: string): string[] | null {
  const out: string[] = []
  for (const raw of folder.split(/[/\\]/)) {
    const part = raw.trim()
    if (part === '' || part === '.') continue
    if (part === '..') return null
    out.push(sanitizeFileName(part))
  }
  return out
}

/** The local calendar day of `at` as `YYYY-MM-DD`: the `{date}` Minute writes into a saved file's name. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** Where a note called `title`, made on `date` (`YYYY-MM-DD`), would land inside the vault. `null` for an unusable folder. */
export function previewObsidianPath(settings: Pick<ObsidianSettings, 'folder' | 'fileNameTemplate'>, title: string, date: string): string | null {
  const segments = folderSegments(settings.folder)
  if (segments === null) return null
  const stem = sanitizeFileName(
    settings.fileNameTemplate.replaceAll('{date}', date).replaceAll('{title}', sanitizeFileName(title)),
  )
  return [...segments, `${stem}.md`].join('/')
}

/** The note whose Obsidian copy was written last, for Settings' "Last saved" line. */
export function latestObsidianSave(notes: readonly NoteMeta[]): { title: string; savedAt: string } | null {
  let latest: { title: string; savedAt: string } | null = null
  for (const note of notes) {
    const savedAt = note.obsidian?.savedAt
    if (!savedAt || Number.isNaN(Date.parse(savedAt))) continue
    if (latest === null || Date.parse(savedAt) > Date.parse(latest.savedAt)) latest = { title: note.title, savedAt }
  }
  return latest
}

/** "today at 10:31", "yesterday at 16:05", or "Nov 3 at 09:12" — in local time. */
export function describeSavedAt(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (daysAgo === 0) return `today at ${time}`
  if (daysAgo === 1) return `yesterday at ${time}`
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`
}
