// TypeScript mirrors of the Rust wire shapes exposed by the Tauri backend
// (src-tauri/src/{catalog,store,download,audio,stt}.rs). Every interface
// here must match the `serde`-derived JSON shape of its Rust counterpart
// exactly — see the doc comment above each type for the source struct.

// --- catalog.rs ------------------------------------------------------------

/** `catalog::Hardware` — detected machine capabilities. */
export interface Hardware {
  totalRamGb: number
  appleSilicon: boolean
  cores: number
}

/** `catalog::ModelKind` — `#[serde(rename_all = "lowercase")]`. */
export type ModelKind = 'stt' | 'llm'

/** `catalog::CatalogEntry` — `#[serde(rename_all = "camelCase")]`. */
export interface CatalogEntry {
  id: string
  kind: ModelKind
  displayName: string
  desc: string
  url: string
  sha256: string
  sizeBytes: number
  minRamGb: number
  requiresAppleSilicon: boolean
}

/**
 * `catalog::InstallState` — a unit-only enum with
 * `#[serde(rename_all = "camelCase")]` and no `tag`/`content` attribute, so
 * serde uses its default "externally tagged" representation for a
 * variant with no fields: the bare variant name as a JSON string (NOT an
 * `{ "state": "..." }` object, and NOT `{ "NotInstalled": null }`).
 * Confirmed by reading catalog.rs directly — `InstallState::NotInstalled`
 * serializes to the JSON string `"notInstalled"`.
 */
export type InstallState = 'notInstalled' | 'downloading' | 'installed'

/**
 * `catalog::ModelStatus` — `#[serde(flatten)] entry: CatalogEntry` plus a
 * sibling `state` field, so on the wire this is `CatalogEntry`'s fields
 * flattened alongside `state`, not a nested `{ entry, state }` object.
 */
export interface ModelStatus extends CatalogEntry {
  state: InstallState
}

/** `catalog::Recommendation` — no `rename_all`, but fields are already lowercase. */
export interface Recommendation {
  stt: string
  llm: string
}

// --- store.rs ----------------------------------------------------------

/** `store::NoteStatus` — `#[serde(rename_all = "lowercase")]`. */
export type NoteStatus = 'recording' | 'transcribed' | 'ready'

/**
 * `store::NoteMeta` — `#[serde(rename_all = "camelCase")]`. `audioDeleted`
 * is `#[serde(default)]` on the Rust side (old `meta.json` files without it
 * parse as `false`) — set `true` once the 30-day sweep has deleted this
 * note's `audio.wav`; `get_note`'s `audioPath` is `null` whenever this is
 * `true`, regardless of what's actually on disk (see `NoteWithTranscript`'s
 * docs).
 */
export interface NoteMeta {
  id: string
  title: string
  createdAt: string
  durationSec: number
  model: string
  status: NoteStatus
  speakers: number
  audioDeleted: boolean
}

/** `store::StoredSegment` — `#[serde(rename_all = "camelCase")]`. */
export interface StoredSegment {
  speaker: string
  start: number
  end: number
  text: string
}

/** `store::Transcript` — `#[serde(rename_all = "camelCase")]`. */
export interface Transcript {
  segments: StoredSegment[]
}

/**
 * `lib.rs::NoteWithTranscript` — the `get_note` command's JSON-friendly
 * wrapper around the `(NoteMeta, Transcript)` tuple `Store::get_note`
 * returns internally (a bare tuple would serialize as a JSON array).
 * `summary` is `null` until the note has been summarized; `markdown` is
 * `store::render_note_md`'s output for the same data, rendered fresh on
 * every read — the sole source of a note's markdown rendering (Stage 3 Task
 * 5 retired the frontend's own `noteToMarkdown` generator; every component
 * that renders/exports a note's markdown reads this field). `audioPath` is
 * the absolute path to `audio.wav` when it exists on disk AND
 * `meta.audioDeleted` is `false`, `null` otherwise (never captured, or swept
 * — the backend checks `audioDeleted` explicitly rather than just file
 * existence, so a stray leftover `audio.wav` can never resurrect playback
 * for a note the sweep already marked swept) — fed through `convertFileSrc`
 * to build the `<audio>` element's `src` in `useAudioPlayer`; `null` drives
 * `PlayerBar`'s disabled "Audio removed" state.
 */
export interface NoteWithTranscript {
  meta: NoteMeta
  transcript: Transcript
  summary: SummaryDoc | null
  markdown: string
  audioPath: string | null
}

/** `store::SearchHitKind` — `#[serde(rename_all = "lowercase")]`. */
export type SearchHitKind = 'title' | 'transcript'

/**
 * `store::SearchHit` — `#[serde(rename_all = "camelCase")]`. One hit from
 * `search_notes`: a note title match (`kind: 'title'`, `segmentStart:
 * null`) or a transcript segment match (`kind: 'transcript'`,
 * `segmentStart` the segment's start time in seconds — what selecting the
 * hit seeks playback to). `snippet` is a ±40-char window around the first
 * case-insensitive match within the matched text.
 *
 * Deliberately has no `matchStart`/`matchLen` field. Highlighting the
 * matched substring is done here on the frontend instead — a plain
 * case-insensitive `indexOf` of the same query against `snippet` (see
 * `state/adapters.ts`'s `splitHighlight`) — rather than shipping match
 * offsets computed in Rust: a Rust `char_indices` offset, a raw UTF-8 byte
 * offset, and a JavaScript UTF-16 code-unit offset are three different
 * index spaces, and any one of them sent over the wire would require this
 * side to already know (and never get wrong) which one it was. Recomputing
 * the match position against a string this side already has removes that
 * whole class of bug for a negligible amount of extra work.
 */
export interface SearchHit {
  noteId: string
  title: string
  snippet: string
  segmentStart: number | null
  kind: SearchHitKind
}

// --- llm.rs --------------------------------------------------------------

/** `llm::ActionItem` — `#[serde(rename_all = "camelCase")]`. */
export interface ActionItem {
  text: string
  done: boolean
}

/** `llm::SummaryDoc` — `#[serde(rename_all = "camelCase")]`. */
export interface SummaryDoc {
  summary: string
  decisions: string[]
  actionItems: ActionItem[]
}

/** `store::StorageStats` — `#[serde(rename_all = "camelCase")]`. */
export interface StorageStats {
  modelsBytes: number
  audioBytes: number
  notesBytes: number
}

// --- settings.rs -------------------------------------------------------

/**
 * `settings::Settings` — `#[serde(rename_all = "camelCase")]`. No
 * `encryptLibrary` (Stage 4 Task 3 removed the toggle — the app never
 * implemented at-rest encryption of its own; the library only ever
 * inherited whatever FileVault protection macOS itself provides, so the
 * toggle was a fake capability. Settings.tsx now shows a passive line about
 * that instead). `meetingDetection` is Stage 5 Task 1's opt-in toggle
 * (`#[serde(default)]` on the Rust side, so it's always present here too —
 * `false` for both a fresh install and any settings.json written before
 * this field existed); the toggle UI itself is Task 3, this file only adds
 * the wire type.
 */
export interface Settings {
  sttModel: string | null
  llmModel: string | null
  deleteAudioAfter30d: boolean
  meetingDetection: boolean
}

/**
 * `settings::SettingsPatch` — `#[serde(rename_all = "camelCase")]`. Every
 * field is optional; an omitted field is left unchanged server-side (see
 * `settings::apply_patch`) — there's no way to explicitly clear a model
 * selection back to unset.
 */
export interface SettingsPatch {
  sttModel?: string
  llmModel?: string
  deleteAudioAfter30d?: boolean
  meetingDetection?: boolean
}

// --- events ----------------------------------------------------------------

/** `download.rs::DownloadProgressEvent` — event `model-download-progress`. */
export interface ModelDownloadProgressEvent {
  modelId: string
  downloaded: number
  total: number
}

/** `download.rs::DownloadDoneEvent` — event `model-download-done`. */
export interface ModelDownloadDoneEvent {
  modelId: string
  ok: boolean
  cancelled: boolean
  error: string | null
}

/** `audio.rs::RecordingStateEvent` — event `recording-state`. */
export interface RecordingStateEvent {
  noteId: string
  state: 'recording' | 'paused' | 'stopped'
  elapsed: number
}

/** `stt.rs::TranscriptSegmentPayload` — event `transcript-segment`. */
export interface TranscriptSegmentEvent {
  noteId: string
  speaker: string
  start: number
  end: number
  text: string
}

/** `stt.rs::SttStatusPayload` — event `stt-status`. */
export interface SttStatusEvent {
  noteId: string
  state: 'loading' | 'ready' | 'finalizing' | 'error'
  error: string | null
}

/** `llm.rs::SummaryStatusPayload` — event `summary-status`. */
export interface SummaryStatusEvent {
  noteId: string
  state: 'running' | 'done' | 'error'
  error: string | null
}

/**
 * `llm.rs::AskStatusPayload` — event `ask-status`. Ask-your-notes'
 * lifecycle counterpart to `SummaryStatusEvent`: `running` while the worker
 * is generating, `done` once the answer has already gone out via a separate
 * `ask-answer` event (emitted first — see that event's docs), `error`
 * otherwise (no LLM installed, empty/missing transcript, model failure).
 */
export interface AskStatusEvent {
  noteId: string
  state: 'running' | 'done' | 'error'
  error: string | null
}

/**
 * `llm.rs::AskAnswerPayload` — event `ask-answer`. The actual answer to a
 * question, carried in its own event rather than folded into
 * `AskStatusEvent` — `question` rides along so a listener can match the
 * answer back to what was asked. Session-only: never persisted anywhere on
 * the backend (no `ask.json`, no note field) — a fresh app launch has no
 * memory of any previous question.
 */
export interface AskAnswerEvent {
  noteId: string
  question: string
  answer: string
}

/**
 * `detect.rs::MeetingDetectedEvent` — event `meeting-detected`. Emitted once
 * `detect::DetectorCore` decides to show the prompt (≥5s continuous mic
 * activity + a meeting app present + Minute not already recording + not in
 * cooldown — see that module's docs). `appName` is the friendly name of the
 * highest-priority allowlisted app currently running (e.g. `"Zoom"`), never
 * a bundle id. Stage 5 Task 1 only adds this typed listener — there's no
 * popup UI wired to it yet (Task 2).
 */
export interface MeetingDetectedEvent {
  appName: string
}
