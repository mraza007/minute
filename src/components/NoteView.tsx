import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type {
  NoteMarker,
  NoteMeta,
  NoteStorageStats,
  SpeakerMergeUndo,
  StoredSegment,
  SummaryDoc,
} from '../ipc/types'
import type { NoteTab, SttStatus } from '../types'
import { findActiveSegmentIndex, formatBytes, formatMmSs, noteMetaToListItem, storedSegmentsToDisplay } from '../state/adapters'
import { useAudioPlayer } from '../state/useAudioPlayer'
import type { ProcessingFailure, SummaryStatus } from '../state/useAppState'
import type { AskHistoryEntry, AskStatus } from '../state/useNoteDetail'
import { AiNotesPanel } from './AiNotesPanel'
import { MarkdownCard } from './MarkdownCard'
import { PlayerBar } from './PlayerBar'
import { TranscriptList } from './TranscriptList'

/**
 * Explicit, narrow props — replaces the old `{ state: AppState }` blob prop
 * (carried debt cleared in Stage 3 Task 5): every field here is something
 * this component actually reads, so its test fixtures shrink to match
 * rather than having to fake the entire app-state surface. `meta` is the
 * selected note's list-level metadata (from `notes[sel]`, resolved by the
 * caller — `null` renders the empty-library state); `selectedMeta`/
 * `selectedTranscript`/`selectedSummary`/`selectedMarkdown` are the async
 * `get_note` fetch for whichever note was selected *when that fetch
 * started* — only trusted once `selectedMeta.id` matches `meta.id` (see
 * `transcriptReady` below), so a still-in-flight fetch for a
 * just-abandoned selection can never flash a previous (or coming) note's
 * data here.
 */
export interface NoteViewProps {
  meta: NoteMeta | null
  selectedMeta: NoteMeta | null
  selectedTranscript: StoredSegment[]
  selectedSummary: SummaryDoc | null
  selectedMarkdown: string
  /** This note's `audio.wav` path from `get_note`, or `null` if it doesn't exist on disk — same staleness contract as `selectedTranscript`/`selectedSummary`/`selectedMarkdown` (only trusted once `selectedMeta.id` matches `meta.id`). Feeds `useAudioPlayer`; `null` renders PlayerBar's disabled "Audio removed" state. A non-null path that then fails to actually load (see `useAudioPlayer`'s `failed`) renders the same disabled affordances with different, honest copy — "Audio unavailable" — since the file wasn't necessarily removed. */
  selectedAudioPath: string | null
  selectedNoteStorage: NoteStorageStats | null
  transcriptLoading: boolean
  /**
   * A ⌘K search palette "open this transcript hit" request still waiting to
   * be applied — `{ noteId, seconds }` if the palette asked to seek `meta`
   * (matched by id) to `seconds`, `null` otherwise. Applied by an effect
   * below once this note's audio is actually ready (`transcriptReady`) —
   * `seek`/`play` are safe to call before that too (the audio hook queues a
   * seek requested before metadata loads), but gating on `transcriptReady`
   * avoids calling them against a still-stale `audioPath` left over from
   * whatever note was selected before this one.
   */
  pendingSeek: { noteId: string; seconds: number } | null
  /** Called once `pendingSeek` has been applied (or found not to apply to this note) — clears it so it isn't re-applied on a later re-render. */
  onPendingSeekApplied: () => void
  noteTab: NoteTab
  setNoteTab: (tab: NoteTab) => void
  sttStatus: SttStatus
  sttStatusNoteId: string | null
  /** This note's summarization lifecycle, from `summaryStatus[meta.id]` — `'idle'` if no `summary-status` event has been seen for it this session. */
  summaryStatus: SummaryStatus
  summaryError?: string
  /** This note's speaker-detection lifecycle — same collapsed shape as `summaryStatus` ('done' reads as 'idle'). */
  diarStatus: SummaryStatus
  diarError?: string
  /** Whether both diarization models are installed — gates the "Detect speakers" affordance in the transcript toolbar. */
  canDetectSpeakers: boolean
  /** Queues the diarization pass; `numSpeakers` forces an exact count, `null` = automatic. */
  onDetectSpeakers: (id: string, numSpeakers?: number | null) => void
  llmInstalled: boolean
  llmModelName: string
  /** This note's ask-your-notes session history (newest first) — from `useNoteDetail`'s `askHistory`, already scoped to whichever note is selected. */
  askHistory: AskHistoryEntry[]
  /** This note's ask lifecycle — `'idle'` if no `ask-status` event has been seen for it this session. */
  askStatus: AskStatus
  /** Whether any LLM generation (a summarize or an ask, for any note) is in flight app-wide — see `useNoteDetail`'s `llmBusy` docs. */
  llmBusy: boolean
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onReveal: (id: string) => void
  onCopyError: (err: unknown) => void
  onToggleActionItem: (id: string, index: number, done: boolean) => void
  onRegenerateSummary: (id: string) => void
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
  onUndoSpeakerMerge: (id: string, undo: SpeakerMergeUndo) => Promise<void>
  onDeleteAudio: () => Promise<void>
  onStartRecording: () => void
  processingFailure: ProcessingFailure | null
  onRetryProcessing: () => void
  onDismissProcessing: () => void
}

const DELETE_CONFIRM_TIMEOUT_MS = 4000

// A single stable reference for the "not ready yet" case — a fresh `[]`
// literal on every render would defeat `displaySegments`'s useMemo below
// (and its own exhaustive-deps lint) despite being value-equal every time.
const EMPTY_SEGMENTS: StoredSegment[] = []

function EmptyNotesArea({ onStartRecording }: { onStartRecording: () => void }) {
  return (
    <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel)' }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400, letterSpacing: '-.01em' }}>No notes yet</h1>
        <div style={{ marginTop: 8, fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
          Hit "New recording" in the title bar to capture your first meeting — transcription happens entirely on this
          Mac.
        </div>
        <button type="button" className="btn-solid" style={{ marginTop: 18 }} onClick={onStartRecording}>
          Start a recording
        </button>
      </div>
    </main>
  )
}

function NoteOverview({
  meta,
  summary,
  segments,
  markers,
  summaryStatus,
  summaryError,
  llmInstalled,
  onGenerate,
  onToggleAction,
  onOpenTranscript,
  onFocusAsk,
  onExport,
  onUpdateMarker,
  onDeleteMarker,
  onRestoreMarker,
  storage,
  onDeleteAudio,
}: {
  meta: NoteMeta
  summary: SummaryDoc | null
  segments: StoredSegment[]
  markers: NoteMarker[]
  summaryStatus: SummaryStatus
  summaryError?: string
  llmInstalled: boolean
  onGenerate: () => void
  onToggleAction: (index: number, done: boolean) => void
  onOpenTranscript: (seconds?: number) => void
  onFocusAsk: () => void
  onExport: () => void
  onUpdateMarker: (index: number, label: string) => Promise<void>
  onDeleteMarker: (index: number) => Promise<void>
  onRestoreMarker: (marker: NoteMarker) => Promise<void>
  storage: NoteStorageStats | null
  onDeleteAudio: () => Promise<void>
}) {
  const [editingMarkerIndex, setEditingMarkerIndex] = useState<number | null>(null)
  const [markerDraft, setMarkerDraft] = useState('')
  const [pendingMarkerIndex, setPendingMarkerIndex] = useState<number | null>(null)
  const [deleteArmedIndex, setDeleteArmedIndex] = useState<number | null>(null)
  const [deletedMarkerUndo, setDeletedMarkerUndo] = useState<NoteMarker | null>(null)
  const [audioDeleteArmed, setAudioDeleteArmed] = useState(false)
  const [audioDeletePending, setAudioDeletePending] = useState(false)
  const markerEditButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const markerUndoButtonRef = useRef<HTMLButtonElement>(null)
  const markersSectionRef = useRef<HTMLElement>(null)

  function closeMarkerEditor(index: number) {
    setEditingMarkerIndex(null)
    setMarkerDraft('')
    requestAnimationFrame(() => markerEditButtonRefs.current[index]?.focus())
  }

  async function saveMarker(index: number) {
    const label = markerDraft.trim()
    if (!label || pendingMarkerIndex !== null) return
    setPendingMarkerIndex(index)
    try {
      await onUpdateMarker(index, label)
      closeMarkerEditor(index)
    } catch {
      // The shared error banner reports the persistence failure; retain the
      // draft so the user can retry without retyping it.
    } finally {
      setPendingMarkerIndex(null)
    }
  }

  async function deleteMarker(index: number) {
    if (deleteArmedIndex !== index) {
      setDeleteArmedIndex(index)
      return
    }
    setPendingMarkerIndex(index)
    try {
      const removedMarker = markers[index]
      await onDeleteMarker(index)
      setDeletedMarkerUndo(removedMarker ?? null)
      setDeleteArmedIndex(null)
      requestAnimationFrame(() => markerUndoButtonRef.current?.focus())
      if (editingMarkerIndex === index) {
        setEditingMarkerIndex(null)
        setMarkerDraft('')
      }
    } catch {
      // Keep the armed row in place so a failed delete remains recoverable.
    } finally {
      setPendingMarkerIndex(null)
    }
  }

  return (
    <div className="note-overview">
      <div className="overview-measures" aria-label="Note overview">
        <div><span>Duration</span><strong>{formatMmSs(meta.durationSec)}</strong></div>
        <div><span>Speakers</span><strong>{meta.speakers}</strong></div>
        <div><span>Transcript</span><strong>{segments.length} turns</strong></div>
        <div><span>Markers</span><strong>{markers.length}</strong></div>
      </div>

      <div className="overview-actions" aria-label="Note actions">
        <button type="button" onClick={() => onOpenTranscript()}>Open transcript</button>
        <button type="button" onClick={onFocusAsk}>Ask this note</button>
        <button type="button" onClick={onExport}>Export</button>
      </div>

      {summaryStatus === 'error' && (
        <section className="overview-recovery" role="alert">
          <div className="mlab">Summary unavailable</div>
          <p>{summaryError || 'Minute could not generate the summary. The transcript and audio are still available.'}</p>
          <button type="button" className="btn-outline" onClick={onGenerate}>Retry summary</button>
        </section>
      )}

      {summary ? (
        <div className="overview-columns">
          <section>
            <div className="sec-head"><span className="mlab">Summary</span></div>
            <p className="overview-summary">{summary.summary}</p>
          </section>
          {/* Issue #14: only present for notes summarized under Detailed. */}
          {summary.topics.length > 0 && (
            <section>
              <div className="sec-head"><span className="mlab">Topics · {summary.topics.length}</span></div>
              {summary.topics.map((topic, index) => (
                <div key={`${topic.title}-${index}`} className="overview-topic">
                  <div className="overview-topic-title">{topic.title}</div>
                  {topic.summary && <p className="overview-summary">{topic.summary}</p>}
                </div>
              ))}
            </section>
          )}
          <section>
            <div className="sec-head"><span className="mlab">Decisions · {summary.decisions.length}</span></div>
            {summary.decisions.length > 0 ? (
              <ul className="sec-list">
                {summary.decisions.map((decision, index) => <li key={`${decision}-${index}`}>{decision}</li>)}
              </ul>
            ) : <p className="overview-empty">No decisions were identified.</p>}
          </section>
          <section className="overview-actions-section">
            <div className="sec-head"><span className="mlab">Action items · {summary.actionItems.length}</span></div>
            {summary.actionItems.length > 0 ? (
              <ul className="overview-checklist">
                {summary.actionItems.map((item, index) => (
                  <li key={`${item.text}-${index}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={event => onToggleAction(index, event.target.checked)}
                      />
                      <span>{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : <p className="overview-empty">No action items were identified.</p>}
          </section>
        </div>
      ) : summaryStatus !== 'error' ? (
        <section className="overview-empty-summary">
          <div className="mlab">
            {summaryStatus === 'running'
              ? 'Summary in progress'
              : summaryStatus === 'queued'
                ? 'Summary queued'
                : 'Summary not generated'}
          </div>
          <p>
            {summaryStatus === 'running'
              ? 'The transcript stays available while Minute prepares the overview.'
              : summaryStatus === 'queued'
                ? 'Another summary is running. This one starts on its own when that finishes.'
                : llmInstalled
                  ? 'Generate a local summary to surface decisions and action items.'
                  : 'Install a summary model in Settings to generate decisions and action items.'}
          </p>
          {/* No Generate button while running *or* queued (issue #11) —
              the work is already scheduled, and offering the button again
              is how the same note gets summarized twice. */}
          {llmInstalled && summaryStatus !== 'running' && summaryStatus !== 'queued' && (
            <button type="button" className="btn-solid" onClick={onGenerate}>Generate summary</button>
          )}
        </section>
      ) : null}

      <section
        ref={markersSectionRef}
        className="overview-markers"
        aria-label="Recording markers"
        tabIndex={-1}
      >
        <div className="sec-head"><span className="mlab">Markers · {markers.length}</span></div>
        {markers.length > 0 ? (
          <ol>
            {markers.map((marker, index) => (
              <li key={`${marker.seconds}-${index}`}>
                <button type="button" onClick={() => onOpenTranscript(marker.seconds)}>{formatMmSs(marker.seconds)}</button>
                {editingMarkerIndex === index ? (
                  <form
                    className="marker-edit-form"
                    onSubmit={event => {
                      event.preventDefault()
                      void saveMarker(index)
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={`Marker label at ${formatMmSs(marker.seconds)}`}
                      value={markerDraft}
                      maxLength={100}
                      onChange={event => setMarkerDraft(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          closeMarkerEditor(index)
                        }
                      }}
                    />
                    <button type="submit" disabled={!markerDraft.trim() || pendingMarkerIndex !== null}>
                      {pendingMarkerIndex === index ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => closeMarkerEditor(index)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span>{marker.label}</span>
                    <span className="marker-row-actions">
                      <button
                        ref={element => {
                          markerEditButtonRefs.current[index] = element
                        }}
                        type="button"
                        aria-label={`Edit marker ${marker.label}`}
                        onClick={() => {
                          setEditingMarkerIndex(index)
                          setMarkerDraft(marker.label)
                          setDeleteArmedIndex(null)
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={
                          deleteArmedIndex === index
                            ? `Confirm delete marker ${marker.label}`
                            : `Delete marker ${marker.label}`
                        }
                        data-danger={deleteArmedIndex === index ? 'true' : 'false'}
                        disabled={pendingMarkerIndex !== null}
                        onClick={() => void deleteMarker(index)}
                      >
                        {pendingMarkerIndex === index
                          ? 'Deleting…'
                          : deleteArmedIndex === index
                            ? 'Confirm'
                            : 'Delete'}
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ol>
        ) : <p className="overview-empty">No markers were added during this recording.</p>}
      </section>

      {deletedMarkerUndo && (
        <div className="overview-undo" role="status">
          <span>Marker “{deletedMarkerUndo.label}” deleted.</span>
          <button
            ref={markerUndoButtonRef}
            type="button"
            onClick={() => {
              void onRestoreMarker(deletedMarkerUndo).then(() => {
                setDeletedMarkerUndo(null)
                requestAnimationFrame(() => markersSectionRef.current?.focus())
              })
            }}
          >
            Undo
          </button>
        </div>
      )}

      <section className="overview-storage">
        <div className="sec-head"><span className="mlab">Local storage</span></div>
        <div className="overview-storage-line">
          <span>
            {storage
              ? `${formatBytes(storage.totalBytes)} total · ${formatBytes(storage.audioBytes)} audio · ${formatBytes(storage.documentBytes)} notes`
              : 'Calculating local storage…'}
          </span>
          {meta.audioDeleted ? (
            <span className="overview-storage-removed">Original audio removed</span>
          ) : (
            <button
              type="button"
              data-danger={audioDeleteArmed ? 'true' : 'false'}
              disabled={audioDeletePending}
              onClick={() => {
                if (!audioDeleteArmed) {
                  setAudioDeleteArmed(true)
                  return
                }
                setAudioDeletePending(true)
                void onDeleteAudio()
                  .then(() => setAudioDeleteArmed(false))
                  .finally(() => setAudioDeletePending(false))
              }}
            >
              {audioDeletePending ? 'Removing…' : audioDeleteArmed ? 'Confirm remove audio' : 'Remove original audio'}
            </button>
          )}
        </div>
        <p>Removing audio keeps the transcript, summary, markers, and Markdown. This cannot be undone.</p>
      </section>
    </div>
  )
}

/**
 * Header status, set as a micro label with a dot rather than the bordered
 * pill it used to be. A pill is a badge; this is a caption on a document,
 * and it sits next to a 28px serif title that should stay the loudest thing
 * in the header.
 */
const pillBaseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--sans)',
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.11em',
  textTransform: 'uppercase',
  flex: 'none',
} as const

/**
 * Header status pill — priority order (highest first): "Finalizing
 * transcript…" (red spinner) while the stt worker is still flushing this
 * note's tail window, "Summarizing…" (same spinner language) while a
 * summarization is running for it, a green "Ready" pill once it has a
 * persisted summary, else a green "Transcribed" pill once it's reached that
 * status, else no pill at all (still recording). The finalizing check is
 * keyed off `sttStatusNoteId` matching this note specifically — not just
 * "any recording is finalizing" — so it never applies to the wrong note.
 *
 * The outer `role="status"` wrapper is *always* mounted (present the whole
 * time the note header renders) — only what's inside it changes between
 * renders. A `role="status"` element that instead gets conditionally
 * mounted/unmounted with its announcement text already inside is commonly
 * missed by screen readers (they reliably pick up *mutations* to an
 * already-present live region, not a whole new subtree appearing with
 * content baked in); keeping one stable wrapper here and only swapping its
 * children is what makes each of these state changes reliably announced.
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

  const spinner = (
    <span
      className="spin"
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        border: '2px solid rgba(var(--accent-rgb), .25)',
        borderTopColor: 'var(--accent)',
        animation: 'spin .8s linear infinite',
        flex: 'none',
      }}
    />
  )
  const okDot = <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ok-text)' }} />

  if (finalizing) {
    content = (
      <span style={{ ...pillBaseStyle, color: 'var(--accent-text)' }}>
        {spinner}
        Finalizing transcript…
      </span>
    )
  } else if (meta.captureWarning) {
    content = (
      <span style={{ ...pillBaseStyle, color: 'var(--accent-text)' }}>
        <span aria-hidden="true">!</span>
        Needs review
      </span>
    )
  } else if (summaryStatus === 'running') {
    content = (
      <span style={{ ...pillBaseStyle, color: 'var(--accent-text)' }}>
        {spinner}
        Summarizing…
      </span>
    )
  } else if (meta.status === 'ready') {
    content = (
      <span style={{ ...pillBaseStyle, color: 'var(--ok-text)' }}>
        {okDot}
        Ready
      </span>
    )
  } else if (meta.status === 'transcribed') {
    content = (
      <span style={{ ...pillBaseStyle, color: 'var(--ok-text)' }}>
        {okDot}
        Transcribed
      </span>
    )
  }

  return <span role="status">{content}</span>
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'note'
}

interface NoteTitleProps {
  meta: NoteMeta
  onRename: (title: string) => void
}

/** Shared between the static heading and its inline edit field, so swapping
 *  one for the other doesn't shift the title by a pixel. */
const titleTypeStyle = {
  fontFamily: 'var(--serif)',
  fontWeight: 400,
  fontSize: 28,
  lineHeight: 1.14,
  letterSpacing: '-.014em',
} as const

/**
 * Header title: an `<h1>` by default; the pencil button swaps it for an
 * inline `<input>` (styled to match the heading exactly, see
 * `titleTypeStyle`) — Enter or blur commits the draft via `onRename`
 * (skipped if blank or unchanged), Escape discards the draft and reverts
 * without calling `onRename` at all.
 */
function NoteTitle({ meta, onRename }: NoteTitleProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  const committedRef = useRef(false)
  const editButtonRef = useRef<HTMLButtonElement>(null)

  if (!editing) {
    return (
      <>
        <h1 style={{ margin: 0, ...titleTypeStyle }}>{meta.title}</h1>
        <button
          ref={editButtonRef}
          title="Rename"
          aria-label="Rename"
          className="icon-btn"
          onClick={() => {
            setDraft(meta.title)
            committedRef.current = false
            setEditing(true)
          }}
          style={{
            width: 28,
            height: 28,
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--ink-faint)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
          </svg>
        </button>
      </>
    )
  }

  function restoreEditFocus() {
    requestAnimationFrame(() => editButtonRef.current?.focus())
  }

  function commit(restoreFocus = false) {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = draft.trim()
    setEditing(false)
    if (trimmed && trimmed !== meta.title) onRename(trimmed)
    if (restoreFocus) restoreEditFocus()
  }

  function cancel() {
    committedRef.current = true
    setEditing(false)
    restoreEditFocus()
  }

  return (
    <input
      autoFocus
      className="input-focus"
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
      style={{
        margin: 0,
        ...titleTypeStyle,
        color: 'var(--ink)',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--accent)',
        borderRadius: 0,
        padding: '0 0 2px',
        minWidth: 280,
        outline: 'none',
      }}
    />
  )
}

function DeleteNoteButton({ id, title, onDelete }: { id: string; title: string; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const confirmTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(confirmTimeout.current), [])

  return (
    <>
      <button
        title={confirming ? `Confirm delete “${title}”?` : `Delete “${title}”`}
        aria-label={confirming ? `Confirm delete note ${title}` : `Delete note ${title}`}
        className="icon-btn-danger"
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            confirmTimeout.current = setTimeout(() => setConfirming(false), DELETE_CONFIRM_TIMEOUT_MS)
            return
          }
          clearTimeout(confirmTimeout.current)
          setConfirming(false)
          onDelete(id)
        }}
        style={{
          width: 26,
          height: 26,
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          background: confirming ? 'var(--accent-tint)' : 'transparent',
          color: confirming ? 'var(--accent-text)' : 'var(--ink-faint)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18"></path>
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
        </svg>
      </button>
      <span role="status" className="visually-hidden">
        {confirming ? `Press again to confirm deletion of ${title}` : ''}
      </span>
    </>
  )
}

// AI-notes panel resize bounds. The floor keeps the ask input and action
// buttons usable; the ceiling keeps the transcript column from collapsing at
// the window's 1180px minimum width.
const AI_PANEL_MIN_WIDTH = 280
const AI_PANEL_MAX_WIDTH = 520
const AI_PANEL_DEFAULT_WIDTH = 316
const AI_PANEL_WIDTH_KEY = 'minute.aiPanelWidth'

function clampAiPanelWidth(width: number): number {
  return Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, width))
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
  noteTab,
  setNoteTab,
  sttStatus,
  sttStatusNoteId,
  summaryStatus,
  summaryError,
  llmInstalled,
  llmModelName,
  askHistory,
  askStatus,
  llmBusy,
  onRename,
  onDelete,
  onReveal,
  onCopyError,
  onToggleActionItem,
  onRegenerateSummary,
  onAsk,
  onGoSettings,
  onSetPinned,
  onAddMarker,
  onUpdateMarker,
  onDeleteMarker,
  onRenameSpeaker,
  onDismissSpeakerSuggestion,
  onMergeSpeakers,
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
}: NoteViewProps) {
  const overviewTabRef = useRef<HTMLButtonElement>(null)
  const transcriptTabRef = useRef<HTMLButtonElement>(null)
  const mdTabRef = useRef<HTMLButtonElement>(null)
  const speakerFilterRef = useRef<HTMLSelectElement>(null)
  const speakerRenameButtonRef = useRef<HTMLButtonElement>(null)
  const speakerMergeButtonRef = useRef<HTMLButtonElement>(null)
  const [speakerFilter, setSpeakerFilter] = useState('all')
  const [speakerEditing, setSpeakerEditing] = useState(false)
  const [speakerDraft, setSpeakerDraft] = useState('')
  const [speakerMergeOpen, setSpeakerMergeOpen] = useState(false)
  const [speakerMergeTarget, setSpeakerMergeTarget] = useState('')
  const [speakerMergePending, setSpeakerMergePending] = useState(false)
  const [speakerMergeUndo, setSpeakerMergeUndo] = useState<SpeakerMergeUndo | null>(null)
  const [speakerUndoPending, setSpeakerUndoPending] = useState(false)
  // "Detect speakers" re-run form: open/closed + its count draft ('auto' or
  // a stringified 2..8) — session-local UI state, same as the merge form's.
  const [speakerDetectOpen, setSpeakerDetectOpen] = useState(false)
  const [speakerDetectCount, setSpeakerDetectCount] = useState('auto')
  const [markerAddSeconds, setMarkerAddSeconds] = useState<number | null>(null)
  const [markerAddDraft, setMarkerAddDraft] = useState('')
  const [markerAddPending, setMarkerAddPending] = useState(false)
  const addMarkerButtonRef = useRef<HTMLButtonElement>(null)

  // AI-notes panel width, resizable via the separator between the leaf and
  // the panel. A plain UI preference, so it persists in localStorage rather
  // than settings.json — it doesn't need to survive the app-data folder or
  // sync anywhere.
  const [aiPanelWidth, setAiPanelWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(AI_PANEL_WIDTH_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampAiPanelWidth(stored) : AI_PANEL_DEFAULT_WIDTH
  })

  const applyAiPanelWidth = useCallback((width: number) => {
    const clamped = clampAiPanelWidth(width)
    setAiPanelWidth(clamped)
    window.localStorage.setItem(AI_PANEL_WIDTH_KEY, String(clamped))
  }, [])

  const handleAiPanelResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = aiPanelWidth
      const onMove = (ev: PointerEvent) => {
        // The panel sits to the separator's right, so dragging left widens it.
        setAiPanelWidth(clampAiPanelWidth(startWidth + (startX - ev.clientX)))
      }
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        applyAiPanelWidth(startWidth + (startX - ev.clientX))
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [aiPanelWidth, applyAiPanelWidth],
  )

  const handleAiPanelResizeKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        applyAiPanelWidth(aiPanelWidth + 16)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        applyAiPanelWidth(aiPanelWidth - 16)
      } else if (e.key === 'Home') {
        e.preventDefault()
        applyAiPanelWidth(AI_PANEL_DEFAULT_WIDTH)
      }
    },
    [aiPanelWidth, applyAiPanelWidth],
  )

  function focusSpeakerFilter() {
    requestAnimationFrame(() => speakerFilterRef.current?.focus())
  }

  function closeSpeakerRename() {
    setSpeakerEditing(false)
    setSpeakerDraft('')
    requestAnimationFrame(() => speakerRenameButtonRef.current?.focus())
  }

  function closeSpeakerMerge() {
    setSpeakerMergeOpen(false)
    setSpeakerMergeTarget('')
    requestAnimationFrame(() => speakerMergeButtonRef.current?.focus())
  }

  // `selectedMeta`/`selectedTranscript`/`selectedSummary`/`selectedMarkdown`
  // are useAppState's async `get_note` fetch for whichever note was
  // selected *when that fetch started* — only trust them once
  // `selectedMeta.id` actually matches the note being rendered right now,
  // so a still-in-flight fetch for a just-abandoned selection can never
  // flash a previous (or coming) note's data here. Computed ahead of the
  // `!meta` early return below (with hooks can't be conditional) even
  // though they're meaningless in that branch — `meta` may be `null` here.
  const transcriptReady = meta !== null && selectedMeta?.id === meta.id
  const segments = transcriptReady ? selectedTranscript : EMPTY_SEGMENTS
  const showTranscriptLoading = transcriptLoading && !transcriptReady
  const summary = transcriptReady ? selectedSummary : null
  const markdown = transcriptReady ? selectedMarkdown : ''
  const audioPath = transcriptReady ? selectedAudioPath : null
  const detailMeta = transcriptReady && selectedMeta ? selectedMeta : meta
  const noteId = meta?.id ?? null
  const markers = detailMeta?.markers ?? []
  const speakers = useMemo(() => Array.from(new Set(segments.map(segment => segment.speaker))), [segments])
  const filteredSegments = useMemo(
    () => speakerFilter === 'all' ? segments : segments.filter(segment => segment.speaker === speakerFilter),
    [segments, speakerFilter],
  )

  // Both re-derive their full input on every call (a segment-by-segment
  // adapter pass, a UTF-8 byte-length encode) — worth skipping once
  // `segments`/`markdown` themselves haven't changed, same rationale as the
  // rest of this sweep (see MarkdownCard/Sidebar/TitleBar).
  const displaySegments = useMemo(() => storedSegmentsToDisplay(filteredSegments), [filteredSegments])
  const markdownBytes = useMemo(() => new TextEncoder().encode(markdown).length, [markdown])

  // Owns the single `<audio>` element for whichever note is selected —
  // re-pointed at a fresh src (and reset to 0:00/paused) whenever
  // `audioPath` changes, torn down entirely when it's `null` (no audio.wav
  // on disk). Destructured (rather than kept as one `player` object) so the
  // `useCallback`/`useMemo` dependency arrays below can name exactly the
  // fields they use — see useAudioPlayer's docs for why
  // `play`/`pause`/`toggle`/`seek`/`skip`/`cycleRate` are permanently stable
  // identities, which is what keeps `handleSeekFromTranscript` below (and
  // therefore TranscriptList's `onSeek` prop) stable too.
  const { playing, currentTime, duration, rate, failed, play, toggle, seek, skip, cycleRate } = useAudioPlayer(audioPath)

  // Whether this note's audio can actually be seeked into right now — the
  // single source of truth fed to every seek/playback affordance below
  // (PlayerBar's controls, TranscriptList's timestamp buttons, and — via
  // AiNotesPanel — ask history's citation buttons): not just "does a path
  // exist" but "does a path exist AND did loading it not just fail". A note
  // whose audio.wav was swept (or deleted/raced out from under the app
  // after this path was fetched) must look and behave identically inert
  // either way, even though PlayerBar shows different copy for the two
  // causes (see its own docs).
  const seekable = audioPath !== null && !failed

  // The real audio element's duration once its metadata has loaded; before
  // that (or with no audio at all) falls back to the note's persisted
  // duration so the total time label doesn't flash "00:00" for the instant
  // between selecting a note and the browser reporting its real duration.
  const durationSec = duration > 0 ? duration : (meta?.durationSec ?? 0)

  // Which transcript segment (if any) playback is currently inside —
  // recomputed on every `currentTime` tick (~4Hz while playing) via a cheap
  // binary search, but handed to TranscriptList as a plain index rather than
  // raw `currentTime` so its memo only re-renders on the rarer "crossed into
  // a different segment" transition — see TranscriptList's own docs. Gated
  // on `playing` so a paused/at-rest position (e.g. sitting at 0:00 before
  // playback ever starts) never shows a stale/misleading highlight — only
  // actual playback does, per the design ("while playing").
  const activeIndex = useMemo(
    () => (playing ? findActiveSegmentIndex(filteredSegments, currentTime) : -1),
    [filteredSegments, currentTime, playing],
  )

  useEffect(() => {
    setSpeakerFilter('all')
    setSpeakerEditing(false)
    setSpeakerDraft('')
    setSpeakerMergeOpen(false)
    setSpeakerMergeTarget('')
    setSpeakerMergePending(false)
    setSpeakerMergeUndo(null)
    setSpeakerUndoPending(false)
    setMarkerAddSeconds(null)
    setMarkerAddDraft('')
    setMarkerAddPending(false)
  }, [noteId])

  const closeMarkerComposer = useCallback(() => {
    setMarkerAddSeconds(null)
    setMarkerAddDraft('')
    requestAnimationFrame(() => addMarkerButtonRef.current?.focus())
  }, [])

  const saveAddedMarker = useCallback(async () => {
    if (!meta || markerAddSeconds === null || markerAddPending) return
    const label = markerAddDraft.trim()
    if (!label) return
    setMarkerAddPending(true)
    try {
      await onAddMarker(meta.id, markerAddSeconds, label)
      closeMarkerComposer()
    } catch {
      // The shared error banner owns the failure message. Keep the captured
      // timestamp and draft intact so retrying never changes what was marked.
    } finally {
      setMarkerAddPending(false)
    }
  }, [closeMarkerComposer, markerAddDraft, markerAddPending, markerAddSeconds, meta, onAddMarker])

  // Transcript timestamp click → seek and start playback. `seek`/`play` are
  // themselves permanently stable, so this is too — required for
  // TranscriptList's memo to actually hold across NoteView's frequent
  // re-renders while audio plays.
  const handleSeekFromTranscript = useCallback(
    (seconds: number) => {
      seek(seconds)
      play()
    },
    [seek, play],
  )

  // ⌘K search palette "open this transcript hit" → seek and play, once this
  // note's own audio is actually loaded (see `pendingSeek`'s docs on
  // NoteViewProps for why it's gated on `transcriptReady` rather than firing
  // the instant `pendingSeek` arrives). Runs after `useAudioPlayer`'s own
  // effect above (React commits effects in declaration order), so by the
  // time this fires `audio.src` has already been re-pointed at the right
  // note — `seek` itself is safe to call even before `loadedmetadata`
  // (queued internally), so this doesn't need to wait for that too.
  useEffect(() => {
    if (!meta || !pendingSeek || pendingSeek.noteId !== meta.id || !transcriptReady) return
    seek(pendingSeek.seconds)
    play()
    onPendingSeekApplied()
  }, [meta, pendingSeek, transcriptReady, seek, play, onPendingSeekApplied])

  // Curried per-note closures handed down to the memoized MarkdownCard/
  // AiNotesPanel — `useCallback`'d (keyed on `meta`'s id, plus whichever
  // handler prop each one actually calls) so their identity only changes
  // when the note being viewed changes (or the underlying handler itself
  // does), not on every NoteView re-render. A plain arrow literal here would
  // be a fresh function every render and defeat those components' memo no
  // matter how stable `onReveal`/`onToggleActionItem`/etc. are upstream in
  // useAppState. Also computed ahead of the `!meta` early return below (same
  // reason as `displaySegments`/`markdownBytes` above) — meaningless but
  // harmless while `meta` is `null`.
  const handleReveal = useCallback(() => {
    if (noteId) onReveal(noteId)
  }, [noteId, onReveal])
  const handleToggleAction = useCallback(
    (index: number, done: boolean) => {
      if (noteId) onToggleActionItem(noteId, index, done)
    },
    [noteId, onToggleActionItem],
  )
  const handleRegenerate = useCallback(() => {
    if (noteId) onRegenerateSummary(noteId)
  }, [noteId, onRegenerateSummary])
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

  const handleOpenTranscript = useCallback(
    (seconds?: number) => {
      setNoteTab('transcript')
      if (seconds !== undefined) {
        seek(seconds)
        play()
      }
    },
    [play, seek, setNoteTab],
  )
  const handleFocusAsk = useCallback(() => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Ask about this meeting"]')?.focus()
    })
  }, [])

  if (!meta) {
    return <EmptyNotesArea onStartRecording={onStartRecording} />
  }

  const metaLine = noteMetaToListItem(meta, new Date()).meta
  const dateLabel = new Date(meta.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  // Stage 5 Task 5: surfaced subtly — one more clause on the existing meta
  // line, not a separate badge/pill — only when system audio was actually
  // part of this note's recording (`sources` defaults to `["mic"]` for
  // every note, including every one recorded before this field existed).
  const includedSystemAudio = meta.sources.includes('system')

  // Three-item roving-focus tablist: Left/Right moves selection and focus,
  // per the WAI-ARIA tabs pattern.
  function handleTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const tabs: NoteTab[] = ['overview', 'transcript', 'md']
    const current = tabs.indexOf(noteTab)
    const direction = e.key === 'ArrowRight' ? 1 : -1
    const next = tabs[(current + direction + tabs.length) % tabs.length]
    setNoteTab(next)
    ;(next === 'overview' ? overviewTabRef : next === 'transcript' ? transcriptTabRef : mdTabRef).current?.focus()
  }

  return (
    <main style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--panel)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        {/* Document head. Title, then a caption line, then the tab rule —
            stacked like a masthead rather than split into a left column and
            a right cluster of controls. The tabs sit *on* the rule that
            divides head from body, so one hairline does both jobs. */}
        <div style={{ padding: '24px 34px 0', flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <NoteTitle meta={meta} onRename={title => onRename(meta.id, title)} />
            <StatusPill meta={meta} sttStatus={sttStatus} sttStatusNoteId={sttStatusNoteId} summaryStatus={summaryStatus} />
            <button
              type="button"
              className="note-pin-toggle"
              data-active={meta.pinned ? 'true' : 'false'}
              aria-label={meta.pinned ? 'Unpin note' : 'Pin note'}
              title={meta.pinned ? 'Unpin note' : 'Pin note'}
              onClick={() => onSetPinned(meta.id, !(meta.pinned ?? false))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={meta.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m12 17-5 3 1.5-5.8L4 10.5l5.9-.4L12 4.5l2.1 5.6 5.9.4-4.5 3.7L17 20Z" />
              </svg>
            </button>
          </div>
          <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {metaLine} · {dateLabel} · stored locally{includedSystemAudio ? ' · mic + system audio' : ''}
          </div>
          <div className="note-tab-row" style={{ marginTop: 18 }}>
            <div role="tablist" aria-label="Note content" onKeyDown={handleTabKeyDown} className="tab-rule">
              <button
                ref={overviewTabRef}
                id="note-tab-overview"
                role="tab"
                aria-selected={noteTab === 'overview'}
                aria-controls="note-panel-overview"
                tabIndex={noteTab === 'overview' ? 0 : -1}
                onClick={() => setNoteTab('overview')}
                className="tab-item"
              >
                Overview
              </button>
              <button
                ref={transcriptTabRef}
                id="note-tab-transcript"
                role="tab"
                aria-selected={noteTab === 'transcript'}
                aria-controls="note-panel-transcript"
                tabIndex={noteTab === 'transcript' ? 0 : -1}
                onClick={() => setNoteTab('transcript')}
                className="tab-item"
              >
                Transcript
              </button>
              <button
                ref={mdTabRef}
                id="note-tab-md"
                role="tab"
                aria-selected={noteTab === 'md'}
                aria-controls="note-panel-md"
                tabIndex={noteTab === 'md' ? 0 : -1}
                onClick={() => setNoteTab('md')}
                className="tab-item"
              >
                Markdown
              </button>
            </div>
            <div className="note-tab-actions">
              <DeleteNoteButton id={meta.id} title={meta.title} onDelete={onDelete} />
            </div>
          </div>
        </div>
        {processingFailure?.stage === 'preparing' && (
          <div className="note-processing-recovery" role="status">
            <span>
              <strong>The recording is saved, but the library did not refresh.</strong>
              {processingFailure.message}
            </span>
            <button type="button" className="btn-outline" onClick={onRetryProcessing}>Retry refresh</button>
            <button type="button" className="btn-quiet" onClick={onDismissProcessing}>Dismiss</button>
          </div>
        )}
        {meta.captureWarning && (
          <div className="note-processing-recovery" role="status">
            <span>
              <strong>Part of this recording may be missing.</strong>
              {meta.captureWarning} Existing audio and transcript content were preserved.
            </span>
          </div>
        )}
        {noteTab === 'overview' && (
          <div id="note-panel-overview" role="tabpanel" aria-labelledby="note-tab-overview" className="note-overview-panel">
            <NoteOverview
              meta={detailMeta ?? meta}
              summary={summary}
              segments={segments}
              markers={markers}
              summaryStatus={summaryStatus}
              summaryError={summaryError}
              llmInstalled={llmInstalled}
              onGenerate={handleRegenerate}
              onToggleAction={handleToggleAction}
              onOpenTranscript={handleOpenTranscript}
              onFocusAsk={handleFocusAsk}
              onExport={handleReveal}
              onUpdateMarker={(index, label) => onUpdateMarker(meta.id, index, label)}
              onDeleteMarker={index => onDeleteMarker(meta.id, index)}
              onRestoreMarker={marker => onAddMarker(meta.id, marker.seconds, marker.label)}
              storage={selectedNoteStorage}
              onDeleteAudio={onDeleteAudio}
            />
          </div>
        )}
        {noteTab === 'transcript' && (
          <div id="note-panel-transcript" role="tabpanel" aria-labelledby="note-tab-transcript" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
            {showTranscriptLoading ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-muted)' }}>
                Loading transcript…
              </div>
            ) : (
              <>
                <div className="transcript-tools">
                  <span className="transcript-play-hint">Timestamps play audio · ↑↓ moves between turns</span>
                  <button
                    ref={addMarkerButtonRef}
                    type="button"
                    className="transcript-add-marker"
                    disabled={!seekable || markerAddSeconds !== null}
                    aria-label={
                      seekable
                        ? `Add marker at ${formatMmSs(currentTime)}`
                        : 'Add marker unavailable without audio'
                    }
                    title={seekable ? `Mark ${formatMmSs(currentTime)}` : 'Audio is unavailable'}
                    onClick={() => {
                      setMarkerAddSeconds(currentTime)
                      setMarkerAddDraft('')
                    }}
                  >
                    Add marker
                  </button>
                  <select
                    ref={speakerFilterRef}
                    aria-label="Filter transcript by speaker"
                    value={speakerFilter}
                    onChange={event => {
                      setSpeakerFilter(event.target.value)
                      setSpeakerEditing(false)
                      setSpeakerMergeOpen(false)
                      setSpeakerMergeTarget('')
                    }}
                  >
                    <option value="all">All speakers</option>
                    {speakers.map(speaker => <option key={speaker} value={speaker}>{speaker}</option>)}
                  </select>
                  {speakerFilter !== 'all' && !speakerEditing && (
                    <>
                      <button
                        ref={speakerRenameButtonRef}
                        type="button"
                        className="btn-quiet"
                        onClick={() => {
                          setSpeakerDraft(speakerFilter)
                          setSpeakerEditing(true)
                          setSpeakerMergeOpen(false)
                        }}
                      >
                        Rename speaker
                      </button>
                      {speakers.length > 1 && (
                        <button
                          ref={speakerMergeButtonRef}
                          type="button"
                          className="btn-quiet"
                          onClick={() => {
                            setSpeakerMergeTarget(speakers.find(speaker => speaker !== speakerFilter) ?? '')
                            setSpeakerMergeOpen(true)
                            setSpeakerEditing(false)
                          }}
                        >
                          Merge speaker
                        </button>
                      )}
                    </>
                  )}
                  {canDetectSpeakers && !speakerDetectOpen && (
                    <button
                      type="button"
                      className="btn-quiet"
                      disabled={diarStatus === 'running'}
                      onClick={() => {
                        setSpeakerDetectOpen(true)
                        setSpeakerEditing(false)
                        setSpeakerMergeOpen(false)
                      }}
                    >
                      {diarStatus === 'running' ? 'Detecting speakers…' : 'Detect speakers'}
                    </button>
                  )}
                  {speakerEditing && (
                    <form
                      className="speaker-rename"
                      onSubmit={event => {
                        event.preventDefault()
                        const next = speakerDraft.trim()
                        if (next && next !== speakerFilter) onRenameSpeaker(meta.id, speakerFilter, next)
                        setSpeakerFilter('all')
                        setSpeakerEditing(false)
                        focusSpeakerFilter()
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Speaker name"
                        value={speakerDraft}
                        onChange={event => setSpeakerDraft(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            closeSpeakerRename()
                          }
                        }}
                      />
                      <button type="submit" className="btn-outline">Save</button>
                      <button type="button" className="btn-quiet" onClick={closeSpeakerRename}>Cancel</button>
                    </form>
                  )}
                </div>
                {Object.keys(meta.speakerSuggestions ?? {}).length > 0 && (
                  <div className="speaker-suggestions" role="group" aria-label="Speaker name suggestions">
                    {Object.entries(meta.speakerSuggestions ?? {}).map(([label, suggestion]) => (
                      <span key={label} className="speaker-suggestion">
                        <span>
                          <strong>{label}</strong> sounds like <strong>{suggestion.name}</strong>
                        </span>
                        <button
                          type="button"
                          className="btn-outline"
                          aria-label={`Rename ${label} to ${suggestion.name}`}
                          onClick={() => onRenameSpeaker(meta.id, label, suggestion.name)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="btn-quiet"
                          aria-label={`Dismiss suggestion for ${label}`}
                          onClick={() => onDismissSpeakerSuggestion(meta.id, label)}
                        >
                          Dismiss
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {speakerMergeOpen && speakerFilter !== 'all' && (
                  <form
                    className="speaker-merge-form"
                    onKeyDown={event => {
                      if (event.key === 'Escape' && !speakerMergePending) {
                        event.preventDefault()
                        closeSpeakerMerge()
                      }
                    }}
                    onSubmit={event => {
                      event.preventDefault()
                      if (!speakerMergeTarget || speakerMergePending) return
                      const from = speakerFilter
                      const into = speakerMergeTarget
                      setSpeakerMergePending(true)
                      void onMergeSpeakers(meta.id, from, into)
                        .then(undo => {
                          setSpeakerMergeUndo(undo)
                          setSpeakerFilter('all')
                          setSpeakerMergeOpen(false)
                          setSpeakerMergeTarget('')
                          focusSpeakerFilter()
                        })
                        .catch(() => {
                          // The shared error banner owns the message. Keep
                          // both selected speakers intact for a retry.
                        })
                        .finally(() => setSpeakerMergePending(false))
                    }}
                  >
                    <span>
                      Merge <strong>{speakerFilter}</strong> into
                    </span>
                    <select
                      autoFocus
                      aria-label="Merge into speaker"
                      value={speakerMergeTarget}
                      disabled={speakerMergePending}
                      onChange={event => setSpeakerMergeTarget(event.target.value)}
                    >
                      {speakers
                        .filter(speaker => speaker !== speakerFilter)
                        .map(speaker => <option key={speaker} value={speaker}>{speaker}</option>)}
                    </select>
                    <button type="submit" disabled={!speakerMergeTarget || speakerMergePending}>
                      {speakerMergePending ? 'Merging…' : 'Merge'}
                    </button>
                    <button
                      type="button"
                      disabled={speakerMergePending}
                      onClick={closeSpeakerMerge}
                    >
                      Cancel
                    </button>
                  </form>
                )}
                {speakerDetectOpen && (
                  <form
                    className="speaker-merge-form"
                    onKeyDown={event => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setSpeakerDetectOpen(false)
                      }
                    }}
                    onSubmit={event => {
                      event.preventDefault()
                      const count = speakerDetectCount === 'auto' ? null : Number(speakerDetectCount)
                      onDetectSpeakers(meta.id, count)
                      setSpeakerDetectOpen(false)
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
                    <button type="submit">Detect</button>
                    <button type="button" onClick={() => setSpeakerDetectOpen(false)}>Cancel</button>
                  </form>
                )}
                {diarStatus === 'error' && diarError && (
                  <div className="speaker-merge-notice" role="status">
                    <span>Speaker detection failed: {diarError}</span>
                  </div>
                )}
                {speakerMergeUndo && (
                  <div className="speaker-merge-notice">
                    <span role="status">
                      <strong>{speakerMergeUndo.from}</strong> merged into <strong>{speakerMergeUndo.into}</strong>.
                    </span>
                    <button
                      type="button"
                      disabled={speakerUndoPending}
                      onClick={() => {
                        setSpeakerUndoPending(true)
                        void onUndoSpeakerMerge(meta.id, speakerMergeUndo)
                          .then(() => {
                            setSpeakerMergeUndo(null)
                            focusSpeakerFilter()
                          })
                          .catch(() => {
                            // Retain the undo affordance when persistence
                            // fails so the user can retry.
                          })
                          .finally(() => setSpeakerUndoPending(false))
                      }}
                    >
                      {speakerUndoPending ? 'Undoing…' : 'Undo'}
                    </button>
                  </div>
                )}
                {markerAddSeconds !== null && (
                  <form
                    className="transcript-marker-add"
                    onSubmit={event => {
                      event.preventDefault()
                      void saveAddedMarker()
                    }}
                  >
                    <span className="transcript-marker-add-time">{formatMmSs(markerAddSeconds)}</span>
                    <input
                      autoFocus
                      aria-label={`New marker label at ${formatMmSs(markerAddSeconds)}`}
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
                    <button type="submit" disabled={!markerAddDraft.trim() || markerAddPending}>
                      {markerAddPending ? 'Saving…' : 'Save marker'}
                    </button>
                    <button type="button" disabled={markerAddPending} onClick={closeMarkerComposer}>
                      Cancel
                    </button>
                  </form>
                )}
                {markers.length > 0 && (
                  <div className="transcript-markers" aria-label="Recording markers">
                    {markers.map((marker, index) => (
                      <button key={`${marker.seconds}-${index}`} type="button" onClick={() => handleSeekFromTranscript(marker.seconds)}>
                        <span>{formatMmSs(marker.seconds)}</span>
                        {marker.label}
                      </button>
                    ))}
                  </div>
                )}
                {filteredSegments.length === 0 ? (
                  <div className="transcript-empty-filter">
                    No transcript turns match this speaker.
                    <button type="button" className="empty-action" onClick={() => setSpeakerFilter('all')}>Show all speakers</button>
                  </div>
                ) : (
                  <TranscriptList
                    noteId={meta.id}
                    segments={displaySegments}
                    activeIndex={activeIndex}
                    onSeek={handleSeekFromTranscript}
                    seekable={seekable}
                  />
                )}
              </>
            )}
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
          </div>
        )}
        {noteTab === 'md' && (
          <div id="note-panel-md" role="tabpanel" aria-labelledby="note-tab-md" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
            <MarkdownCard
              filename={`${slugify(meta.title)}.md`}
              subtitle={`${formatBytes(markdownBytes)} · saved locally`}
              markdown={markdown}
              onReveal={handleReveal}
              onCopyError={onCopyError}
            />
          </div>
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI notes panel"
        aria-valuemin={AI_PANEL_MIN_WIDTH}
        aria-valuemax={AI_PANEL_MAX_WIDTH}
        aria-valuenow={aiPanelWidth}
        tabIndex={0}
        className="panel-resizer"
        onPointerDown={handleAiPanelResizeStart}
        onKeyDown={handleAiPanelResizeKeyDown}
        onDoubleClick={() => applyAiPanelWidth(AI_PANEL_DEFAULT_WIDTH)}
      />
      <AiNotesPanel
        width={aiPanelWidth}
        summary={summary}
        status={summaryStatus}
        error={summaryError}
        modelName={llmModelName}
        llmInstalled={llmInstalled}
        askHistory={askHistory}
        askStatus={askStatus}
        llmBusy={llmBusy}
        seekable={seekable}
        onAsk={handleAsk}
        // Citation click → seek target — the exact same seek-then-play
        // callback TranscriptList's own `onSeek` uses (see
        // `handleSeekFromTranscript` above), reused rather than a second
        // `useAudioPlayer`-backed closure: both are "jump playback to this
        // timestamp and start playing" for the note currently on screen.
        onSeekCitation={handleSeekFromTranscript}
        onToggleAction={handleToggleAction}
        onRegenerate={handleRegenerate}
        onCopy={handleCopy}
        // Export .md reveals via the shared reveal command (audio.wav if
        // present, else the note directory containing note.md) rather than
        // a dedicated "reveal note.md specifically" command — a deliberate
        // simplification, not an oversight (see Stage 3 Task 5's plan doc).
        // Same closure as MarkdownCard's `onReveal` above (both just reveal
        // this note) — reused rather than a second `useCallback` so they
        // share one stable identity instead of two.
        onExport={handleReveal}
        onGoSettings={onGoSettings}
        overviewMode={noteTab === 'overview'}
      />
    </main>
  )
}
