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

/** `store::NoteMeta` — `#[serde(rename_all = "camelCase")]`. */
export interface NoteMeta {
  id: string
  title: string
  createdAt: string
  durationSec: number
  model: string
  status: NoteStatus
  speakers: number
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
 */
export interface NoteWithTranscript {
  meta: NoteMeta
  transcript: Transcript
}

/** `store::StorageStats` — `#[serde(rename_all = "camelCase")]`. */
export interface StorageStats {
  modelsBytes: number
  audioBytes: number
  notesBytes: number
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
