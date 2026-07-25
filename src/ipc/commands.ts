// Typed wrappers over the Tauri commands exposed by src-tauri/src/lib.rs
// (plus audio.rs/download.rs command fns registered in its
// `invoke_handler`). One function per command; argument object keys use
// the same camelCase names Tauri's IPC auto-derives from the Rust
// snake_case parameter names.

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type {
  Hardware,
  ModelStatus,
  NoteMeta,
  NoteWithTranscript,
  Recommendation,
  SearchHit,
  Settings,
  SettingsPatch,
  StorageStats,
  SummaryDoc,
  SysAudioStatus,
} from './types'

/**
 * Thin wrapper over `invoke` that normalizes command rejections: backend
 * commands reject with the raw `String` from their `Result<T, String>`
 * (not an `Error`), so this re-throws it as `new Error(String(raw))` —
 * every wrapper below routes through this so callers can always rely on an
 * `Error` instance with a `.message`, regardless of what the backend
 * actually rejected with.
 */
async function invokeCmd<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (raw) {
    throw new Error(String(raw))
  }
}

export const hardwareInfo = (): Promise<Hardware> => invokeCmd('hardware_info')

export const listModels = (): Promise<ModelStatus[]> => invokeCmd('list_models')

export const recommendedModels = (): Promise<Recommendation> => invokeCmd('recommended_models')

export const downloadModel = (id: string): Promise<void> => invokeCmd('download_model', { id })

export const cancelDownload = (id: string): Promise<void> => invokeCmd('cancel_download', { id })

export const deleteModel = (id: string): Promise<void> => invokeCmd('delete_model', { id })

export const listNotes = (): Promise<NoteMeta[]> => invokeCmd('list_notes')

export const getNote = (id: string): Promise<NoteWithTranscript> => invokeCmd('get_note', { id })

/**
 * Case-insensitive substring search over every note's title and transcript
 * text (see `store::Store::search_notes`) — backs the ⌘K search palette and
 * the sidebar's filter input. `query` is passed through verbatim (including
 * an empty/whitespace one) — the backend itself short-circuits that case to
 * an empty result without scanning; callers that want to skip the IPC round
 * trip entirely for a blank query do that themselves (see
 * `SearchPalette`/`useAppState`'s debounce effects).
 */
export const searchNotes = (query: string): Promise<SearchHit[]> => invokeCmd('search_notes', { query })

export const renameNote = (id: string, title: string): Promise<NoteMeta> =>
  invokeCmd('rename_note', { id, title })

export const deleteNote = (id: string): Promise<void> => invokeCmd('delete_note', { id })

export const storageStats = (): Promise<StorageStats> => invokeCmd('storage_stats')

/** Reveals a note in Finder (its audio.wav if present, else the note's folder). */
export const revealNote = (id: string): Promise<void> => invokeCmd('reveal_note', { id })

/** Starts a new recording using the given STT model id; resolves with the new note's id. */
export const startRecording = (modelId: string): Promise<string> =>
  invokeCmd('start_recording', { modelId })

export const pauseRecording = (): Promise<void> => invokeCmd('pause_recording')

export const resumeRecording = (): Promise<void> => invokeCmd('resume_recording')

/** Stops the active recording; resolves with the finalized note's metadata. */
export const stopRecording = (): Promise<NoteMeta> => invokeCmd('stop_recording')

/**
 * Resolves the meeting-detected popup as "Start recording" (Stage 5 Task 2):
 * hides the popup, reports the accepted outcome to the detector, and brings
 * the main window forward — see `popup::popup_start`'s docs for why the
 * actual `start_recording` call happens on the frontend (via the
 * `meeting-popup-start` event, `onMeetingPopupStart`) rather than here.
 */
export const popupStart = (): Promise<void> => invokeCmd('popup_start')

/**
 * Resolves the meeting-detected popup as dismissed: the quiet × click
 * (`timedOut: false`) or the popup's own auto-dismiss timer expiring
 * (`timedOut: true`). Either way the detector applies the same 15-minute
 * cooldown — see `popup::popup_dismiss`'s docs.
 */
export const popupDismiss = (timedOut: boolean): Promise<void> =>
  invokeCmd('popup_dismiss', { timedOut })

export const getSettings = (): Promise<Settings> => invokeCmd('get_settings')

/** Merges `patch` into the persisted settings and resolves with the updated settings. */
export const setSettings = (patch: SettingsPatch): Promise<Settings> =>
  invokeCmd('set_settings', { patch })

/**
 * Triggers (or re-triggers — this is also what "Regenerate" calls)
 * summarization for a note. Resolves once the worker has been queued, not
 * once summarization finishes — listen for `summary-status` events
 * (`onSummaryStatus`) for progress.
 */
export const summarizeNote = (id: string): Promise<void> => invokeCmd('summarize_note', { id })

/**
 * Flips one action item's `done` state in a note's summary (read-modify-
 * write server-side — see `store::Store::toggle_action_item`, wired up
 * through the `toggle_action_item` command) and resolves with the note's
 * full updated `SummaryDoc`. `index` is the action item's position in
 * `summary.actionItems`; rejects if the note has no summary yet or `index`
 * is out of bounds.
 */
export const toggleActionItem = (id: string, index: number, done: boolean): Promise<SummaryDoc> =>
  invokeCmd('toggle_action_item', { id, index, done })

/**
 * Asks `question` about note `id`'s transcript. Resolves once the worker
 * has been queued, not once the answer is ready — listen for `ask-status`/
 * `ask-answer` events (`onAskStatus`/`onAskAnswer`) for progress and the
 * result. The answer is never persisted (session-only — see
 * `AskAnswerEvent`'s docs).
 */
export const askNote = (id: string, question: string): Promise<void> => invokeCmd('ask_note', { id, question })

/**
 * Reports whether system-audio capture is available right now (Stage 5
 * Task 4) — see `SysAudioAvailability`'s docs for what each state means.
 * Read-only: never triggers the Screen Recording prompt (that's
 * `requestSysAudioPermission`, below).
 */
export const sysAudioStatus = (): Promise<SysAudioStatus> => invokeCmd('sys_audio_status')

/**
 * Triggers the Screen Recording consent prompt (a no-op re-check, not a
 * re-prompt, if the user already decided one way or the other — see the
 * backend command's docs) and resolves with the resulting status. A fresh
 * grant may still need an app restart before real capture works — see that
 * same doc comment for the honest caveat; this call alone doesn't
 * guarantee `SysCapture::start` will succeed even after it resolves
 * `{ availability: 'ready' }`.
 */
export const requestSysAudioPermission = (): Promise<SysAudioStatus> => invokeCmd('request_sys_audio_permission')
