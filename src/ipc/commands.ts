// Typed wrappers over the Tauri commands exposed by src-tauri/src/lib.rs
// (plus audio.rs/download.rs command fns registered in its
// `invoke_handler`). One function per command; argument object keys use
// the same camelCase names Tauri's IPC auto-derives from the Rust
// snake_case parameter names.

import { invoke } from '@tauri-apps/api/core'
import type {
  Hardware,
  ModelStatus,
  NoteMeta,
  NoteWithTranscript,
  Recommendation,
  StorageStats,
} from './types'

export const hardwareInfo = (): Promise<Hardware> => invoke('hardware_info')

export const listModels = (): Promise<ModelStatus[]> => invoke('list_models')

export const recommendedModels = (): Promise<Recommendation> => invoke('recommended_models')

export const downloadModel = (id: string): Promise<void> => invoke('download_model', { id })

export const cancelDownload = (id: string): Promise<void> => invoke('cancel_download', { id })

export const deleteModel = (id: string): Promise<void> => invoke('delete_model', { id })

export const listNotes = (): Promise<NoteMeta[]> => invoke('list_notes')

export const getNote = (id: string): Promise<NoteWithTranscript> => invoke('get_note', { id })

export const renameNote = (id: string, title: string): Promise<NoteMeta> =>
  invoke('rename_note', { id, title })

export const deleteNote = (id: string): Promise<void> => invoke('delete_note', { id })

export const storageStats = (): Promise<StorageStats> => invoke('storage_stats')

/** Starts a new recording; resolves with the new note's id. */
export const startRecording = (): Promise<string> => invoke('start_recording')

export const pauseRecording = (): Promise<void> => invoke('pause_recording')

export const resumeRecording = (): Promise<void> => invoke('resume_recording')

/** Stops the active recording; resolves with the finalized note's metadata. */
export const stopRecording = (): Promise<NoteMeta> => invoke('stop_recording')
