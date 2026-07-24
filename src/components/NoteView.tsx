import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { NoteMeta, StoredSegment, SummaryDoc } from '../ipc/types'
import type { NoteTab, SttStatus } from '../types'
import { findActiveSegmentIndex, formatBytes, noteMetaToListItem, storedSegmentsToDisplay } from '../state/adapters'
import { useAudioPlayer } from '../state/useAudioPlayer'
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
  /** This note's `audio.wav` path from `get_note`, or `null` if it doesn't exist on disk — same staleness contract as `selectedTranscript`/`selectedSummary`/`selectedMarkdown` (only trusted once `selectedMeta.id` matches `meta.id`). Feeds `useAudioPlayer`; `null` renders PlayerBar's disabled "Audio removed" state. */
  selectedAudioPath: string | null
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

// A single stable reference for the "not ready yet" case — a fresh `[]`
// literal on every render would defeat `displaySegments`'s useMemo below
// (and its own exhaustive-deps lint) despite being value-equal every time.
const EMPTY_SEGMENTS: StoredSegment[] = []

function EmptyNotesArea() {
  return (
    <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-soft)' }}>
      <div style={{ textAlign: 'center', maxWidth: 340 }}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>No notes yet</div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
          Hit "New recording" in the title bar to capture your first meeting — transcription happens entirely on this
          Mac.
        </div>
      </div>
    </main>
  )
}

const pillBaseStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 12,
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

  if (finalizing) {
    content = (
      <span style={{ ...pillBaseStyle, background: 'var(--accent-tint)', border: '1px solid rgba(224,68,48,.3)', color: 'var(--accent-text)' }}>
        <span
          className="spin"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid rgba(224,68,48,.25)',
            borderTopColor: 'var(--accent)',
            animation: 'spin .8s linear infinite',
            flex: 'none',
          }}
        />
        Finalizing transcript…
      </span>
    )
  } else if (summaryStatus === 'running') {
    content = (
      <span style={{ ...pillBaseStyle, background: 'var(--accent-tint)', border: '1px solid rgba(224,68,48,.3)', color: 'var(--accent-text)' }}>
        <span
          className="spin"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid rgba(224,68,48,.25)',
            borderTopColor: 'var(--accent)',
            animation: 'spin .8s linear infinite',
            flex: 'none',
          }}
        />
        Summarizing…
      </span>
    )
  } else if (meta.status === 'ready') {
    content = (
      <span style={{ ...pillBaseStyle, background: 'var(--ok-tint)', border: '1px solid var(--ok-text)', color: 'var(--ok-text)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok-text)' }} />
        Ready
      </span>
    )
  } else if (meta.status === 'transcribed') {
    content = (
      <span style={{ ...pillBaseStyle, background: 'var(--ok-tint)', border: '1px solid var(--ok-text)', color: 'var(--ok-text)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok-text)' }} />
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
          aria-label="Rename"
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
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            color: 'var(--ink-muted)',
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
    <>
      <button
        title={confirming ? 'Confirm delete?' : 'Delete'}
        aria-label={confirming ? 'Confirm delete?' : 'Delete'}
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
          borderRadius: 'var(--radius-sm)',
          background: confirming ? 'rgba(224,68,48,.12)' : 'transparent',
          color: confirming ? 'var(--accent-text)' : 'var(--ink-muted)',
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
      <span role="status" className="visually-hidden">
        {confirming ? 'Press again to confirm deletion' : ''}
      </span>
    </>
  )
}

export function NoteView({
  meta,
  selectedMeta,
  selectedTranscript,
  selectedSummary,
  selectedMarkdown,
  selectedAudioPath,
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
  onRename,
  onDelete,
  onReveal,
  onCopyError,
  onToggleActionItem,
  onRegenerateSummary,
  onGoSettings,
}: NoteViewProps) {
  const transcriptTabRef = useRef<HTMLButtonElement>(null)
  const mdTabRef = useRef<HTMLButtonElement>(null)

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

  // Both re-derive their full input on every call (a segment-by-segment
  // adapter pass, a UTF-8 byte-length encode) — worth skipping once
  // `segments`/`markdown` themselves haven't changed, same rationale as the
  // rest of this sweep (see MarkdownCard/Sidebar/TitleBar).
  const displaySegments = useMemo(() => storedSegmentsToDisplay(segments), [segments])
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
  const { playing, currentTime, duration, rate, play, toggle, seek, skip, cycleRate } = useAudioPlayer(audioPath)

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
    () => (playing ? findActiveSegmentIndex(segments, currentTime) : -1),
    [segments, currentTime, playing],
  )

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
  const noteId = meta?.id ?? null
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
  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) {
      onCopyError(new Error('Clipboard unavailable'))
      return
    }
    navigator.clipboard.writeText(markdown).catch(err => onCopyError(err))
  }, [markdown, onCopyError])

  if (!meta) {
    return <EmptyNotesArea />
  }

  const metaLine = noteMetaToListItem(meta, new Date()).meta
  const dateLabel = new Date(meta.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  // Two-item roving-focus tablist: Left/Right just toggles between the only
  // two tabs (Transcript/Markdown) — moves selection *and* focus, per the
  // WAI-ARIA tabs pattern.
  function handleTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next: NoteTab = noteTab === 'transcript' ? 'md' : 'transcript'
    setNoteTab(next)
    ;(next === 'transcript' ? transcriptTabRef : mdTabRef).current?.focus()
  }

  return (
    <main style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--surface-soft)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            padding: '22px 32px 16px',
            borderBottom: '1px solid var(--border-soft)',
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
            <div style={{ marginTop: 4, fontSize: 13, color: 'var(--ink-muted)' }}>
              {metaLine} · {dateLabel} · stored locally
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
            <div role="tablist" aria-label="Note content" onKeyDown={handleTabKeyDown} style={{ display: 'flex', background: 'var(--panel-warm)', borderRadius: 9, padding: 3 }}>
              <button
                ref={transcriptTabRef}
                id="note-tab-transcript"
                role="tab"
                aria-selected={noteTab === 'transcript'}
                aria-controls="note-panel-transcript"
                tabIndex={noteTab === 'transcript' ? 0 : -1}
                onClick={() => setNoteTab('transcript')}
                className={noteTab === 'transcript' ? undefined : 'seg-off'}
                style={{
                  padding: '5px 14px',
                  border: 'none',
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: noteTab === 'transcript' ? 'var(--card)' : 'transparent',
                  color: noteTab === 'transcript' ? 'var(--ink)' : 'var(--ink-muted)',
                  boxShadow: noteTab === 'transcript' ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
                }}
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
                className={noteTab === 'md' ? undefined : 'seg-off'}
                style={{
                  padding: '5px 14px',
                  border: 'none',
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: noteTab === 'md' ? 'var(--card)' : 'transparent',
                  color: noteTab === 'md' ? 'var(--ink)' : 'var(--ink-muted)',
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
          <div id="note-panel-transcript" role="tabpanel" aria-labelledby="note-tab-transcript" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
            {showTranscriptLoading ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--ink-muted)' }}>
                Loading transcript…
              </div>
            ) : (
              <TranscriptList
                segments={displaySegments}
                activeIndex={activeIndex}
                onSeek={handleSeekFromTranscript}
                seekable={audioPath !== null}
              />
            )}
            <PlayerBar
              audioPath={audioPath}
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
      <AiNotesPanel
        summary={summary}
        status={summaryStatus}
        error={summaryError}
        modelName={llmModelName}
        llmInstalled={llmInstalled}
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
      />
    </main>
  )
}
