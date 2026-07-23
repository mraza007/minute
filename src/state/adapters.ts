// Pure mapping functions from IPC wire shapes (src/ipc/types.ts) to the UI
// shapes components render (src/types.ts). No side effects, no IPC calls —
// these exist so the state hook stays thin and so the mapping rules
// (grouping, byte formatting, sub-text per model state) are unit-testable
// in isolation.

import type { InstallState, ModelStatus, NoteMeta, Recommendation, TranscriptSegmentEvent } from '../ipc/types'
import type { NoteListItem } from '../types'

/** In-flight download progress for one model, assembled client-side from `model-download-progress` events. */
export interface DownloadProgressState {
  downloaded: number
  total: number
}

/** The Settings/Onboarding model card shape — a `ModelStatus` plus a precomputed sub-text line. */
export interface ModelCardInfo {
  id: string
  displayName: string
  desc: string
  sizeBytes: number
  state: InstallState
  inUse: boolean
  sub: string
  progressPercent?: number
}

function startOfUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Today / Yesterday / Last week / <Month name> — bucketed off whole UTC
 * calendar days (not wall-clock 24h windows) so a note from 11pm yesterday
 * and one from 1am today both land correctly regardless of what time "now"
 * is. UTC (rather than local) keeps the boundary deterministic in tests
 * independent of the machine's timezone.
 */
function noteGroup(createdAt: Date, now: Date): string {
  const diffDays = Math.round((startOfUTCDay(now) - startOfUTCDay(createdAt)) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'Last week'
  return createdAt.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
}

/** Maps one stored note's metadata to the sidebar row shape. */
export function noteMetaToListItem(meta: NoteMeta, now: Date): NoteListItem {
  const createdAt = new Date(meta.createdAt)
  const minutes = Math.round(meta.durationSec / 60)
  const speakersPart = meta.speakers > 1 ? ` · ${meta.speakers} speakers` : ''
  return {
    title: meta.title,
    meta: `${minutes} min${speakersPart}`,
    group: noteGroup(createdAt, now),
  }
}

/**
 * Maps a full note list to sidebar rows, suppressing the `group` label on
 * every row after the first in a run of consecutive same-group notes (the
 * sidebar only renders a header when `group` is set) — mirrors how the
 * Stage 1 mock data was hand-authored (one header per section, not per row).
 * Notes are expected pre-sorted newest-first (as `list_notes` returns them),
 * so consecutive same-group notes are always adjacent.
 */
export function notesToSidebarItems(notes: NoteMeta[], now: Date): NoteListItem[] {
  let prevGroup: string | undefined
  return notes.map(meta => {
    const item = noteMetaToListItem(meta, now)
    if (item.group === prevGroup) {
      return { ...item, group: undefined }
    }
    prevGroup = item.group
    return item
  })
}

/** `n` bytes as a short human label — "466 MB" under 1 GB, "2.5 GB" at or above (decimal/SI, matching macOS Finder). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    const gb = Math.round((bytes / 1_000_000_000) * 10) / 10
    const label = Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1)
    return `${label} GB`
  }
  const mb = Math.round(bytes / 1_000_000)
  return `${mb} MB`
}

/**
 * Maps one catalog entry's install state to the Settings/Onboarding card
 * sub-text. A `downloads` entry for this model wins over `m.state` even if
 * `m.state` itself hasn't been refreshed from the backend yet — the
 * progress-event stream is the more current, live signal while a download
 * is actually in flight (see useAppState's `downloadModel`, which sets a
 * `downloads` entry optimistically before the next `list_models` refetch).
 */
export function modelStatusToSttInfo(
  m: ModelStatus,
  inUseId: string,
  downloads: Record<string, DownloadProgressState>,
): ModelCardInfo {
  const inUse = m.id === inUseId
  const progress = downloads[m.id]

  if (progress) {
    const progressPercent = progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : 0
    return {
      id: m.id,
      displayName: m.displayName,
      desc: m.desc,
      sizeBytes: m.sizeBytes,
      state: 'downloading',
      inUse,
      sub: `Downloading ${progressPercent}%`,
      progressPercent,
    }
  }

  if (m.state === 'installed') {
    return {
      id: m.id,
      displayName: m.displayName,
      desc: m.desc,
      sizeBytes: m.sizeBytes,
      state: 'installed',
      inUse,
      sub: inUse ? 'Installed · in use' : 'Installed',
    }
  }

  return {
    id: m.id,
    displayName: m.displayName,
    desc: m.desc,
    sizeBytes: m.sizeBytes,
    state: 'notInstalled',
    inUse,
    sub: `Not downloaded · ${formatBytes(m.sizeBytes)}`,
  }
}

/**
 * Picks the STT model id to preselect on load: the recommended model if
 * it's actually installed, else the first installed STT model, else the
 * bare recommendation id as a placeholder (e.g. pre-onboarding, when
 * nothing is installed yet and the value is only used to pre-select the
 * onboarding card).
 */
export function pickInitialSttModel(models: ModelStatus[], recommendation: Recommendation): string {
  const installedStt = models.filter(m => m.kind === 'stt' && m.state === 'installed')
  const recommendedInstalled = installedStt.find(m => m.id === recommendation.stt)
  return recommendedInstalled?.id ?? installedStt[0]?.id ?? recommendation.stt ?? ''
}

/**
 * Display name for a catalog model id — falls back to the bare id itself
 * when it isn't (yet) present in the loaded `models` list (e.g. briefly
 * between mount and the first `list_models` resolving).
 */
export function modelDisplayName(models: ModelStatus[], id: string): string {
  return models.find(m => m.id === id)?.displayName ?? id
}

/** `n` (possibly fractional) seconds as `mm:ss`, floored to whole seconds and clamped at zero — the REC-pill / live-transcript timestamp format. */
export function formatMmSs(totalSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(totalSeconds))
  const mm = Math.floor(wholeSeconds / 60)
  const ss = wholeSeconds % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** One row of the live-transcript display: consecutive same-speaker segments merged into a single entry. */
export interface LiveTranscriptGroup {
  speaker: string
  /** Stream-time (seconds) of the first segment in this group. */
  start: number
  /** Stream-time (seconds) of the last segment in this group. */
  end: number
  text: string
}

/**
 * Groups a flat, arrival-ordered list of `transcript-segment` event
 * payloads into display rows: consecutive segments from the same speaker
 * merge into one row (`text` joined with a space, `start` kept from the
 * first segment in the run, `end` extended to the last), while any change
 * in speaker — even back to one seen earlier — always starts a fresh row
 * rather than re-merging into a non-adjacent earlier group. Pure and
 * side-effect free: callers own updating a note's live segment buffer and
 * re-derive this on every append.
 */
export function groupLiveSegments(segments: TranscriptSegmentEvent[]): LiveTranscriptGroup[] {
  return segments.reduce<LiveTranscriptGroup[]>((groups, seg) => {
    const last = groups[groups.length - 1]
    if (last && last.speaker === seg.speaker) {
      return [...groups.slice(0, -1), { ...last, end: seg.end, text: `${last.text} ${seg.text}` }]
    }
    return [...groups, { speaker: seg.speaker, start: seg.start, end: seg.end, text: seg.text }]
  }, [])
}
