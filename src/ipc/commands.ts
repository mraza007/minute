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
  Settings,
  SettingsPatch,
  StorageStats,
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

export const getSettings = (): Promise<Settings> => invokeCmd('get_settings')

/** Merges `patch` into the persisted settings and resolves with the updated settings. */
export const setSettings = (patch: SettingsPatch): Promise<Settings> =>
  invokeCmd('set_settings', { patch })
