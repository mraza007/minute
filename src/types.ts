export type View = 'loading' | 'onboarding' | 'notes' | 'recording' | 'settings'
export type NoteTab = 'transcript' | 'md'

/**
 * Live-transcription lifecycle state for the active (or most recently
 * active) recording. Mirrors `ipc/types.ts`'s `SttStatusEvent['state']`
 * plus one UI-only value, `'idle'` — the state before any `stt-status`
 * event has arrived yet (e.g. the instant a recording starts, before the
 * backend's worker thread has even begun loading the model).
 */
export type SttStatus = 'idle' | 'loading' | 'ready' | 'finalizing' | 'error'

export interface NoteListItem {
  title: string
  meta: string
  group?: string
}

export interface ActionItem {
  text: string
  done: boolean
}

export interface TranscriptSegment {
  initials: string
  speaker: string
  time: string
  text: string
}

export interface SttModelInfo {
  id: string
  name: string
  desc: string
  sub: string
  subOn: string
}
