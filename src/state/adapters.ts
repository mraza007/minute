// Pure mapping functions from IPC wire shapes (src/ipc/types.ts) to the UI
// shapes components render (src/types.ts). No side effects, no IPC calls —
// these exist so the state hook stays thin and so the mapping rules
// (grouping, byte formatting, sub-text per model state) are unit-testable
// in isolation.

import type { InstallState, ModelStatus, NoteMeta, Recommendation, SpeakerSuggestion, StoredSegment, SummaryDoc, SummaryStatusEvent, TranscriptSegmentEvent } from '../ipc/types'
import type { NoteListItem, TranscriptSegment } from '../types'

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

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

/** The calendar date `d` falls on in `timeZone`, as whole days since the epoch. */
function calendarDay(d: Date, timeZone: string): number {
  let formatter = dayFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    dayFormatters.set(timeZone, formatter)
  }
  const parts: Record<string, number> = {}
  for (const part of formatter.formatToParts(d)) parts[part.type] = Number(part.value)
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000
}

function systemTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Today / Yesterday / Last week / <Month name> — bucketed off whole
 * calendar days in the reader's time zone, not wall-clock 24h windows and
 * not UTC days: a meeting at 5:30 pm in Los Angeles is already "tomorrow"
 * in UTC, so UTC buckets showed it under Today for the whole next day
 * (issue #44).
 */
function noteGroup(createdAt: Date, now: Date, timeZone: string): string {
  // `formatToParts` throws on an invalid date; keep the label the sidebar
  // showed for one before.
  if (Number.isNaN(createdAt.getTime())) return 'Invalid Date'
  const diffDays = calendarDay(now, timeZone) - calendarDay(createdAt, timeZone)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'Last week'
  return createdAt.toLocaleString('en-US', { month: 'long', timeZone })
}

/** Maps one stored note's metadata to the sidebar row shape. `timeZone` defaults to the system zone. */
export function noteMetaToListItem(meta: NoteMeta, now: Date, timeZone: string = systemTimeZone()): NoteListItem {
  const createdAt = new Date(meta.createdAt)
  const minutes = Math.round(meta.durationSec / 60)
  const speakersPart = meta.speakers > 1 ? ` · ${meta.speakers} speakers` : ''
  return {
    id: meta.id,
    title: meta.title,
    meta: `${minutes} min${speakersPart}`,
    group: noteGroup(createdAt, now, timeZone),
    status: meta.status,
    sources: meta.sources,
    createdAt: meta.createdAt,
    pinned: meta.pinned ?? false,
    hasSummary: meta.hasSummary ?? false,
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
export function notesToSidebarItems(notes: NoteMeta[], now: Date, timeZone: string = systemTimeZone()): NoteListItem[] {
  let prevGroup: string | undefined
  return notes.map(meta => {
    const item = noteMetaToListItem(meta, now, timeZone)
    if (item.group === prevGroup) {
      return { ...item, group: undefined }
    }
    prevGroup = item.group
    return item
  })
}

/**
 * `n` bytes as a short human label (decimal/SI, matching macOS Finder):
 * whole bytes under 1 KB, one-decimal KB under 1 MB (trimmed when whole),
 * rounded MB under 1 GB, one-decimal GB at or above (trimmed when whole).
 * The KB/B tiers exist for small values like a markdown export's byte size
 * (the note menu's size labels) — the MB/GB tiers are what model/storage sizes
 * actually exercise.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    const gb = Math.round((bytes / 1_000_000_000) * 10) / 10
    const label = Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1)
    return `${label} GB`
  }
  if (bytes >= 1_000_000) {
    const mb = Math.round(bytes / 1_000_000)
    return `${mb} MB`
  }
  if (bytes >= 1_000) {
    const kb = Math.round((bytes / 1_000) * 10) / 10
    const label = Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)
    return `${label} KB`
  }
  return `${bytes} B`
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
 * Picks the STT model id to preselect on load: the persisted
 * `settings.sttModel` (`preferredId`) if it's actually installed, else the
 * recommended model if it's installed, else the first installed STT model,
 * else the bare recommendation id as a placeholder (e.g. pre-onboarding,
 * when nothing is installed yet and the value is only used to pre-select
 * the onboarding card).
 */
export function pickInitialSttModel(
  models: ModelStatus[],
  recommendation: Recommendation,
  preferredId?: string | null,
): string {
  const installedStt = models.filter(m => m.kind === 'stt' && m.state === 'installed')
  if (preferredId) {
    const preferred = installedStt.find(m => m.id === preferredId)
    if (preferred) return preferred.id
  }
  const recommendedInstalled = installedStt.find(m => m.id === recommendation.stt)
  return recommendedInstalled?.id ?? installedStt[0]?.id ?? recommendation.stt ?? ''
}

/**
 * Picks the LLM (summary) model id to preselect on load: the persisted
 * `settings.llmModel` (`preferredId`) if it's actually installed, else the
 * recommended LLM if it's installed, else `null` — unlike
 * `pickInitialSttModel`, there's no "first installed" fallback and no
 * placeholder id.
 *
 * The backend's `catalog::resolve_llm_entry` (src-tauri/src/catalog.rs)
 * mirrors this rule exactly for summarize/ask — if either side's fallback
 * changes, the other must change with it, or Settings will display a model
 * as "in use" that the backend refuses to run (issue #2).
 */
export function pickInitialLlmModel(
  models: ModelStatus[],
  recommendation: Recommendation,
  preferredId?: string | null,
): string | null {
  const installedLlm = models.filter(m => m.kind === 'llm' && m.state === 'installed')
  if (preferredId) {
    const preferred = installedLlm.find(m => m.id === preferredId)
    if (preferred) return preferred.id
  }
  const recommendedInstalled = installedLlm.find(m => m.id === recommendation.llm)
  return recommendedInstalled?.id ?? null
}

/**
 * Whether a loaded `SummaryDoc` actually has something to show — any prose
 * summary, any decision, or any action item.
 *
 * Exists because "a summary object came back from `get_note`" is not the
 * same question as "this note has a summary", and the UI cares about the
 * second one. Every recovery affordance is gated on the note having *no*
 * summary (`NoteSummary`'s "Generate summary") or on an explicit error
 * status (its "Retry summary"). A note carrying a present-but-empty `SummaryDoc`
 * satisfies neither condition, so before this predicate it rendered a blank
 * Summary section with no way to re-run it at all — issue #13.
 *
 * `run_summarize` no longer persists an empty result (see
 * `require_nonempty_summary` in src-tauri/src/llm.rs), but that only stops
 * *new* notes from reaching that state; notes summarized before that guard
 * are already on disk as status `ready` with an empty doc, and this is what
 * gets them their Generate button back.
 *
 * Stricter than the backend guard on one point: a whitespace-only summary
 * counts as empty here. The backend asks "did the model return anything at
 * all", this asks "will the user see anything", and a summary of `"   "`
 * renders as an empty section — the same dead end, so it takes the same
 * exit.
 */
export function hasSummaryContent(summary: SummaryDoc | null | undefined): boolean {
  if (!summary) return false
  return summary.summary.trim() !== '' || summary.decisions.length > 0 || summary.actionItems.length > 0
}

/**
 * The line to show under a summary that does not cover the whole meeting,
 * or `null` when it does. Two limits can cut a summary short: the
 * transcript did not fit the context window (`truncated`, issue #41), or
 * the model's answer ran past its response budget (`cutOff`, issue #45).
 */
export function summaryCoverageNotice(summary: Pick<SummaryDoc, 'truncated' | 'cutOff'>): string | null {
  const notices: string[] = []
  if (summary.truncated) {
    notices.push(
      "This meeting was too long for the summary model's memory, so this summary covers only part of it. A larger context window in Settings → Summary gives full coverage.",
    )
  }
  if (summary.cutOff) {
    notices.push(
      'This summary was too long for the model to finish, so the last items are missing. A larger context window in Settings → Summary can give it more room.',
    )
  }
  return notices.length > 0 ? notices.join(' ') : null
}

/**
 * Folds one `summary-status` event into the per-note "waiting since" map:
 * a `'queued'` event records when the note joined the queue, every other
 * state removes the entry. `now` stands in when a queued event carries no
 * `queuedAt`. Returns `prev` itself when nothing changes.
 */
export function nextSummaryQueuedAt(
  prev: Record<string, number>,
  event: SummaryStatusEvent,
  now: number,
): Record<string, number> {
  if (event.state === 'queued') {
    const queuedAt = event.queuedAt ?? prev[event.noteId] ?? now
    return prev[event.noteId] === queuedAt ? prev : { ...prev, [event.noteId]: queuedAt }
  }
  if (!(event.noteId in prev)) return prev
  const next = { ...prev }
  delete next[event.noteId]
  return next
}

/**
 * How long a summary has waited, as the words after "has waited":
 * "less than a minute", "5 minutes", "1 hour", "6 hours", "2 days". Rounds
 * down, so "6 hours" means at least six. A `queuedAt` in the future (clock
 * change) reads as no wait.
 */
export function formatWait(queuedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - queuedAt) / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return plural(hours, 'hour')
  return plural(Math.floor(hours / 24), 'day')
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
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
 *
 * Recomputes the full grouping from scratch on every call (O(n) in the
 * number of segments so far) rather than incrementally updating a previous
 * result — deliberately not worth the extra bookkeeping at whisper's
 * cadence (roughly one segment every several seconds of audio, not one per
 * word), so a whole-recording list stays small enough for this to be free.
 */
export function groupLiveSegments(segments: TranscriptSegmentEvent[]): LiveTranscriptGroup[] {
  const groups: LiveTranscriptGroup[] = []
  for (const seg of segments) {
    const last = groups[groups.length - 1]
    if (last && last.speaker === seg.speaker) {
      groups[groups.length - 1] = { ...last, end: seg.end, text: `${last.text} ${seg.text}` }
    } else {
      groups.push({ speaker: seg.speaker, start: seg.start, end: seg.end, text: seg.text })
    }
  }
  return groups
}

/**
 * A short (1-3 char) avatar label derived from a speaker name — `"Speaker
 * 1"` -> `"S1"`, `"Speaker 12"` -> `"S12"` (Stage 2's stt worker only ever
 * emits placeholder labels of this exact shape), and generically `"Priya
 * Shah"` -> `"PS"` / `"Unknown"` -> `"UN"` so this also degrades sensibly
 * once real speaker names show up post-diarization. `""`/whitespace-only
 * falls back to `"?"` rather than an empty avatar.
 */
export function speakerInitials(speaker: string): string {
  const words = speaker.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  const [first, second] = words
  if (/^\d+$/.test(second)) {
    return `${first[0]}${second}`.toUpperCase()
  }
  return `${first[0]}${second[0]}`.toUpperCase()
}

/** What every surface prints for an unknown speaker. Mirrors `store::UNKNOWN_SPEAKER_LABEL`. */
export const UNKNOWN_SPEAKER_LABEL = 'Unknown speaker'

/** One named speaker as the speaker controls show it: "Speaker 3 · 14 turns", plus its "Sounds like …" suggestion. */
export interface SpeakerRosterEntry {
  speaker: string
  turns: number
  suggestion: SpeakerSuggestion | null
}

/** A note's speakers for the rename popover (issue #49). Unknown turns are counted but are never an entry: they can't be renamed or merged. */
export interface SpeakerRoster {
  speakers: SpeakerRosterEntry[]
  unknownTurns: number
}

/** Builds a note's `SpeakerRoster`, speakers in order of first appearance. `suggestions` is `NoteMeta.speakerSuggestions`, keyed by the speaker's current label. */
export function speakerRoster(
  segments: StoredSegment[],
  suggestions: Record<string, SpeakerSuggestion> = {},
): SpeakerRoster {
  const turns = new Map<string, number>()
  let unknownTurns = 0
  for (const { speaker } of segments) {
    if (speaker === null) unknownTurns += 1
    else turns.set(speaker, (turns.get(speaker) ?? 0) + 1)
  }
  return {
    speakers: Array.from(turns, ([speaker, count]) => ({
      speaker,
      turns: count,
      suggestion: suggestions[speaker] ?? null,
    })),
    unknownTurns,
  }
}

/**
 * Maps a note's stored transcript segments (as persisted by the backend,
 * `{ speaker: "Speaker 1", start, end, text }`) to `TranscriptList`'s
 * display shape. Unlike `groupLiveSegments`, consecutive same-speaker
 * segments are *not* merged — each is its own whisper-emitted segment with
 * its own timestamp, and rendering them as-is preserves that.
 */
export function storedSegmentsToDisplay(segments: StoredSegment[]): TranscriptSegment[] {
  return segments.map(seg => ({
    initials: seg.speaker === null ? '?' : speakerInitials(seg.speaker),
    speaker: seg.speaker,
    time: formatMmSs(seg.start),
    text: seg.text,
    start: seg.start,
    end: seg.end,
  }))
}

/**
 * Binary search over `segments` (assumed sorted ascending by `start`, as
 * `transcript.json`/`storedSegmentsToDisplay`'s output always is — whisper
 * emits them in stream order) for the index of the segment whose
 * `[start, end)` window contains `time` — what `NoteView` uses to derive
 * `TranscriptList`'s active-segment highlight from `useAudioPlayer`'s
 * `currentTime`, at up to ~4Hz (native `timeupdate` cadence) while playing.
 * `-1` when `time` falls before the first segment, after the last, or into a
 * gap between two segments' windows (whisper segments aren't always
 * contiguous — silence between them isn't covered by either neighbor).
 *
 * Finds the last segment whose `start <= time` (a standard "rightmost
 * insertion point" binary search), then confirms `time` still falls inside
 * that segment's window before returning it — a segment whose `end` has
 * already passed doesn't count as active just because it's the most recent
 * one that started.
 */
/** One piece of `splitHighlight`'s output — a slice of the original text, tagged with whether it's the matched substring. */
export interface HighlightSegment {
  text: string
  match: boolean
}

/**
 * Splits `text` into segments around the first case-insensitive occurrence
 * of `query`: the matched slice (`match: true`) plus whatever comes before
 * and/or after it (`match: false`), in order. A blank `query` or no match
 * at all returns `text` as a single non-matching segment. `SearchPalette`
 * renders these to bold the matched substring in a search hit's snippet —
 * see `SearchHit`'s doc comment (in `ipc/types.ts`) for why this happens
 * here in plain JS rather than off match offsets shipped from the backend.
 *
 * Plain JS string operations throughout (`toLowerCase`/`indexOf`/`slice`,
 * all UTF-16-code-unit-based) — no cross-language index-space concern here,
 * since both `text` and `query` are already JS strings on this side of the
 * wire.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const trimmed = query.trim()
  if (!trimmed) return [{ text, match: false }]
  const idx = text.toLowerCase().indexOf(trimmed.toLowerCase())
  if (idx === -1) return [{ text, match: false }]

  const segments: HighlightSegment[] = []
  if (idx > 0) segments.push({ text: text.slice(0, idx), match: false })
  segments.push({ text: text.slice(idx, idx + trimmed.length), match: true })
  if (idx + trimmed.length < text.length) segments.push({ text: text.slice(idx + trimmed.length), match: false })
  return segments
}

/** One piece of `splitAnswerCitations`'s output — a slice of an ask-your-notes answer, tagged with the seek target if it's a `[mm:ss]` citation. */
export interface AnswerPart {
  text: string
  citationSeconds?: number
}

const CITATION_RE = /\[(\d{1,2}):(\d{2})\]/g

/**
 * Splits an ask-your-notes answer into plain-text and citation parts around
 * every inline `[mm:ss]` timestamp citation the model was instructed to emit
 * (see `llm::build_ask_prompt`) — `AskPanel` renders each citation part
 * as a clickable seek button (`onSeekCitation(citationSeconds)`) and
 * everything else as plain text, same split-around-matches shape as
 * `splitHighlight` above. `mm` is 1-2 digits, `ss` exactly 2 (matches
 * `format_mm_ss`'s zero-padded backend output); `mm * 60 + ss` doesn't
 * assume `mm < 60`, so a genuine hour-plus citation (`mm` > 59) still parses
 * to the right number of seconds. No citations at all returns the whole
 * answer as a single plain part — a bare `[see above]`-style bracket with no
 * digits/colon inside never matches `CITATION_RE`, so it's left as plain
 * text rather than mistaken for a citation.
 */
export function splitAnswerCitations(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = []
  let lastIndex = 0
  for (const match of answer.matchAll(CITATION_RE)) {
    const index = match.index ?? 0
    if (index > lastIndex) parts.push({ text: answer.slice(lastIndex, index) })
    const mm = Number(match[1])
    const ss = Number(match[2])
    parts.push({ text: match[0], citationSeconds: mm * 60 + ss })
    lastIndex = index + match[0].length
  }
  if (lastIndex < answer.length) parts.push({ text: answer.slice(lastIndex) })
  if (parts.length === 0) parts.push({ text: answer })
  return parts
}

export function findActiveSegmentIndex(segments: { start: number; end: number }[], time: number): number {
  let lo = 0
  let hi = segments.length - 1
  let candidate = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].start <= time) {
      candidate = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (candidate === -1) return -1
  return time < segments[candidate].end ? candidate : -1
}
