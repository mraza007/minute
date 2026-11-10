import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  NoteMarker,
  NoteMeta,
  NoteStorageStats,
  ObsidianExport,
  SpeakerMergeUndo,
  StoredSegment,
  SummarizeNowOutcome,
  SummaryDoc,
  SummaryStyle,
} from '../ipc/types'
import type { SttStatus } from '../types'
import { findActiveSegmentIndex, formatBytes, formatMmSs, noteMetaToListItem, speakerRoster, storedSegmentsToDisplay, UNKNOWN_SPEAKER_LABEL, type SummaryWait } from '../state/adapters'
import { useAudioPlayer } from '../state/useAudioPlayer'
import type { ProcessingFailure, SummaryStatus } from '../state/useAppState'
import type { AskHistoryEntry, AskStatus } from '../state/useNoteDetail'
import { AppToolbar } from './AppToolbar'
import { AskPanel } from './AskPanel'
import { NoteMenu, type NoteMenuAction } from './NoteMenu'
import { NoteSummary } from './NoteSummary'
import { PlayerBar } from './PlayerBar'
import { ProcessingStepList } from './ProcessingStepList'
import { noteProcessingSteps } from './processingSteps'
import { SpeakerPopover } from './SpeakerPopover'
import { TranscriptList } from './TranscriptList'
import { useFocusAfterCommit } from './useFocusAfterCommit'
import { assignSpeakerColors, speakerColorStyle } from './speakerColors'

/**
 * `meta` is the selected note's list-level metadata (`null` renders the
 * empty-library or pick-a-note state). `selectedMeta`/`selectedTranscript`/
 * `selectedSummary`/`selectedMarkdown` are the async `get_note` fetch for
 * whichever note was selected when that fetch started. They are trusted only
 * once `selectedMeta.id` matches `meta.id` (see `transcriptReady` below), so
 * a fetch still in flight for an abandoned selection can never show another
 * note's data here.
 */
export interface NoteViewProps {
  meta: NoteMeta | null
  selectedMeta: NoteMeta | null
  selectedTranscript: StoredSegment[]
  selectedSummary: SummaryDoc | null
  selectedMarkdown: string
  /** This note's `audio.wav` path from `get_note`, or `null` if it doesn't exist on disk. Same staleness contract as the other `selected*` fields. `null` renders PlayerBar's "Audio removed" state; a path that then fails to load renders "Audio unavailable". */
  selectedAudioPath: string | null
  selectedNoteStorage: NoteStorageStats | null
  transcriptLoading: boolean
  /**
   * A ⌘K search palette "open this transcript hit" request still waiting to
   * be applied. Applied once this note's audio is ready (`transcriptReady`),
   * so it never seeks a stale `audioPath` left from the previous note.
   */
  pendingSeek: { noteId: string; seconds: number } | null
  /** Called once `pendingSeek` has been applied, so it is not applied again. */
  onPendingSeekApplied: () => void
  sttStatus: SttStatus
  sttStatusNoteId: string | null
  /** This note's summarization lifecycle. `'idle'` if no `summary-status` event has been seen for it this session. */
  summaryStatus: SummaryStatus
  summaryError?: string
  /** How long and why this note's summary has waited, while `summaryStatus` is `'queued'` (issue #44). */
  summaryWait: SummaryWait | null
  /** This note's speaker-detection lifecycle, same collapsed shape as `summaryStatus`. */
  diarStatus: SummaryStatus
  diarError?: string
  /** Whether both diarization models are installed. Gates every "Detect speakers" control. */
  canDetectSpeakers: boolean
  /** Queues the diarization pass; `numSpeakers` forces an exact count, `null` = automatic. */
  onDetectSpeakers: (id: string, numSpeakers?: number | null) => void
  llmInstalled: boolean
  llmModelName: string
  /** This note's ask-your-notes session history, newest first. */
  askHistory: AskHistoryEntry[]
  askStatus: AskStatus
  /** Whether any LLM generation (a summary or an ask, for any note) is in flight app-wide. */
  llmBusy: boolean
  /** Whether the library has any notes. With `meta` null, `true` renders the pick-a-note state (issue #24) instead of the no-notes-yet one. */
  hasNotes: boolean
  /** Whether Obsidian export is turned on in Settings. Gates the toolbar status and "Save to Obsidian again". */
  obsidianEnabled: boolean
  /** Whether a manual Obsidian save for this note is in flight. */
  obsidianSaving: boolean
  onSaveToObsidian: (id: string) => void
  /** Toolbar controls shown while the sidebar is hidden (see `SidebarReopen`). */
  toolbarLead?: ReactNode
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onReveal: (id: string) => void
  /** Writes this note as Markdown into a new export folder and shows it in Finder. */
  onExport: (id: string) => void
  onCopyError: (err: unknown) => void
  onToggleActionItem: (id: string, index: number, done: boolean) => void
  onRegenerateSummary: (id: string) => void
  /** Cancels a queued or running summarization for this note (issue #30). */
  onCancelSummary: (id: string) => void
  /** Starts a queued summary without waiting its turn (issue #44). */
  onSummarizeNow: (id: string) => Promise<SummarizeNowOutcome | null>
  onAsk: (id: string, question: string) => void
  onGoSettings: () => void
  onSetPinned: (id: string, pinned: boolean) => void
  onAddMarker: (id: string, seconds: number, label: string) => Promise<void>
  onUpdateMarker: (id: string, index: number, label: string) => Promise<void>
  onDeleteMarker: (id: string, index: number) => Promise<void>
  onRenameSpeaker: (id: string, from: string, to: string) => void
  /** Drops one "sounds like" suggestion without renaming (issue #22). */
  onDismissSpeakerSuggestion: (id: string, label: string) => void
  onMergeSpeakers: (id: string, from: string, into: string) => Promise<SpeakerMergeUndo>
  /** "Mark these turns as unknown" (issue #49). Undone through `onUndoSpeakerMerge`. */
  onMarkSpeakerUnknown: (id: string, speaker: string) => Promise<SpeakerMergeUndo>
  onUndoSpeakerMerge: (id: string, undo: SpeakerMergeUndo) => Promise<void>
  onDeleteAudio: () => Promise<void>
  onStartRecording: () => void
  processingFailure: ProcessingFailure | null
  onRetryProcessing: () => void
  onDismissProcessing: () => void
  /** Whether this note is the recording that just stopped, so its page shows what is still running on it. */
  justRecorded: boolean
  summaryStyle: SummaryStyle
}

/**
 * The one floating surface the note can have open. A union rather than a
 * boolean per surface: opening one closes the others by construction.
 */
type Overlay =
  | { kind: 'none' }
  | { kind: 'ask' }
  | { kind: 'menu' }
  | { kind: 'speaker'; speaker: string; offsetLeft: number }

/** The one inline form the transcript section can have open. */
type Composer = { kind: 'none' } | { kind: 'marker'; seconds: number } | { kind: 'detect' }

const NO_OVERLAY: Overlay = { kind: 'none' }
const NO_COMPOSER: Composer = { kind: 'none' }

/** The transcript speaker filter: `ALL_SPEAKERS`, one speaker's label, or `null` for the unknown turns. */
type SpeakerFilter = string | null
const ALL_SPEAKERS = 'all'
/** The filter option for unknown turns. A speaker label is never empty, so it cannot collide with one. */
const UNKNOWN_FILTER_VALUE = ''

// A stable reference for the "not ready yet" case, so `displaySegments`'s
// useMemo below is not defeated by a fresh `[]` every render.
const EMPTY_SEGMENTS: StoredSegment[] = []

/** Where each note's page was scrolled to, restored when the note is opened again this session. */
const noteScrollPositions = new Map<string, number>()

const emptyAreaStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  padding: '0 24px 80px 96px',
}

function NewRecordingButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="empty-record" onClick={onClick}>
      <span className="empty-record-dot" aria-hidden="true" />
      New recording
    </button>
  )
}

/**
 * The notes view with notes in the library but none selected: the state
 * behind choosing "All notes" from another screen (issue #24).
 */
function PickNoteArea({ onStartRecording }: { onStartRecording: () => void }) {
  return (
    <div style={emptyAreaStyle}>
      <div style={{ width: 520, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h1 className="empty-title">All notes</h1>
          <p className="empty-body">Pick a note from the library list to open it.</p>
        </div>
        <div>
          <NewRecordingButton onClick={onStartRecording} />
        </div>
      </div>
    </div>
  )
}

function EmptyNotesArea({ onStartRecording, onGoSettings }: { onStartRecording: () => void; onGoSettings: () => void }) {
  return (
    <div style={emptyAreaStyle}>
      <div style={{ width: 520, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h1 className="empty-title">Record your first meeting</h1>
          <p className="empty-body">
            Minute writes the transcript while you talk. When you stop, it writes a summary, the decisions, and the action
            items. Everything stays on this Mac.
          </p>
        </div>
        <div>
          <NewRecordingButton onClick={onStartRecording} />
        </div>
        <div className="empty-aside">
          <span>Want Minute to notice meetings for you?</span>
          <button type="button" className="empty-link" onClick={onGoSettings}>Meeting detection settings</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Header status, in priority order: "Finalizing transcript…" while the stt
 * worker flushes this note's tail, "Needs review" after an incomplete
 * capture, "Summarizing…" while a summary runs, then "Ready" or
 * "Transcribed". The finalizing check is keyed to this note's id, so it
 * never applies to another note.
 *
 * The `role="status"` wrapper is always mounted and only its children
 * change. Screen readers announce mutations to a live region that already
 * exists, and commonly miss one that mounts with its text inside.
 */
function StatusPill({
  meta,
  sttStatus,
  sttStatusNoteId,
  summaryStatus,
}: {
  meta: NoteMeta
  sttStatus: SttStatus
  sttStatusNoteId: string | null
  summaryStatus: SummaryStatus
}) {
  const finalizing = sttStatusNoteId === meta.id && sttStatus === 'finalizing'

  let content: ReactNode = null
  if (finalizing) {
    content = <span className="note-status" data-tone="busy"><span className="spin note-spinner" />Finalizing transcript…</span>
  } else if (meta.captureWarning) {
    content = <span className="note-status" data-tone="warn">Needs review</span>
  } else if (summaryStatus === 'running') {
    content = <span className="note-status" data-tone="busy"><span className="spin note-spinner" />Summarizing…</span>
  } else if (meta.status === 'ready') {
    content = <span className="note-status" data-tone="ok">Ready</span>
  } else if (meta.status === 'transcribed') {
    content = <span className="note-status" data-tone="ok">Transcribed</span>
  }

  return <span role="status">{content}</span>
}

/**
 * The note title. Clicking it, the pencil beside it, or "Rename" in the
 * note menu swaps the heading for an input set in the same type. Enter or
 * blur commits (skipped if blank or unchanged); Escape discards.
 */
function NoteTitle({
  title,
  editing,
  onEditingChange,
  onRename,
}: {
  title: string
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onRename: (title: string) => void
}) {
  const [draft, setDraft] = useState(title)
  const committedRef = useRef(false)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusAfterCommit()

  useEffect(() => {
    if (!editing) return
    setDraft(title)
    committedRef.current = false
    // Only the transition into editing seeds the draft; a title that changes
    // underneath an open editor must not overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  if (!editing) {
    return (
      <div className="note-title-row">
        <h1 className="note-title" onDoubleClick={() => onEditingChange(true)}>{title}</h1>
        <button
          ref={editButtonRef}
          type="button"
          title="Rename note"
          aria-label="Rename note"
          className="icon-btn note-title-edit"
          onClick={() => onEditingChange(true)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
          </svg>
        </button>
      </div>
    )
  }

  function restoreEditFocus() {
    requestFocus(() => editButtonRef.current)
  }

  function commit(restoreFocus = false) {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = draft.trim()
    onEditingChange(false)
    if (trimmed && trimmed !== title) onRename(trimmed)
    if (restoreFocus) restoreEditFocus()
  }

  function cancel() {
    committedRef.current = true
    onEditingChange(false)
    restoreEditFocus()
  }

  return (
    <div className="note-title-row">
      <input
        autoFocus
        className="note-title note-title-input"
        aria-label="Note title"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={() => commit()}
      />
    </div>
  )
}

/**
 * The note's markers: each time seeks playback, and each label can be
 * edited or deleted in place. Delete arms on the first press and offers an
 * exact Undo afterwards.
 */
function NoteMarkers({
  markers,
  seekable,
  onSeek,
  onUpdateMarker,
  onDeleteMarker,
  onRestoreMarker,
}: {
  markers: NoteMarker[]
  seekable: boolean
  onSeek: (seconds: number) => void
  onUpdateMarker: (index: number, label: string) => Promise<void>
  onDeleteMarker: (index: number) => Promise<void>
  onRestoreMarker: (marker: NoteMarker) => Promise<void>
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  const [deleteArmedIndex, setDeleteArmedIndex] = useState<number | null>(null)
  const [deletedMarker, setDeletedMarker] = useState<NoteMarker | null>(null)
  // The row whose Edit button takes focus when it next mounts. The button
  // only exists once the editor has closed, so focus moves in its ref
  // callback (at commit) rather than on a timer that could fire first.
  const focusEditIndexRef = useRef<number | null>(null)
  const undoButtonRef = useRef<HTMLButtonElement>(null)
  const sectionRef = useRef<HTMLDivElement>(null)
  const requestFocus = useFocusAfterCommit()

  function closeEditor(index: number) {
    focusEditIndexRef.current = index
    setEditingIndex(null)
    setDraft('')
  }

  async function saveMarker(index: number) {
    const label = draft.trim()
    if (!label || pendingIndex !== null) return
    setPendingIndex(index)
    try {
      await onUpdateMarker(index, label)
      closeEditor(index)
    } catch {
      // The shared error banner reports the failure. Keep the draft so the
      // user can retry without retyping it.
    } finally {
      setPendingIndex(null)
    }
  }

  async function deleteMarker(index: number) {
    if (deleteArmedIndex !== index) {
      setDeleteArmedIndex(index)
      return
    }
    setPendingIndex(index)
    try {
      const removed = markers[index]
      await onDeleteMarker(index)
      requestFocus(() => undoButtonRef.current)
      setDeletedMarker(removed ?? null)
      setDeleteArmedIndex(null)
      if (editingIndex === index) {
        setEditingIndex(null)
        setDraft('')
      }
    } catch {
      // Keep the row armed so a failed delete can be retried.
    } finally {
      setPendingIndex(null)
    }
  }

  if (markers.length === 0 && !deletedMarker) return null

  return (
    <div ref={sectionRef} className="note-markers-block" role="group" aria-label="Recording markers" tabIndex={-1}>
      {markers.length > 0 && (
        <ol className="note-markers">
          {markers.map((marker, index) => (
            <li key={`${marker.seconds}-${index}`}>
              <button
                type="button"
                className="marker-time-btn"
                disabled={!seekable}
                aria-label={seekable ? `Play from marker ${marker.label} at ${formatMmSs(marker.seconds)}` : `Marker at ${formatMmSs(marker.seconds)}, audio unavailable`}
                onClick={() => onSeek(marker.seconds)}
              >
                {formatMmSs(marker.seconds)}
              </button>
              {editingIndex === index ? (
                <form
                  className="inline-form"
                  onSubmit={event => {
                    event.preventDefault()
                    void saveMarker(index)
                  }}
                >
                  <input
                    autoFocus
                    aria-label={`Marker label at ${formatMmSs(marker.seconds)}`}
                    value={draft}
                    maxLength={100}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        closeEditor(index)
                      }
                    }}
                  />
                  <button type="submit" className="btn-small" disabled={!draft.trim() || pendingIndex !== null}>
                    {pendingIndex === index ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" className="btn-small" onClick={() => closeEditor(index)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span className="marker-label">{marker.label}</span>
                  <span className="marker-row-actions">
                    <button
                      ref={element => {
                        if (element && focusEditIndexRef.current === index) {
                          focusEditIndexRef.current = null
                          element.focus()
                        }
                      }}
                      type="button"
                      className="note-link"
                      data-tone="muted"
                      aria-label={`Edit marker ${marker.label}`}
                      onClick={() => {
                        setEditingIndex(index)
                        setDraft(marker.label)
                        setDeleteArmedIndex(null)
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="note-link"
                      data-tone={deleteArmedIndex === index ? 'danger' : 'muted'}
                      aria-label={deleteArmedIndex === index ? `Confirm delete marker ${marker.label}` : `Delete marker ${marker.label}`}
                      disabled={pendingIndex !== null}
                      onClick={() => void deleteMarker(index)}
                    >
                      {pendingIndex === index ? 'Deleting…' : deleteArmedIndex === index ? 'Confirm' : 'Delete'}
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {deletedMarker && (
        <div className="note-notice" role="status">
          <span>Marker “{deletedMarker.label}” deleted.</span>
          <span className="note-notice-actions">
            <button
              ref={undoButtonRef}
              type="button"
              className="btn-small"
              onClick={() => {
                void onRestoreMarker(deletedMarker).then(() => {
                  requestFocus(() => sectionRef.current)
                  setDeletedMarker(null)
                })
              }}
            >
              Undo
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

/** The toolbar's Obsidian line: the last good save, a save in flight, or the last failure. */
function ObsidianStatus({ status, saving }: { status: ObsidianExport | null; saving: boolean }) {
  if (saving) return <span className="toolbar-status" data-tone="muted" role="status">Saving to Obsidian…</span>
  if (status?.error) {
    return (
      <span className="toolbar-status" data-tone="error" role="status" title={status.error}>
        Not saved to Obsidian
      </span>
    )
  }
  if (status?.savedAt) {
    return (
      <span className="toolbar-status" role="status" title={status.path}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        Saved to Obsidian
      </span>
    )
  }
  return null
}

function formatNoteDate(createdAt: string, now: Date): string {
  const created = new Date(createdAt)
  const time = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(created)) / 86_400_000)
  const day =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : created.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  return `${day}, ${time}`
}

export function NoteView({
  meta,
  selectedMeta,
  selectedTranscript,
  selectedSummary,
  selectedMarkdown,
  selectedAudioPath,
  selectedNoteStorage,
  transcriptLoading,
  pendingSeek,
  onPendingSeekApplied,
  sttStatus,
  sttStatusNoteId,
  summaryStatus,
  summaryError,
  summaryWait,
  llmInstalled,
  llmModelName,
  askHistory,
  askStatus,
  llmBusy,
  hasNotes,
  obsidianEnabled,
  obsidianSaving,
  onSaveToObsidian,
  toolbarLead,
  onRename,
  onDelete,
  onReveal,
  onExport,
  onCopyError,
  onToggleActionItem,
  onRegenerateSummary,
  onCancelSummary,
  onSummarizeNow,
  onAsk,
  onGoSettings,
  onSetPinned,
  onAddMarker,
  onUpdateMarker,
  onDeleteMarker,
  onRenameSpeaker,
  onDismissSpeakerSuggestion,
  onMergeSpeakers,
  onMarkSpeakerUnknown,
  onUndoSpeakerMerge,
  diarStatus,
  diarError,
  canDetectSpeakers,
  onDetectSpeakers,
  onDeleteAudio,
  onStartRecording,
  processingFailure,
  onRetryProcessing,
  onDismissProcessing,
  justRecorded,
  summaryStyle,
}: NoteViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // The virtualized transcript needs the scroll container as a value it
  // can re-render on, so the element is kept in state as well as the ref.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const attachScroll = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    setScrollElement(element)
  }, [])
  const overlayReturnRef = useRef<HTMLElement | null>(null)
  const renameSpeakersRef = useRef<HTMLButtonElement>(null)
  const addMarkerButtonRef = useRef<HTMLButtonElement>(null)
  const requestFocus = useFocusAfterCommit()
  const [overlay, setOverlay] = useState<Overlay>(NO_OVERLAY)
  const [composer, setComposer] = useState<Composer>(NO_COMPOSER)
  const [titleEditing, setTitleEditing] = useState(false)
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerFilter>(ALL_SPEAKERS)
  const [speakerMergeUndo, setSpeakerMergeUndo] = useState<SpeakerMergeUndo | null>(null)
  const [speakerUndoPending, setSpeakerUndoPending] = useState(false)
  const [speakerDetectCount, setSpeakerDetectCount] = useState('auto')
  const [markerAddDraft, setMarkerAddDraft] = useState('')
  const [markerAddPending, setMarkerAddPending] = useState(false)
  const [audioDeletePending, setAudioDeletePending] = useState(false)

  // Computed ahead of the `!meta` early return below (hooks cannot be
  // conditional), though they mean nothing in that branch.
  const transcriptReady = meta !== null && selectedMeta?.id === meta.id
  const segments = transcriptReady ? selectedTranscript : EMPTY_SEGMENTS
  const showTranscriptLoading = transcriptLoading && !transcriptReady
  const summary = transcriptReady ? selectedSummary : null
  const markdown = transcriptReady ? selectedMarkdown : ''
  const audioPath = transcriptReady ? selectedAudioPath : null
  const detailMeta = transcriptReady && selectedMeta ? selectedMeta : meta
  const noteId = meta?.id ?? null
  const markers = detailMeta?.markers ?? []
  const roster = useMemo(() => speakerRoster(segments, detailMeta?.speakerSuggestions), [segments, detailMeta?.speakerSuggestions])
  const speakers = useMemo(() => roster.speakers.map(entry => entry.speaker), [roster])
  const speakerColors = useMemo(() => assignSpeakerColors(speakers), [speakers])
  const filteredSegments = useMemo(
    () => speakerFilter === ALL_SPEAKERS ? segments : segments.filter(segment => segment.speaker === speakerFilter),
    [segments, speakerFilter],
  )
  const displaySegments = useMemo(() => storedSegmentsToDisplay(filteredSegments), [filteredSegments])

  // Owns the single `<audio>` element for the selected note. Destructured so
  // the dependency arrays below can name exactly the fields they use:
  // `play`/`seek` and the rest are permanently stable identities, which keeps
  // `handleSeek` (and so TranscriptList's `onSeek` prop) stable too.
  const { playing, currentTime, duration, rate, failed, play, toggle, seek, skip, cycleRate } = useAudioPlayer(audioPath)

  // Whether this note's audio can be seeked into right now. The single
  // source of truth for every seek control: the player, transcript times,
  // marker times, and Ask citations all go inert together.
  const seekable = audioPath !== null && !failed

  // The audio element's duration once its metadata has loaded; before that,
  // the note's persisted duration, so the total does not flash "00:00".
  const durationSec = duration > 0 ? duration : (meta?.durationSec ?? 0)

  // Handed to TranscriptList as an index rather than raw `currentTime`, so
  // its memo re-renders only when playback crosses into another segment.
  // Gated on `playing` so a paused position never shows a stale highlight.
  const activeIndex = useMemo(
    () => (playing ? findActiveSegmentIndex(filteredSegments, currentTime) : -1),
    [filteredSegments, currentTime, playing],
  )

  useEffect(() => {
    setOverlay(NO_OVERLAY)
    setComposer(NO_COMPOSER)
    setTitleEditing(false)
    setSpeakerFilter(ALL_SPEAKERS)
    setSpeakerMergeUndo(null)
    setSpeakerUndoPending(false)
    setMarkerAddDraft('')
    setMarkerAddPending(false)
    setAudioDeletePending(false)
  }, [noteId])

  useLayoutEffect(() => {
    if (scrollRef.current && noteId) scrollRef.current.scrollTop = noteScrollPositions.get(noteId) ?? 0
  }, [noteId])

  const openOverlay = useCallback((next: Overlay, trigger: HTMLElement | null) => {
    overlayReturnRef.current = trigger
    setOverlay(next)
  }, [])

  // Returns focus to whatever opened the overlay, unless closing it already
  // moved focus somewhere deliberate (the title editor, an inline form).
  const closeOverlay = useCallback(() => {
    setOverlay(NO_OVERLAY)
    const trigger = overlayReturnRef.current
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      ;(trigger?.isConnected ? trigger : renameSpeakersRef.current)?.focus()
    })
  }, [])

  const closeMarkerComposer = useCallback(() => {
    requestFocus(() => addMarkerButtonRef.current)
    setComposer(NO_COMPOSER)
    setMarkerAddDraft('')
  }, [requestFocus])

  const saveAddedMarker = useCallback(async () => {
    if (!meta || composer.kind !== 'marker' || markerAddPending) return
    const label = markerAddDraft.trim()
    if (!label) return
    setMarkerAddPending(true)
    try {
      await onAddMarker(meta.id, composer.seconds, label)
      closeMarkerComposer()
    } catch {
      // The shared error banner owns the failure message. Keep the captured
      // timestamp and draft so a retry marks the same moment.
    } finally {
      setMarkerAddPending(false)
    }
  }, [closeMarkerComposer, composer, markerAddDraft, markerAddPending, meta, onAddMarker])

  // Seek and start playback: what a transcript time, a marker time, and an
  // Ask citation all do. Stable, which TranscriptList's memo depends on.
  const handleSeek = useCallback(
    (seconds: number) => {
      seek(seconds)
      play()
    },
    [seek, play],
  )

  // Runs after `useAudioPlayer`'s own effect (effects commit in declaration
  // order), so `audio.src` already points at this note. `seek` queues a seek
  // requested before `loadedmetadata`, so this need not wait for that.
  useEffect(() => {
    if (!meta || !pendingSeek || pendingSeek.noteId !== meta.id || !transcriptReady) return
    seek(pendingSeek.seconds)
    play()
    onPendingSeekApplied()
  }, [meta, pendingSeek, transcriptReady, seek, play, onPendingSeekApplied])

  // Per-note closures for the memoized children, stable until the note (or
  // the underlying handler) changes.
  const handleToggleAction = useCallback(
    (index: number, done: boolean) => {
      if (noteId) onToggleActionItem(noteId, index, done)
    },
    [noteId, onToggleActionItem],
  )
  const handleRegenerate = useCallback(() => {
    if (noteId) onRegenerateSummary(noteId)
  }, [noteId, onRegenerateSummary])
  const handleCancelSummary = useCallback(() => {
    if (noteId) onCancelSummary(noteId)
  }, [noteId, onCancelSummary])
  const handleSummarizeNow = useCallback(
    () => (noteId ? onSummarizeNow(noteId) : Promise.resolve(null)),
    [noteId, onSummarizeNow],
  )
  const handleAsk = useCallback(
    (question: string) => {
      if (noteId) onAsk(noteId, question)
    },
    [noteId, onAsk],
  )
  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) {
      onCopyError(new Error('Clipboard unavailable'))
      return
    }
    navigator.clipboard.writeText(markdown).catch(err => onCopyError(err))
  }, [markdown, onCopyError])

  if (!meta) {
    return (
      <main className="note-main">
        <AppToolbar lead={toolbarLead} />
        {hasNotes ? (
          <PickNoteArea onStartRecording={onStartRecording} />
        ) : (
          <EmptyNotesArea onStartRecording={onStartRecording} onGoSettings={onGoSettings} />
        )}
      </main>
    )
  }

  const now = new Date()
  const metaLine = noteMetaToListItem(meta, now).meta
  const pendingSteps = noteProcessingSteps({
    justRecorded,
    hasSummary: summary !== null,
    speakersRunning: diarStatus === 'running',
    summaryStatus,
    summaryModelInstalled: llmInstalled,
    summaryStyle,
  })
  const includedSystemAudio = meta.sources.includes('system')
  const suggestions = Object.entries(meta.speakerSuggestions ?? {})
  const overlayEntry = overlay.kind === 'speaker'
    ? roster.speakers.find(entry => entry.speaker === overlay.speaker)
    : undefined

  function showSpeakerMergeUndo(undo: SpeakerMergeUndo) {
    setSpeakerMergeUndo(undo)
    setSpeakerFilter(ALL_SPEAKERS)
  }
  const autoApplied = Object.entries(meta.speakerAutoApplied ?? {})
  const audioRemoved = (detailMeta ?? meta).audioDeleted
  const obsidianStatus = (detailMeta ?? meta).obsidian ?? null

  // One persistent announcer for both generation flows. At most one runs at
  // a time (they share the backend's single generation slot).
  const statusAnnouncement =
    summaryStatus === 'running'
      ? 'Summarizing on this Mac…'
      : summaryStatus === 'queued'
        ? 'Summary queued'
        : askStatus === 'running'
          ? 'Answering…'
          : ''

  function openSpeaker(speaker: string, chip: HTMLElement) {
    openOverlay({ kind: 'speaker', speaker, offsetLeft: chip.offsetLeft }, chip)
  }

  const menuActions: NoteMenuAction[] = [
    { id: 'pin', label: meta.pinned ? 'Unpin note' : 'Pin note', onSelect: () => onSetPinned(meta.id, !(meta.pinned ?? false)) },
    { id: 'rename', label: 'Rename', onSelect: () => setTitleEditing(true) },
    ...(canDetectSpeakers
      ? [{
          id: 'detect',
          label: diarStatus === 'running' ? 'Detecting speakers…' : 'Detect speakers again…',
          disabled: diarStatus === 'running',
          onSelect: () => setComposer({ kind: 'detect' }),
        }]
      : []),
    { id: 'copy', label: 'Copy as Markdown', startsGroup: true, onSelect: handleCopy },
    ...(obsidianEnabled
      ? [{
          id: 'obsidian',
          label: obsidianSaving ? 'Saving to Obsidian…' : 'Save to Obsidian again',
          disabled: obsidianSaving,
          onSelect: () => onSaveToObsidian(meta.id),
        }]
      : []),
    {
      id: 'reveal',
      label: 'Show in Finder',
      detail: selectedNoteStorage ? formatBytes(selectedNoteStorage.totalBytes) : undefined,
      onSelect: () => onReveal(meta.id),
    },
    {
      id: 'delete-audio',
      label: audioRemoved ? 'Audio removed' : audioDeletePending ? 'Deleting audio…' : 'Delete audio only',
      detail: !audioRemoved && selectedNoteStorage ? formatBytes(selectedNoteStorage.audioBytes) : undefined,
      startsGroup: true,
      disabled: audioRemoved || audioDeletePending,
      confirm: {
        label: 'Confirm delete audio',
        note: 'Keeps the transcript, summary, markers, and Markdown. This cannot be undone.',
      },
      onSelect: () => {
        setAudioDeletePending(true)
        void onDeleteAudio()
          .catch(() => {
            // The shared error banner reports the failure.
          })
          .finally(() => setAudioDeletePending(false))
      },
    },
    {
      id: 'delete',
      label: 'Delete note',
      destructive: true,
      confirm: { label: 'Confirm delete note' },
      onSelect: () => onDelete(meta.id),
    },
  ]

  return (
    <main className="note-main">
      <AppToolbar lead={toolbarLead}>
        {obsidianEnabled && <ObsidianStatus status={obsidianStatus} saving={obsidianSaving} />}
        <button
          type="button"
          className="toolbar-btn"
          aria-haspopup="dialog"
          aria-expanded={overlay.kind === 'ask'}
          onClick={event => (overlay.kind === 'ask' ? closeOverlay() : openOverlay({ kind: 'ask' }, event.currentTarget))}
        >
          Ask
        </button>
        <button type="button" className="toolbar-btn" title="Export this note as Markdown" onClick={() => onExport(meta.id)}>
          Export
        </button>
        <button
          type="button"
          className="toolbar-btn"
          data-icon="true"
          aria-label="More note actions"
          title="More"
          aria-haspopup="menu"
          aria-expanded={overlay.kind === 'menu'}
          onClick={event => openOverlay({ kind: 'menu' }, event.currentTarget)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </AppToolbar>

      <span role="status" className="visually-hidden">{statusAnnouncement}</span>

      <div
        ref={attachScroll}
        className="note-scroll"
        data-testid="note-scroll"
        onScroll={event => noteScrollPositions.set(meta.id, event.currentTarget.scrollTop)}
      >
        <div className="note-column">
          <header className="note-head">
            <div className="note-head-title">
              <NoteTitle
                title={meta.title}
                editing={titleEditing}
                onEditingChange={setTitleEditing}
                onRename={title => onRename(meta.id, title)}
              />
              <div className="note-meta">
                <span>
                  {formatNoteDate(meta.createdAt, now)} · {metaLine}{includedSystemAudio ? ' · Mic + system audio' : ''}
                </span>
                <StatusPill meta={meta} sttStatus={sttStatus} sttStatusNoteId={sttStatusNoteId} summaryStatus={summaryStatus} />
              </div>
            </div>

            {speakers.length > 0 && (
              <div className="speaker-chips">
                {speakers.map(speaker => (
                  <button
                    key={speaker}
                    type="button"
                    className="speaker-chip"
                    data-speaker={speaker}
                    style={speakerColorStyle(speakerColors, speaker)}
                    aria-label={`Rename ${speaker}`}
                    aria-haspopup="dialog"
                    aria-expanded={overlay.kind === 'speaker' && overlay.speaker === speaker}
                    onClick={event => openSpeaker(speaker, event.currentTarget)}
                  >
                    <span className="speaker-dot" aria-hidden="true" />
                    {speaker}
                  </button>
                ))}
                <button
                  ref={renameSpeakersRef}
                  type="button"
                  className="note-link"
                  onClick={event => {
                    // Opens on the first speaker that still has a generic
                    // label, since that is the one most likely to need a name.
                    const target = speakers.find(speaker => /^Speaker \d+$/.test(speaker)) ?? speakers[0]
                    const chips = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('.speaker-chip') ?? [])
                    const chip = chips.find(element => element.dataset.speaker === target)
                    openOverlay({ kind: 'speaker', speaker: target, offsetLeft: chip?.offsetLeft ?? 0 }, event.currentTarget)
                  }}
                >
                  Rename speakers
                </button>
                {overlay.kind === 'speaker' && overlayEntry && (
                  <SpeakerPopover
                    key={overlayEntry.speaker}
                    entry={overlayEntry}
                    otherSpeakers={speakers.filter(speaker => speaker !== overlayEntry.speaker)}
                    colorStyle={speakerColorStyle(speakerColors, overlayEntry.speaker)}
                    offsetLeft={overlay.offsetLeft}
                    onRename={name => onRenameSpeaker(meta.id, overlayEntry.speaker, name)}
                    onDismissSuggestion={() => onDismissSpeakerSuggestion(meta.id, overlayEntry.speaker)}
                    onMerge={into => onMergeSpeakers(meta.id, overlayEntry.speaker, into).then(showSpeakerMergeUndo)}
                    onMarkUnknown={() => onMarkSpeakerUnknown(meta.id, overlayEntry.speaker).then(showSpeakerMergeUndo)}
                    onClose={closeOverlay}
                  />
                )}
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="note-notice-list" role="group" aria-label="Speaker name suggestions">
                {suggestions.map(([label, suggestion]) => (
                  <div key={label} className="note-notice">
                    <span><strong>{label}</strong> sounds like <strong>{suggestion.name}</strong></span>
                    <span className="note-notice-actions">
                      <button
                        type="button"
                        className="btn-small"
                        aria-label={`Rename ${label} to ${suggestion.name}`}
                        onClick={() => onRenameSpeaker(meta.id, label, suggestion.name)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn-small"
                        aria-label={`Dismiss suggestion for ${label}`}
                        onClick={() => onDismissSpeakerSuggestion(meta.id, label)}
                      >
                        Dismiss
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* Issue #32: names the diarization pass wrote in on its own.
                Undo is an ordinary rename back to the raw label, which also
                clears the entry server-side. */}
            {autoApplied.length > 0 && (
              <div className="note-notice-list" role="group" aria-label="Automatically applied speaker names">
                {autoApplied.map(([label, applied]) => (
                  <div key={label} className="note-notice">
                    <span><strong>{label}</strong> auto-renamed to <strong>{applied.name}</strong></span>
                    <span className="note-notice-actions">
                      <button
                        type="button"
                        className="btn-small"
                        aria-label={`Undo renaming ${label} to ${applied.name}`}
                        onClick={() => onRenameSpeaker(meta.id, applied.name, label)}
                      >
                        Undo
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {speakerMergeUndo && (
              <div className="note-notice">
                <span role="status">
                  {speakerMergeUndo.into === null
                    ? <>Turns from <strong>{speakerMergeUndo.from}</strong> marked as unknown.</>
                    : <><strong>{speakerMergeUndo.from}</strong> merged into <strong>{speakerMergeUndo.into}</strong>.</>}
                </span>
                <span className="note-notice-actions">
                  <button
                    type="button"
                    className="btn-small"
                    disabled={speakerUndoPending}
                    onClick={() => {
                      setSpeakerUndoPending(true)
                      void onUndoSpeakerMerge(meta.id, speakerMergeUndo)
                        .then(() => setSpeakerMergeUndo(null))
                        .catch(() => {
                          // Keep the Undo so a failed save can be retried.
                        })
                        .finally(() => setSpeakerUndoPending(false))
                    }}
                  >
                    {speakerUndoPending ? 'Undoing…' : 'Undo'}
                  </button>
                </span>
              </div>
            )}
            {diarStatus === 'error' && diarError && (
              <div className="note-notice" data-tone="error" role="status">
                <span>Speaker detection failed: {diarError}</span>
              </div>
            )}
            {processingFailure?.stage === 'preparing' && (
              <div className="note-notice" data-tone="error" role="status">
                <span>
                  <strong>The recording is saved, but the library did not refresh.</strong>{' '}
                  {processingFailure.message}
                </span>
                <span className="note-notice-actions">
                  <button type="button" className="btn-small" onClick={onRetryProcessing}>Retry refresh</button>
                  <button type="button" className="btn-small" onClick={onDismissProcessing}>Dismiss</button>
                </span>
              </div>
            )}
            {meta.captureWarning && (
              <div className="note-notice" data-tone="error" role="status">
                <span>
                  <strong>Part of this recording may be missing.</strong>{' '}
                  {meta.captureWarning} Existing audio and transcript content were preserved.
                </span>
              </div>
            )}
          </header>

          {pendingSteps ? (
            <ProcessingStepList
              steps={pendingSteps}
              onSkipSummary={handleCancelSummary}
              note="You can open another note. Minute finishes this one in the background."
            />
          ) : (
            <NoteSummary
              summary={summary}
              status={summaryStatus}
              error={summaryError}
              modelName={llmModelName}
              llmInstalled={llmInstalled}
              onGenerate={handleRegenerate}
              onCancel={handleCancelSummary}
              wait={summaryWait}
              onSummarizeNow={handleSummarizeNow}
              onToggleAction={handleToggleAction}
              onGoSettings={onGoSettings}
            />
          )}

          <section className="note-section note-transcript" aria-labelledby="note-transcript-heading">
            <div className="note-section-head">
              <h2 id="note-transcript-heading" className="note-h">Transcript</h2>
              <div className="note-section-aside" title="↑ and ↓ move between turns">
                {[
                  markers.length > 0 ? `${markers.length} ${markers.length === 1 ? 'marker' : 'markers'}` : null,
                  seekable ? 'Click a time to play' : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
            {showTranscriptLoading ? (
              <p className="note-muted">Loading transcript…</p>
            ) : (
              <>
                <div className="transcript-tools">
                  <select
                    aria-label="Filter transcript by speaker"
                    value={speakerFilter ?? UNKNOWN_FILTER_VALUE}
                    onChange={event => setSpeakerFilter(event.target.value === UNKNOWN_FILTER_VALUE ? null : event.target.value)}
                  >
                    <option value={ALL_SPEAKERS}>All speakers</option>
                    {speakers.map(speaker => <option key={speaker} value={speaker}>{speaker}</option>)}
                    {roster.unknownTurns > 0 && <option value={UNKNOWN_FILTER_VALUE}>{UNKNOWN_SPEAKER_LABEL}</option>}
                  </select>
                  <span className="transcript-tools-end">
                    {canDetectSpeakers && composer.kind !== 'detect' && (
                      <button
                        type="button"
                        className="note-link"
                        disabled={diarStatus === 'running'}
                        onClick={() => setComposer({ kind: 'detect' })}
                      >
                        {diarStatus === 'running' ? 'Detecting speakers…' : 'Detect speakers'}
                      </button>
                    )}
                    <button
                      ref={addMarkerButtonRef}
                      type="button"
                      className="note-link"
                      disabled={!seekable || composer.kind === 'marker'}
                      aria-label={seekable ? `Add marker at ${formatMmSs(currentTime)}` : 'Add marker unavailable without audio'}
                      title={seekable ? `Mark ${formatMmSs(currentTime)}` : 'Audio is unavailable'}
                      onClick={() => {
                        setComposer({ kind: 'marker', seconds: currentTime })
                        setMarkerAddDraft('')
                      }}
                    >
                      Add marker
                    </button>
                  </span>
                </div>
                {composer.kind === 'detect' && (
                  <form
                    className="inline-form"
                    onKeyDown={event => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setComposer(NO_COMPOSER)
                      }
                    }}
                    onSubmit={event => {
                      event.preventDefault()
                      onDetectSpeakers(meta.id, speakerDetectCount === 'auto' ? null : Number(speakerDetectCount))
                      setComposer(NO_COMPOSER)
                    }}
                  >
                    <span>Number of speakers</span>
                    <select
                      autoFocus
                      aria-label="Number of speakers"
                      value={speakerDetectCount}
                      onChange={event => setSpeakerDetectCount(event.target.value)}
                    >
                      <option value="auto">Auto</option>
                      {[2, 3, 4, 5, 6, 7, 8].map(n => (
                        <option key={n} value={String(n)}>{n}</option>
                      ))}
                    </select>
                    <button type="submit" className="btn-small" data-variant="primary">Detect</button>
                    <button type="button" className="btn-small" onClick={() => setComposer(NO_COMPOSER)}>Cancel</button>
                  </form>
                )}
                {composer.kind === 'marker' && (
                  <form
                    className="inline-form"
                    onSubmit={event => {
                      event.preventDefault()
                      void saveAddedMarker()
                    }}
                  >
                    <span className="inline-form-time">{formatMmSs(composer.seconds)}</span>
                    <input
                      autoFocus
                      aria-label={`New marker label at ${formatMmSs(composer.seconds)}`}
                      placeholder="What happened here?"
                      value={markerAddDraft}
                      maxLength={100}
                      disabled={markerAddPending}
                      onChange={event => setMarkerAddDraft(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Escape' && !markerAddPending) {
                          event.preventDefault()
                          closeMarkerComposer()
                        }
                      }}
                    />
                    <button type="submit" className="btn-small" data-variant="primary" disabled={!markerAddDraft.trim() || markerAddPending}>
                      {markerAddPending ? 'Saving…' : 'Save marker'}
                    </button>
                    <button type="button" className="btn-small" disabled={markerAddPending} onClick={closeMarkerComposer}>
                      Cancel
                    </button>
                  </form>
                )}
                <NoteMarkers
                  markers={markers}
                  seekable={seekable}
                  onSeek={handleSeek}
                  onUpdateMarker={(index, label) => onUpdateMarker(meta.id, index, label)}
                  onDeleteMarker={index => onDeleteMarker(meta.id, index)}
                  onRestoreMarker={marker => onAddMarker(meta.id, marker.seconds, marker.label)}
                />
                {filteredSegments.length === 0 && speakerFilter !== ALL_SPEAKERS ? (
                  <p className="note-muted">
                    No transcript turns match this speaker.{' '}
                    <button type="button" className="note-link" onClick={() => setSpeakerFilter(ALL_SPEAKERS)}>Show all speakers</button>
                  </p>
                ) : (
                  <TranscriptList
                    segments={displaySegments}
                    activeIndex={activeIndex}
                    onSeek={handleSeek}
                    seekable={seekable}
                    scrollElement={scrollElement}
                    speakerColors={speakerColors}
                  />
                )}
              </>
            )}
          </section>
        </div>
      </div>

      <PlayerBar
        audioPath={audioPath}
        failed={failed}
        playing={playing}
        currentTime={currentTime}
        durationSec={durationSec}
        rate={rate}
        onToggle={toggle}
        onSkip={skip}
        onSeek={seek}
        onCycleRate={cycleRate}
      />

      {overlay.kind === 'ask' && (
        <AskPanel
          llmInstalled={llmInstalled}
          askHistory={askHistory}
          askStatus={askStatus}
          llmBusy={llmBusy}
          seekable={seekable}
          onAsk={handleAsk}
          onSeekCitation={handleSeek}
          onGoSettings={onGoSettings}
          onClose={closeOverlay}
        />
      )}
      {overlay.kind === 'menu' && (
        <NoteMenu label={`Actions for “${meta.title}”`} actions={menuActions} onClose={closeOverlay} />
      )}
    </main>
  )
}
