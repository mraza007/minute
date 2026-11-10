export type View = 'loading' | 'onboarding' | 'notes' | 'recording' | 'settings'

/**
 * Live-transcription lifecycle state for the active (or most recently
 * active) recording. Mirrors `ipc/types.ts`'s `SttStatusEvent['state']`
 * plus one UI-only value, `'idle'` — the state before any `stt-status`
 * event has arrived yet (e.g. the instant a recording starts, before the
 * backend's worker thread has even begun loading the model).
 */
export type SttStatus = 'idle' | 'loading' | 'ready' | 'finalizing' | 'error'

/** Visible phases between pressing Stop and opening the finalized note. */
export type RecordingProcessingStage = 'idle' | 'saving' | 'finalizing' | 'preparing'

export interface NoteListItem {
  /** The note's id — added so the sidebar can filter this list against ⌘K search results (a `Set<string>` of matched note ids) without a second lookup. */
  id: string
  title: string
  meta: string
  group?: string
  status?: 'recording' | 'transcribed' | 'ready'
  sources?: string[]
  createdAt?: string
  pinned?: boolean
  /** Whether the note has a summary on disk — drives the "Summarized" / "Needs summary" filters (issue #18). */
  hasSummary?: boolean
}

export interface ActionItem {
  text: string
  done: boolean
}

export interface TranscriptSegment {
  initials: string
  /** `null` is an unknown speaker (issue #49): render `UNKNOWN_SPEAKER_LABEL`, muted. */
  speaker: string | null
  /** Formatted `mm:ss` display of `start` — what the timestamp button renders. */
  time: string
  text: string
  /** Seconds into the recording — what clicking the timestamp seeks playback to, and what the active-segment highlight compares against `currentTime`. */
  start: number
  end: number
}
