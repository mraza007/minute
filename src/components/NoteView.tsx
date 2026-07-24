import { useEffect, useRef, useState } from 'react'
import type { NoteMeta, StoredSegment, SummaryDoc } from '../ipc/types'
import type { NoteTab, SttStatus } from '../types'
import { formatBytes, noteMetaToListItem, storedSegmentsToDisplay } from '../state/adapters'
import type { SummaryStatus } from '../state/useAppState'
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
  transcriptLoading: boolean
  noteTab: NoteTab
  setNoteTab: (tab: NoteTab) => void
  sttStatus: SttStatus
  sttStatusNoteId: string | null
  /** This note's summarization lifecycle, from `summaryStatus[meta.id]` — `'idle'` if no `summary-status` event has been seen for it this session. */
  summaryStatus: SummaryStatus
  summaryError?: string
  llmInstalled: boolean
  llmModelName: string
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onReveal: (id: string) => void
  onCopyError: (err: unknown) => void
  onToggleActionItem: (id: string, index: number, done: boolean) => void
  onRegenerateSummary: (id: string) => void
  onGoSettings: () => void
}

const DELETE_CONFIRM_TIMEOUT_MS = 4000

function EmptyNotesArea() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f7f6f4' }}>
      <div style={{ textAlign: 'center', maxWidth: 340 }}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>No notes yet</div>
        <div style={{ marginTop: 6, fontSize: 13, color: '#8d867f', lineHeight: 1.6 }}>
          Hit "New recording" in the title bar to capture your first meeting — transcription happens entirely on this
          Mac.
        </div>
      </div>
    </div>
  )
}

const pillBaseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 700,
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

  if (finalizing) {
    return (
      <span style={{ ...pillBaseStyle, background: '#ffe6e1', border: '1px solid rgba(224,68,48,.3)', color: '#b3200c' }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid rgba(224,68,48,.25)',
            borderTopColor: '#e04430',
            animation: 'spin .8s linear infinite',
            flex: 'none',
          }}
        />
        Finalizing transcript…
      </span>
    )
  }

  if (summaryStatus === 'running') {
    return (
      <span style={{ ...pillBaseStyle, background: '#ffe6e1', border: '1px solid rgba(224,68,48,.3)', color: '#b3200c' }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid rgba(224,68,48,.25)',
            borderTopColor: '#e04430',
            animation: 'spin .8s linear infinite',
            flex: 'none',
          }}
        />
        Summarizing…
      </span>
    )
  }

  if (meta.status === 'ready') {
    return (
      <span style={{ ...pillBaseStyle, background: 'rgba(40,167,69,.1)', border: '1px solid rgba(40,167,69,.25)', color: '#1e7c34' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#28a745' }} />
        Ready
      </span>
    )
  }

  if (meta.status === 'transcribed') {
    return (
      <span style={{ ...pillBaseStyle, background: 'rgba(40,167,69,.1)', border: '1px solid rgba(40,167,69,.25)', color: '#1e7c34' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#28a745' }} />
        Transcribed
      </span>
    )
  }

  return null
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

/**
 * Header title: an `<h1>` by default; the pencil button swaps it for an
 * inline `<input>` (styled to match the heading's 21px/700 weight) —
 * Enter or blur commits the draft via `onRename` (skipped if blank or
 * unchanged), Escape discards the draft and reverts without calling
 * `onRename` at all.
 */
function NoteTitle({ meta, onRename }: NoteTitleProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.title)
  const committedRef = useRef(false)

  if (!editing) {
    return (
      <>
        <h1 style={{ margin: 0, fontWeight: 700, fontSize: 21, letterSpacing: '-.02em' }}>{meta.title}</h1>
        <button
          title="Rename"
          className="icon-btn"
          onClick={() => {
            setDraft(meta.title)
            committedRef.current = false
            setEditing(true)
          }}
          style={{
            width: 32,
            height: 32,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: '#6d675f',
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

  function commit() {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = draft.trim()
    setEditing(false)
    if (trimmed && trimmed !== meta.title) onRename(trimmed)
  }

  function cancel() {
    committedRef.current = true
    setEditing(false)
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
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
      style={{
        margin: 0,
        fontWeight: 700,
        fontSize: 21,
        letterSpacing: '-.02em',
        fontFamily: 'inherit',
        border: '1px solid rgba(0,0,0,.15)',
        borderRadius: 6,
        padding: '1px 6px',
        minWidth: 240,
      }}
    />
  )
}

function DeleteNoteButton({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const confirmTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(confirmTimeout.current), [])

  return (
    <button
      title={confirming ? 'Confirm delete?' : 'Delete'}
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
        width: 32,
        height: 32,
        border: 'none',
        borderRadius: 8,
        background: confirming ? 'rgba(224,68,48,.12)' : 'transparent',
        color: confirming ? '#b3200c' : '#6d675f',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
      </svg>
    </button>
  )
}

export function NoteView({
  meta,
  selectedMeta,
  selectedTranscript,
  selectedSummary,
  selectedMarkdown,
  transcriptLoading,
  noteTab,
  setNoteTab,
  sttStatus,
  sttStatusNoteId,
  summaryStatus,
  summaryError,
  llmInstalled,
  llmModelName,
  onRename,
  onDelete,
  onReveal,
  onCopyError,
  onToggleActionItem,
  onRegenerateSummary,
  onGoSettings,
}: NoteViewProps) {
  if (!meta) {
    return <EmptyNotesArea />
  }

  const metaLine = noteMetaToListItem(meta, new Date()).meta
  const dateLabel = new Date(meta.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  // `selectedMeta`/`selectedTranscript`/`selectedSummary`/`selectedMarkdown`
  // are useAppState's async `get_note` fetch for whichever note was
  // selected *when that fetch started* — only trust them once
  // `selectedMeta.id` actually matches the note being rendered right now,
  // so a still-in-flight fetch for a just-abandoned selection can never
  // flash a previous (or coming) note's data here.
  const transcriptReady = selectedMeta?.id === meta.id
  const segments = transcriptReady ? selectedTranscript : []
  const displaySegments = storedSegmentsToDisplay(segments)
  const showTranscriptLoading = transcriptLoading && !transcriptReady
  const summary = transcriptReady ? selectedSummary : null
  const markdown = transcriptReady ? selectedMarkdown : ''
  const markdownBytes = new TextEncoder().encode(markdown).length

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, background: '#f7f6f4' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            padding: '22px 32px 16px',
            borderBottom: '1px solid rgba(0,0,0,.07)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <NoteTitle meta={meta} onRename={title => onRename(meta.id, title)} />
              <StatusPill meta={meta} sttStatus={sttStatus} sttStatusNoteId={sttStatusNoteId} summaryStatus={summaryStatus} />
            </div>
            <div style={{ marginTop: 4, fontSize: 12.5, color: '#8d867f' }}>
              {metaLine} · {dateLabel} · stored locally
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
            <div role="tablist" aria-label="Note content" style={{ display: 'flex', background: '#eceae7', borderRadius: 9, padding: 3 }}>
              <button
                role="tab"
                aria-selected={noteTab === 'transcript'}
                onClick={() => setNoteTab('transcript')}
                className={noteTab === 'transcript' ? undefined : 'seg-off'}
                style={{
                  padding: '5px 14px',
                  border: 'none',
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: noteTab === 'transcript' ? '#fff' : 'transparent',
                  color: noteTab === 'transcript' ? '#1c1a18' : '#6d675f',
                  boxShadow: noteTab === 'transcript' ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
                }}
              >
                Transcript
              </button>
              <button
                role="tab"
                aria-selected={noteTab === 'md'}
                onClick={() => setNoteTab('md')}
                className={noteTab === 'md' ? undefined : 'seg-off'}
                style={{
                  padding: '5px 14px',
                  border: 'none',
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: noteTab === 'md' ? '#fff' : 'transparent',
                  color: noteTab === 'md' ? '#1c1a18' : '#6d675f',
                  boxShadow: noteTab === 'md' ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
                }}
              >
                Markdown
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
              <DeleteNoteButton id={meta.id} onDelete={onDelete} />
            </div>
          </div>
        </div>
        {noteTab === 'transcript' && (
          <>
            {showTranscriptLoading ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#8d867f' }}>
                Loading transcript…
              </div>
            ) : (
              <TranscriptList segments={displaySegments} />
            )}
            <PlayerBar durationSec={meta.durationSec} />
          </>
        )}
        {noteTab === 'md' && (
          <MarkdownCard
            filename={`${slugify(meta.title)}.md`}
            subtitle={`${formatBytes(markdownBytes)} · saved locally`}
            markdown={markdown}
            onReveal={() => onReveal(meta.id)}
            onCopyError={onCopyError}
          />
        )}
      </div>
      <AiNotesPanel
        summary={summary}
        status={summaryStatus}
        error={summaryError}
        modelName={llmModelName}
        llmInstalled={llmInstalled}
        onToggleAction={(index, done) => onToggleActionItem(meta.id, index, done)}
        onRegenerate={() => onRegenerateSummary(meta.id)}
        onCopy={() => {
          if (!navigator.clipboard) {
            onCopyError(new Error('Clipboard unavailable'))
            return
          }
          navigator.clipboard.writeText(markdown).catch(err => onCopyError(err))
        }}
        onExport={() => onReveal(meta.id)}
        onGoSettings={onGoSettings}
      />
    </div>
  )
}
