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
  /** The note's id — added so the sidebar can filter this list against ⌘K search results (a `Set<string>` of matched note ids) without a second lookup. */
  id: string
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
  /** Formatted `mm:ss` display of `start` — what the timestamp button renders. */
  time: string
  text: string
  /** Seconds into the recording — what clicking the timestamp seeks playback to, and what the active-segment highlight compares against `currentTime`. */
  start: number
  end: number
}

export interface SttModelInfo {
  id: string
  name: string
  desc: string
  sub: string
  subOn: string
}
