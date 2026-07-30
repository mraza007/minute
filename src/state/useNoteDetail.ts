import { useCallback, useEffect, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onAskAnswer, onAskStatus, onDiarStatus, onSummaryStatus } from '../ipc/events'
import type { NoteMeta, NoteWithTranscript, StoredSegment, SummaryDoc } from '../ipc/types'
import { useTauriEvent } from './useTauriEvent'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Per-note summarization lifecycle as tracked in `summaryStatus`/
 * `summaryError` below — mirrors the wire event's `state` field
 * (`SummaryStatusEvent['state']`) exactly, including `'done'`, since that's
 * a real, meaningful transition worth remembering per note (e.g. so a
 * background summarization for a non-selected note is still known to have
 * finished if the user switches to it later).
 */
export type SummaryEventState = 'running' | 'done' | 'error'

/**
 * The AI notes panel's (and NoteView's status pill's) simplified view of a
 * note's summarization state — `'idle'` covers both "no `summary-status`
 * event seen this session" and "the last one was `'done'`", since `'done'`
 * itself carries no special UI once it's landed (the panel just renders the
 * real summary/decisions/action items normally at that point). `App.tsx`
 * collapses `summaryStatus[id]` (a `SummaryEventState | undefined`) down to
 * this before handing it to `NoteView`/`AiNotesPanel`.
 */
export type SummaryStatus = 'idle' | 'running' | 'error'

/**
 * Ask-your-notes' collapsed per-note status — same `'idle'`-covers-"never
 * asked"-and-"last one finished" shape as `SummaryStatus`. Unlike summary
 * status this is derived here (not by the caller — see `askStatus` below)
 * since there's no separate App.tsx-level consumer that needs the raw
 * `'running' | 'done' | 'error'` wire state for a note other than the
 * selected one.
 */
export type AskStatus = 'idle' | 'running' | 'error'

/**
 * One entered/answered (or failed) question in a note's ask-your-notes
 * session history — session-only, never persisted (mirrors the backend's
 * `ask-answer` event, which is never written to disk either; see
 * `llm::AskAnswerPayload`'s docs). Exactly one of `answer`/`error` is set: a
 * successful ask carries `answer` (with inline `[mm:ss]` citations,
 * rendered by `AiNotesPanel`'s `splitAnswerCitations`), a failed one carries
 * `error` (and a retry affordance that just re-asks `question`).
 *
 * `id` is a monotonically increasing counter this hook assigns at
 * insertion (see `nextAskEntryId`) — a stable React list key `AiNotesPanel`
 * uses instead of the entry's array index: history is newest-first, so
 * every existing entry's *index* shifts by one on every prepend, which
 * would make an index-keyed list re-key (and, worse, potentially
 * misattribute in-flight state to) every existing row each time a new
 * question lands. `id` never shifts.
 */
export interface AskHistoryEntry {
  id: number
  question: string
  answer?: string
  error?: string
}

/**
 * How many notes' `get_note` responses (transcript + summary + markdown)
 * `transcriptCache` keeps resident at once — carried debt flagged in the
 * Stage 3 plan. A plain re-insert-on-access `Map` (insertion order doubles
 * as recency order) with oldest-evict-on-overflow: `cacheGet` moves a hit to
 * the end, `cacheSet` does the same and then drops the first (oldest) entry
 * once the map exceeds this cap. Cheap and good enough at note-library
 * scale — no need for a dedicated LRU data structure.
 */
const TRANSCRIPT_CACHE_CAP = 20

/** How many ask-your-notes history entries `askHistoryMap` keeps per note (newest first, oldest dropped once this cap is exceeded) — a session-only chat log, not something worth unbounded growth over a long-running session. */
const ASK_HISTORY_CAP = 20

/**
 * The selected note's transcript/summary/markdown/audio-path loading (with
 * an LRU cache), its summarization lifecycle, and its ask-your-notes
 * session state — extracted from `useAppState` (Stage 4 Task 5's carried
 * debt: that hook had grown past 900 lines) as an internal composition seam
 * exactly like `useModelManager`. `useAppState` calls this once and spreads
 * its return value straight into its own return object, so this extraction
 * is invisible to every consumer of `useAppState`'s public shape — see that
 * hook for the seam.
 *
 * `selectedNoteId`/`reportError`/`refreshNotes` are threaded in rather than
 * this hook reaching into a shared context: `selectedNoteId` is derived
 * from `notes`/`sel`, which stay owned by `useAppState` (note *selection*
 * is a library-wide concern, not a note-detail one); `reportError` is
 * `useAppState`'s single `lastError` banner; `refreshNotes` is what a
 * summarization landing (`'done'`) needs to call so the sidebar/header
 * status pill picks up the note's fresh `transcribed -> ready` status —
 * again a library-list concern this hook doesn't own.
 */
export function useNoteDetail(params: {
  selectedNoteId: string | null
  reportError: (err: unknown) => void
  refreshNotes: () => void
}) {
  const { selectedNoteId, reportError, refreshNotes } = params

  // --- transcript/summary/markdown/audio loading, LRU-cached -------------
  //
  // `selectedMeta`/`selectedTranscript`/`selectedSummary`/`selectedMarkdown`
  // back NoteView's Transcript/Markdown tabs and the AI notes panel once a
  // note is actually selected — fetched via `get_note` (the notes list
  // itself only carries `NoteMeta`, no segments/summary/markdown). Cached
  // per id in `transcriptCache` (LRU-capped — see `cacheGet`/`cacheSet`) so
  // re-selecting an already-viewed note is instant and doesn't re-hit the
  // backend; `invalidateNoteCache` (called by `useAppState`'s
  // `renameNote`/`deleteNote`/`stopRec`) and the `summary-status` 'done'
  // handler below invalidate a note's cache entry since its on-disk content
  // just changed out from under whatever's cached.
  const [selectedTranscript, setSelectedTranscript] = useState<StoredSegment[]>([])
  const [selectedMeta, setSelectedMeta] = useState<NoteMeta | null>(null)
  const [selectedSummary, setSelectedSummary] = useState<SummaryDoc | null>(null)
  const [selectedMarkdown, setSelectedMarkdown] = useState('')
  const [selectedAudioPath, setSelectedAudioPath] = useState<string | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const transcriptCache = useRef(new Map<string, NoteWithTranscript>())
  // Bumped on every `loadNoteTranscript` call and captured per in-flight
  // request — guards against an out-of-order resolution (e.g. quickly
  // selecting note A then B) clobbering newer state with a stale response.
  const transcriptRequestId = useRef(0)

  /**
   * Reads a cache entry, marking it most-recently-used (moves it to the end
   * of the map) — see `TRANSCRIPT_CACHE_CAP`'s docs. `undefined` on a miss,
   * same as `Map.get`. `useCallback` with no deps — only touches the
   * `transcriptCache` ref (stable by construction) and the module-level
   * `TRANSCRIPT_CACHE_CAP` constant, so it has a permanently stable identity
   * — required for `loadNoteTranscript`/`toggleActionItem` below to have
   * stable identities of their own in turn.
   */
  const cacheGet = useCallback((id: string): NoteWithTranscript | undefined => {
    const entry = transcriptCache.current.get(id)
    if (entry) {
      transcriptCache.current.delete(id)
      transcriptCache.current.set(id, entry)
    }
    return entry
  }, [])

  /** Writes a cache entry as most-recently-used, evicting the single oldest entry if this pushes the map over `TRANSCRIPT_CACHE_CAP`. Same stable-identity rationale as `cacheGet`. */
  const cacheSet = useCallback((id: string, data: NoteWithTranscript) => {
    transcriptCache.current.delete(id)
    transcriptCache.current.set(id, data)
    if (transcriptCache.current.size > TRANSCRIPT_CACHE_CAP) {
      const oldestId = transcriptCache.current.keys().next().value
      if (oldestId !== undefined) transcriptCache.current.delete(oldestId)
    }
  }, [])

  /**
   * Drops `id`'s cache entry without touching anything else — the seam
   * `useAppState`'s `renameNote`/`deleteNote`/`stopRec` use to invalidate a
   * note whose on-disk content just changed out from under whatever's
   * cached (a rename, a delete, a freshly finalized recording). `useCallback`
   * with no deps — permanently stable, same rationale as `cacheGet`/`cacheSet`.
   */
  const invalidateNoteCache = useCallback((id: string) => {
    transcriptCache.current.delete(id)
  }, [])

  /**
   * `useCallback` (deps: `cacheGet`, `cacheSet`, `reportError` — all three
   * permanently stable) so this itself has a stable identity: `renameNote`/
   * `toggleActionItem`/the `summary-status` 'done' handler below all call
   * it.
   */
  const loadNoteTranscript = useCallback(
    (id: string, opts: { force?: boolean } = {}) => {
      if (!opts.force) {
        const cached = cacheGet(id)
        if (cached) {
          setSelectedMeta(cached.meta)
          setSelectedTranscript(cached.transcript.segments)
          setSelectedSummary(cached.summary)
          setSelectedMarkdown(cached.markdown)
          setSelectedAudioPath(cached.audioPath)
          setTranscriptLoading(false)
          return
        }
      }
      const requestId = ++transcriptRequestId.current
      setTranscriptLoading(true)
      ipc
        .getNote(id)
        .then(data => {
          cacheSet(id, data)
          if (transcriptRequestId.current !== requestId) return
          setSelectedMeta(data.meta)
          setSelectedTranscript(data.transcript.segments)
          setSelectedSummary(data.summary)
          setSelectedMarkdown(data.markdown)
          setSelectedAudioPath(data.audioPath)
        })
        .catch(err => {
          if (transcriptRequestId.current !== requestId) return
          reportError(err)
        })
        .finally(() => {
          if (transcriptRequestId.current === requestId) setTranscriptLoading(false)
        })
    },
    [cacheGet, cacheSet, reportError],
  )

  useEffect(() => {
    if (!selectedNoteId) {
      setSelectedMeta(null)
      setSelectedTranscript([])
      setSelectedSummary(null)
      setSelectedMarkdown('')
      setSelectedAudioPath(null)
      return
    }
    loadNoteTranscript(selectedNoteId)
  }, [selectedNoteId, loadNoteTranscript])

  // --- summarization lifecycle ---------------------------------------------
  //
  // Per-note summarization status/error, driven entirely by `summary-status`
  // events (registered unconditionally, same as the recording listeners in
  // `useAppState` — an auto-triggered summarization must not be missed just
  // because NoteView isn't mounted to see it land). Keyed by note id rather
  // than tracking only "the selected note" so a background summarization
  // (e.g. for a note the user has since navigated away from) still updates
  // correctly once its note is reselected. `summaryError` only ever holds
  // entries for notes currently in `'error'` state — cleared once a later
  // `running`/`done` event supersedes it.
  const [summaryStatus, setSummaryStatus] = useState<Record<string, SummaryEventState>>({})
  const [summaryError, setSummaryError] = useState<Record<string, string>>({})

  useTauriEvent(
    onSummaryStatus,
    payload => {
      setSummaryStatus(prev => ({ ...prev, [payload.noteId]: payload.state }))

      if (payload.state === 'error') {
        setSummaryError(prev => ({ ...prev, [payload.noteId]: payload.error ?? 'Summarization failed' }))
        return
      }
      // 'running' or 'done' supersedes any previous error for this note.
      setSummaryError(prev => {
        if (!(payload.noteId in prev)) return prev
        const next = { ...prev }
        delete next[payload.noteId]
        return next
      })

      if (payload.state === 'done') {
        // The note's summary/markdown/status just changed on disk —
        // invalidate its cache entry, refetch it if it's the one currently
        // on screen (so the AI notes panel picks up the real summary
        // without a manual reselect), and refresh the notes list so its
        // status flips transcribed -> ready in the sidebar/header pill.
        invalidateNoteCache(payload.noteId)
        if (payload.noteId === selectedNoteId) {
          loadNoteTranscript(payload.noteId, { force: true })
        }
        refreshNotes()
      }
    },
    [],
  )

  // --- speaker detection lifecycle -----------------------------------------
  //
  // Per-note diarization status/error, driven by `diar-status` events —
  // same unconditional-listener, keyed-by-note-id shape as the
  // summarization block above (the auto pass after a recording finalizes
  // fires whether or not NoteView is looking). On `done` the transcript's
  // speaker labels (and meta's speaker count) just changed on disk, so the
  // cache/refetch/refresh treatment mirrors `summary-status` 'done' exactly.
  const [diarStatus, setDiarStatus] = useState<Record<string, SummaryEventState>>({})
  const [diarError, setDiarError] = useState<Record<string, string>>({})

  useTauriEvent(
    onDiarStatus,
    payload => {
      setDiarStatus(prev => ({ ...prev, [payload.noteId]: payload.state }))

      if (payload.state === 'error') {
        setDiarError(prev => ({ ...prev, [payload.noteId]: payload.error ?? 'Speaker detection failed' }))
        return
      }
      setDiarError(prev => {
        if (!(payload.noteId in prev)) return prev
        const next = { ...prev }
        delete next[payload.noteId]
        return next
      })

      if (payload.state === 'done') {
        invalidateNoteCache(payload.noteId)
        if (payload.noteId === selectedNoteId) {
          loadNoteTranscript(payload.noteId, { force: true })
        }
        refreshNotes()
      }
    },
    [],
  )

  /**
   * "Detect speakers" button (and its re-run-with-count form): queues the
   * diarization pass for `id`; `numSpeakers` forces an exact count, `null`
   * is automatic. Same queued-not-finished contract as `regenerateSummary`
   * — `diar-status` events drive the state above — and the same synchronous
   * `.catch` for the reject-without-event cases (models not downloaded, a
   * pass already running).
   */
  const detectSpeakers = useCallback((id: string, numSpeakers: number | null = null) => {
    ipc.diarizeNote(id, numSpeakers).catch(err => {
      setDiarStatus(prev => ({ ...prev, [id]: 'error' }))
      setDiarError(prev => ({ ...prev, [id]: messageOf(err) }))
    })
  }, [])

  /**
   * Regenerate button / auto-trigger retry: (re)triggers summarization for
   * `id` via `summarize_note`. Resolves once the backend has *queued* the
   * worker, not once it finishes — `summary-status` events (see the
   * listener above) are what actually drive `summaryStatus`/`summaryError`
   * and the eventual cache refresh. Still worth its own `.catch` here
   * (rather than relying solely on the event stream): `summarize_note`
   * rejects synchronously — with no `summary-status` event at all — when
   * the engine is already busy with another note, so that failure would
   * otherwise go unsurfaced.
   *
   * `useCallback` with no deps — only closes over stable setters and the
   * module-level `messageOf` — so this has a permanently stable identity.
   */
  const regenerateSummary = useCallback((id: string) => {
    ipc.summarizeNote(id).catch(err => {
      setSummaryStatus(prev => ({ ...prev, [id]: 'error' }))
      setSummaryError(prev => ({ ...prev, [id]: messageOf(err) }))
    })
  }, [])

  /**
   * AI notes panel checkbox click: flips one action item's `done` state.
   * Optimistic — updates the cached `SummaryDoc` (and, if `id` is the
   * selected note, `selectedSummary`) immediately, then confirms via
   * `toggle_action_item`. On success the cache entry is dropped and (if
   * selected) force-refetched rather than merged from the command's
   * response — `toggle_action_item` only returns the updated `SummaryDoc`,
   * not a fresh `markdown` rendering, and `note.md`'s checkbox did change
   * server-side, so a full refetch is what keeps the Markdown tab honest.
   * On failure, reverts the optimistic edit and reports the error.
   *
   * `useCallback` (deps: `selectedNoteId`, `cacheGet`, `cacheSet`,
   * `loadNoteTranscript`, `reportError`) — `cacheGet`/`cacheSet`/
   * `loadNoteTranscript` are each independently stable (see their own docs
   * above), so this only actually gets a fresh identity when the selected
   * note changes.
   */
  const toggleActionItem = useCallback(
    (id: string, index: number, done: boolean) => {
      const before = cacheGet(id)
      const previousDone = before?.summary?.actionItems[index]?.done
      if (before?.summary) {
        const optimisticSummary: SummaryDoc = {
          ...before.summary,
          actionItems: before.summary.actionItems.map((item, i) => (i === index ? { ...item, done } : item)),
        }
        cacheSet(id, { ...before, summary: optimisticSummary })
        if (id === selectedNoteId) setSelectedSummary(optimisticSummary)
      }

      ipc
        .toggleActionItem(id, index, done)
        .then(() => {
          invalidateNoteCache(id)
          if (id === selectedNoteId) loadNoteTranscript(id, { force: true })
        })
        .catch(err => {
          // Scoped revert: flip only *this* toggle's field back, applied
          // against whatever the cache holds right now — not the
          // full-document snapshot captured when this call started. A
          // second, unrelated toggle (or a confirmed refetch) may have
          // landed in between; reverting off the stale snapshot would
          // clobber that change instead of just undoing this one. If the
          // cache entry (or this specific action item within it) isn't
          // there anymore — evicted, or replaced wholesale by a
          // `summary-status` 'done' refresh — there's nothing safe to patch
          // in place, so fall back to a plain forced refetch instead.
          const current = cacheGet(id)
          const currentItem = current?.summary?.actionItems[index]
          if (current?.summary && currentItem && previousDone !== undefined) {
            const revertedSummary: SummaryDoc = {
              ...current.summary,
              actionItems: current.summary.actionItems.map((item, i) => (i === index ? { ...item, done: previousDone } : item)),
            }
            cacheSet(id, { ...current, summary: revertedSummary })
            if (id === selectedNoteId) setSelectedSummary(revertedSummary)
          } else if (id === selectedNoteId) {
            loadNoteTranscript(id, { force: true })
          }
          reportError(err)
        })
    },
    [selectedNoteId, cacheGet, cacheSet, invalidateNoteCache, loadNoteTranscript, reportError],
  )

  // --- ask-your-notes -------------------------------------------------------
  //
  // Session-only chat history + lifecycle per note, driven by `ask-status`/
  // `ask-answer` events — same keyed-by-note-id, not-just-the-selected-one
  // shape as `summaryStatus`/`summaryError` above, for the same reason (an
  // ask in flight for a note the user has since navigated away from must
  // still land correctly once that note is reselected). Never persisted —
  // see `AskHistoryEntry`'s docs.
  const [askHistoryMap, setAskHistoryMap] = useState<Record<string, AskHistoryEntry[]>>({})
  const [askStatusMap, setAskStatusMap] = useState<Record<string, AskEventState>>({})

  // The question currently in flight for a given note, keyed by note id —
  // needed because the `ask-status` 'error' event (unlike `ask-answer')
  // doesn't carry the question it was answering, so it has to be recovered
  // from here to build a history entry. A plain mutable ref (not state):
  // nothing ever needs to re-render off this by itself, only off the
  // `askHistoryMap`/`askStatusMap` updates that read it.
  const pendingQuestion = useRef<Record<string, string>>({})

  // Monotonically increasing across every note this hook instance ever
  // tracks (not reset per-note) — see `AskHistoryEntry.id`'s docs. A plain
  // ref, bumped imperatively at each of the two insertion points below
  // (`recordAskError`/the `ask-answer` handler) — never itself read by a
  // render, so it doesn't need to be state.
  const nextAskEntryId = useRef(0)

  /**
   * Appends an error entry to `id`'s ask history using whatever question is
   * currently recorded as pending for it in `pendingQuestion`, then clears
   * that pending entry — a no-op if nothing is pending (already recorded,
   * or nothing was ever in flight). This double-duty as both "record the
   * error" and "the guard against recording it twice" is what makes it safe
   * to call from both of `askQuestion`'s two possible error sources for the
   * same rejection — the `ask_note` command's own promise rejecting (always
   * happens) and, for the "no LLM installed" case specifically, the
   * `ask-status` 'error' event the backend *also* emits for that one case
   * (see `llm::ask_note`'s docs) — race-ordering between those two doesn't
   * matter: whichever runs first records the entry and clears the pending
   * question; the other sees nothing pending and does nothing.
   */
  const recordAskError = useCallback((id: string, errorMessage: string) => {
    const question = pendingQuestion.current[id]
    if (question === undefined) return
    delete pendingQuestion.current[id]
    setAskHistoryMap(prev => {
      const existing = prev[id] ?? []
      const entry: AskHistoryEntry = { id: nextAskEntryId.current++, question, error: errorMessage }
      return { ...prev, [id]: [entry, ...existing].slice(0, ASK_HISTORY_CAP) }
    })
  }, [])

  useTauriEvent(
    onAskStatus,
    payload => {
      setAskStatusMap(prev => ({ ...prev, [payload.noteId]: payload.state }))
      if (payload.state === 'error') {
        recordAskError(payload.noteId, payload.error ?? 'Failed to answer.')
      } else if (payload.state === 'done') {
        // The answer (if any) already arrived via `ask-answer`, emitted
        // before `done` by the worker — nothing left to record here; just
        // make sure nothing pending lingers past a successful round trip.
        delete pendingQuestion.current[payload.noteId]
      }
    },
    [],
  )

  useTauriEvent(
    onAskAnswer,
    payload => {
      delete pendingQuestion.current[payload.noteId]
      setAskHistoryMap(prev => {
        const existing = prev[payload.noteId] ?? []
        const entry: AskHistoryEntry = { id: nextAskEntryId.current++, question: payload.question, answer: payload.answer }
        return { ...prev, [payload.noteId]: [entry, ...existing].slice(0, ASK_HISTORY_CAP) }
      })
    },
    [],
  )

  /**
   * Ask panel submit (and retry — the panel just re-invokes this with the
   * previous entry's `question`): asks `question` about note `id`'s
   * transcript via `ask_note`. Resolves once the backend has *queued* the
   * worker, not once the answer is ready — `ask-status`/`ask-answer` events
   * are what actually drive `askStatusMap`/`askHistoryMap`. A blank
   * (whitespace-only) `question` is a no-op, matching the backend's own
   * "question is empty" rejection — never worth taking the busy slot (or
   * recording a pointless history entry) for.
   *
   * `useCallback` with no deps — only closes over stable setters/refs — so
   * this has a permanently stable identity.
   */
  const askQuestion = useCallback((id: string, question: string) => {
    const trimmed = question.trim()
    if (!trimmed) return
    pendingQuestion.current[id] = trimmed
    ipc.askNote(id, trimmed).catch(err => {
      // Covers both synchronous-rejection shapes `ask_note` can produce
      // (see `llm::ask_note`'s docs): "busy"/"question is empty" never get
      // a matching `ask-status` event at all, so without this the pending
      // question would hang forever un-recorded; "no summary model
      // installed" *does* also emit one, but `recordAskError` is idempotent
      // per pending question, so whichever of the two gets here first wins
      // and the other is a no-op.
      recordAskError(id, messageOf(err))
    })
  }, [recordAskError])

  const askHistory = selectedNoteId ? askHistoryMap[selectedNoteId] ?? [] : []
  const rawAskState = selectedNoteId ? askStatusMap[selectedNoteId] : undefined
  const askStatus: AskStatus = rawAskState === 'running' || rawAskState === 'error' ? rawAskState : 'idle'

  /**
   * Whether *any* note's LLM generation — a summarize or an ask, for any
   * note, not just the selected one — is currently in flight, derived from
   * the same `summaryStatus`/`askStatusMap` this hook already tracks rather
   * than a dedicated backend query. Mirrors the backend's single `LlmBusy`
   * flag (see `llm.rs`'s docs — at most one generation runs app-wide at a
   * time), so at most one of these two `.some(...)` checks is ever true at
   * once in practice; both are checked anyway rather than assuming which.
   * `AiNotesPanel` uses this to disable the ask input (and show "Waiting
   * for the current generation…") even when it's some *other* note that's
   * busy, honestly reflecting that submitting right now would just be
   * rejected server-side.
   */
  const llmBusy = Object.values(summaryStatus).some(s => s === 'running') || Object.values(askStatusMap).some(s => s === 'running')

  /**
   * Removes `id`'s entries from every per-note map this hook otherwise
   * grows unboundedly over a session — `summaryStatus`/`summaryError`/
   * `askStatusMap`/`askHistoryMap`. Unlike `transcriptCache` (LRU-capped —
   * see `TRANSCRIPT_CACHE_CAP`) these four were never bounded and never
   * pruned: a deleted note's stale summarization/ask state used to sit
   * around in memory for the rest of the session even though the note
   * itself is gone. Also clears any pending ask question for `id` — dead
   * weight once the note it was in flight for no longer exists.
   * `useAppState`'s `deleteNote` calls this alongside `invalidateNoteCache`
   * (a different concern — the transcript/summary *content* cache, not
   * this lifecycle bookkeeping). `useCallback` with no deps — permanently
   * stable, same rationale as `invalidateNoteCache`.
   */
  const pruneNoteDetail = useCallback((id: string) => {
    delete pendingQuestion.current[id]
    setSummaryStatus(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setSummaryError(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setDiarStatus(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setDiarError(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setAskStatusMap(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setAskHistoryMap(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  return {
    selectedTranscript,
    selectedMeta,
    selectedSummary,
    selectedMarkdown,
    selectedAudioPath,
    transcriptLoading,
    loadNoteTranscript,
    invalidateNoteCache,
    pruneNoteDetail,
    summaryStatus,
    summaryError,
    regenerateSummary,
    diarStatus,
    diarError,
    detectSpeakers,
    toggleActionItem,
    askHistory,
    askStatus,
    askQuestion,
    llmBusy,
  }
}

/** `ask-status`'s raw wire `state` — kept distinct from the collapsed `AskStatus` this hook exposes for the selected note (mirrors `SummaryEventState`/`SummaryStatus`'s split). */
type AskEventState = 'running' | 'done' | 'error'

export type NoteDetail = ReturnType<typeof useNoteDetail>
