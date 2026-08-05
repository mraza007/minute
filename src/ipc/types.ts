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
export type ModelKind = 'stt' | 'llm' | 'diarization'

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

export interface NoteMarker {
  seconds: number
  label: string
}

/**
 * `store::NoteMeta` — `#[serde(rename_all = "camelCase")]`. `audioDeleted`
 * is `#[serde(default)]` on the Rust side (old `meta.json` files without it
 * parse as `false`) — set `true` once the 30-day sweep has deleted this
 * note's `audio.wav`; `get_note`'s `audioPath` is `null` whenever this is
 * `true`, regardless of what's actually on disk (see `NoteWithTranscript`'s
 * docs). `sources` (Stage 5 Task 5) is `#[serde(default = "default_sources")]`
 * on the Rust side (old `meta.json` files without it parse as `["mic"]`,
 * the correct interpretation — every note recorded before system audio
 * existed was mic-only by construction) — `["mic", "system"]` once a
 * recording actually mixed in system audio, never mutated after
 * `stop_recording` writes it once at finalize time.
 */
export interface NoteMeta {
  id: string
  title: string
  createdAt: string
  durationSec: number
  model: string
  status: NoteStatus
  speakers: number
  /** Present when capture or WAV finalization was incomplete. */
  captureWarning?: string
  audioDeleted: boolean
  sources: string[]
  /** Optional only for compatibility with legacy fixtures/meta files. */
  pinned?: boolean
  /** Optional only for compatibility with legacy fixtures/meta files. */
  markers?: NoteMarker[]
  /** User-confirmed raw-label aliases, scoped to this one recording. */
  speakerAliases?: Record<string, string>
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

/** `store::SpeakerMergeUndo` — exact turn indices changed by one merge. */
export interface SpeakerMergeUndo {
  from: string
  into: string
  segmentIndices: number[]
  checksum: string
}

/** `store::SpeakerMergeResult`. */
export interface SpeakerMergeResult {
  transcript: Transcript
  meta: NoteMeta
  undo: SpeakerMergeUndo
}

/** `store::SpeakerMergeUndoResult`. */
export interface SpeakerMergeUndoResult {
  transcript: Transcript
  meta: NoteMeta
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
/** `llm.rs::SummaryTopic` — one section of a Detailed summary's breakdown (issue #14). */
export interface SummaryTopic {
  title: string
  /** What was said about this topic. May be empty when a model returned a title-only entry. */
  summary: string
}

export interface SummaryDoc {
  summary: string
  /**
   * Per-topic breakdown, empty unless the note was summarized under the
   * Detailed style (issue #14). Always present in JSON from `get_note`
   * (Rust's `#[serde(default)]` fills it in for summaries written before
   * the field existed), so no optionality to handle here.
   */
  topics: SummaryTopic[]
  decisions: string[]
  actionItems: ActionItem[]
}

/** `store::StorageStats` — `#[serde(rename_all = "camelCase")]`. */
export interface StorageStats {
  modelsBytes: number
  audioBytes: number
  notesBytes: number
}

/** `lib.rs::LibraryInfo` — where the notes library currently lives. */
export interface LibraryInfo {
  /** Absolute path — tooltip + the folder picker's starting location. */
  path: string
  /** Same location with the home directory abbreviated to `~` — what Settings displays. */
  displayPath: string
  isDefault: boolean
}

export interface DeletedNoteUndo {
  id: string
  title: string
  trashName: string
  checksum: string
}

export interface NoteStorageStats {
  totalBytes: number
  audioBytes: number
  documentBytes: number
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
 * the wire type. `captureSystemAudio` (Stage 5 Task 5) is the persisted
 * default for `startRecording`'s `includeSystemAudio` — same
 * `#[serde(default)]`/off-by-default shape as `meetingDetection`, and
 * honored backend-side only when `sysAudioStatus()` reports `'ready'`
 * regardless of this value (see that command's docs).
 */
/** `settings::SummaryStyle`, serialized lowercase — how long/detailed generated summaries should be. */
export type SummaryStyle = 'short' | 'standard' | 'detailed'

export interface Settings {
  sttModel: string | null
  llmModel: string | null
  deleteAudioAfter30d: boolean
  meetingDetection: boolean
  captureSystemAudio: boolean
  /** Set only by the `move_library` command, never via `setSettings` — see `SettingsPatch`. */
  libraryRoot: string | null
  /** Summarizer context-window override in tokens; `null` = automatic (RAM-tiered). */
  llmContextTokens: number | null
  summaryStyle: SummaryStyle
  /** Free-text instructions appended to the summary prompt's rules; empty = none. */
  summaryInstructions: string
  /** Whether the app checks GitHub for newer releases (metadata only, on by default). */
  autoUpdateCheck: boolean
  /** Run the local speaker-diarization pass after each recording (opt-in). */
  detectSpeakers: boolean
  /** Auto-stop: after 10 silent minutes mid-recording, warn with a 10-minute countdown, then stop & transcribe (on by default). */
  autoStopRecording: boolean
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
  captureSystemAudio?: boolean
  /** `0` means "back to automatic" (clears the override) — see `settings::SettingsPatch`'s docs. */
  llmContextTokens?: number
  summaryStyle?: SummaryStyle
  /** `''` clears the instructions. */
  summaryInstructions?: string
  autoUpdateCheck?: boolean
  detectSpeakers?: boolean
  autoStopRecording?: boolean
}

// --- events ----------------------------------------------------------------

/** `download.rs::DownloadProgressEvent` — event `model-download-progress`. */
export interface ModelDownloadProgressEvent {
  modelId: string
  downloaded: number
  total: number
}

/** `audio.rs::AutoStopStatePayload` — event `auto-stop-state`. `pending`
 * carries the live countdown; `cancelled` clears any banner. */
export interface AutoStopStatePayload {
  noteId: string
  state: 'pending' | 'cancelled'
  secondsRemaining: number | null
}

/** `diar.rs::DiarStatusState`, serialized lowercase. */
export type DiarStatusState = 'running' | 'done' | 'error'

/** `diar.rs::DiarStatusPayload` — event `diar-status`. */
export interface DiarStatusPayload {
  noteId: string
  state: DiarStatusState
  error: string | null
  /** Settled speaker count — non-null only when `state` is `'done'`. */
  speakers: number | null
}

/** `download.rs::DownloadDoneEvent` — event `model-download-done`. */
export interface ModelDownloadDoneEvent {
  modelId: string
  ok: boolean
  cancelled: boolean
  error: string | null
}

/**
 * `audio.rs::RecordingStateEvent` — event `recording-state`.
 * `systemAudioActive` (Stage 5 Task 5) is fixed for the whole recording
 * session (there's no way to change audio sources mid-recording) — the
 * real, backend-confirmed state (whether `includeSystemAudio` was actually
 * honored, not just requested — see `start_recording`'s docs), never just
 * an echo of what the frontend asked for.
 */
export interface RecordingStateEvent {
  noteId: string
  state: 'recording' | 'paused' | 'stopped'
  elapsed: number
  systemAudioActive: boolean
  /** cpal-reported name of the microphone opened for this session. */
  microphoneName: string
  /** Current microphone RMS and loudest peak since the previous 1s tick. */
  inputRms: number
  inputPeak: number
  /** Monotonic native callback count; a frozen value indicates a stalled stream. */
  inputSequence: number
  /** Native stream/write failure, when cpal supplied one. */
  inputError: string | null
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

/**
 * `llm.rs::SummaryStatusPayload` — event `summary-status`.
 *
 * `'queued'` (issue #11) means the note is waiting behind another
 * generation and will start on its own — never a terminal state, always
 * followed by `'running'` when its turn comes. Emitted by whoever enqueued
 * rather than by a worker, since no worker exists for that note yet.
 */
export interface SummaryStatusEvent {
  noteId: string
  state: 'queued' | 'running' | 'done' | 'error'
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

/**
 * `popup.rs::MeetingPopupPayload` — event `meeting-popup-payload`, emitted
 * (via `emit_to`, targeted only at the `meeting-popup` window) every time
 * `popup::show_meeting_prompt` shows the pill, including on reuse — the
 * popup window is created once and kept alive for the rest of the app's
 * session, so this is how it learns which app's call triggered *this*
 * particular showing.
 */
export interface MeetingPopupPayloadEvent {
  appName: string
}

// --- syscap.rs ---------------------------------------------------------

/**
 * `syscap::SysAudioAvailability` — a unit-only enum with
 * `#[serde(rename_all = "camelCase")]` and no `tag`/`content` attribute, so
 * (same as `catalog::InstallState` — see that type's own note above) it
 * serializes as a bare JSON string: `"unsupported"` | `"notGranted"` |
 * `"ready"`, never an object.
 *
 * Deliberately three states, not four (`PermissionNeeded` vs
 * `PermissionDenied` isn't a distinction macOS's `CGPreflightScreenCaptureAccess`
 * can actually make — see the Rust enum's own doc comment for why
 * `notGranted` covers both "never asked" and "explicitly denied"):
 * - `unsupported`: macOS is below 13 — not a permission question at all.
 * - `notGranted`: macOS 13+, but Screen Recording isn't currently granted.
 * - `ready`: macOS 13+ and Screen Recording is currently granted (though see
 *   `requestSysAudioPermission`'s docs for the "may still need an app
 *   restart" caveat on a *freshly* granted permission).
 */
export type SysAudioAvailability = 'unsupported' | 'notGranted' | 'ready'

/** `syscap::SysAudioStatus` — `#[serde(rename_all = "camelCase")]`. */
export interface SysAudioStatus {
  availability: SysAudioAvailability
}

// --- audio.rs ----------------------------------------------------------

/** A cpal input source. The opaque id, not the display name, is used when
 * starting capture because two connected devices can share a name. */
export interface AudioInputDevice {
  id: string
  name: string
  isDefault: boolean
}

export type MicrophonePermission = 'notDetermined' | 'restricted' | 'denied' | 'authorized' | 'unknown'

/** The microphones currently visible to cpal and the macOS default id. An
 * empty list means the preflight must disable its start action. */
export interface AudioInputStatus {
  devices: AudioInputDevice[]
  defaultDeviceId: string | null
  /** AVFoundation authorization, checked separately because CoreAudio may
   * expose a device that only emits silence while access is denied. */
  permission: MicrophonePermission
}

/** Throttled levels from the selected preflight microphone. `error` is set
 * when an already-open preview stream fails or disconnects. */
export interface AudioInputLevelEvent {
  sessionId: string
  rms: number
  peak: number
  error: string | null
}
