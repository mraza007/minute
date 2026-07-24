import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onRecordingState, onSttStatus, onSummaryStatus, onTranscriptSegment } from '../ipc/events'
import type { Hardware, NoteMeta, NoteWithTranscript, StorageStats, StoredSegment, SummaryDoc, TranscriptSegmentEvent } from '../ipc/types'
import type { NoteTab, SttStatus, View } from '../types'
import { formatBytes, formatMmSs, groupLiveSegments, modelDisplayName, notesToSidebarItems } from './adapters'
import { useModelManager } from './useModelManager'
import { useTauriEvent } from './useTauriEvent'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const LAST_ERROR_TIMEOUT_MS = 5000

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
 * real summary/decisions/action items normally at that point). Callers
 * collapse `summaryStatus[id]` (a `SummaryEventState | undefined`) down to
 * this before handing it to `NoteView`/`AiNotesPanel` — see `App.tsx`.
 */
export type SummaryStatus = 'idle' | 'running' | 'error'

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

export function useAppState() {
  const [view, setView] = useState<View>('loading')
  const [loaded, setLoaded] = useState(false)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [lastError, setLastErrorState] = useState<string | null>(null)

  const [sel, setSel] = useState(0)
  const [noteTab, setNoteTab] = useState<NoteTab>('transcript')

  // Recording slice — entirely backend-event-driven (no local interval
  // timer): `activeNoteId` is what every recording/segment event handler
  // below filters incoming payloads against, so a stray event belonging to
  // a previous (already-stopped) recording can never leak into the live
  // view. See `startRec`/`togglePause`/`stopRec` further down.
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null)
  const [liveSegmentsRaw, setLiveSegmentsRaw] = useState<TranscriptSegmentEvent[]>([])
  const [recElapsed, setRecElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [sttStatus, setSttStatus] = useState<SttStatus>('idle')
  const [sttError, setSttError] = useState<string | null>(null)
  // The note id the most recent onSttStatus event was actually about —
  // NoteView matches it against the selected note's id to show a
  // "Finalizing transcript…" pill for the stretch (if any) between a note
  // being marked stopped and its transcript actually finishing. `stopRec`
  // clears this (and `sttStatus`/`sttError`) once `stop_recording` itself
  // resolves — see its docs for why that's the correct, safe moment.
  const [sttStatusNoteId, setSttStatusNoteId] = useState<string | null>(null)
  // Guards `togglePause` against re-entrant double-calls (e.g. a fast
  // double-click) firing a second pause/resume IPC call before the first
  // one has resolved — see `togglePause`'s docs.
  const pauseInFlight = useRef(false)

  // Settings-backed storage/privacy toggles — seeded from `get_settings` in
  // the initial load effect below; `toggleDel`/`toggleEnc` further down
  // flip these optimistically and persist through `set_settings`.
  const [tDel, setTDel] = useState(true)
  const [tEnc, setTEnc] = useState(false)

  // Per-note summarization status/error, driven entirely by `summary-status`
  // events (registered at app-mount level below, alongside the recording
  // listeners — an auto-triggered summarization must not be missed just
  // because NoteView isn't mounted to see it land). Keyed by note id rather
  // than tracking only "the selected note" so a background summarization
  // (e.g. for a note the user has since navigated away from) still updates
  // correctly once its note is reselected. `summaryError` only ever holds
  // entries for notes currently in `'error'` state — cleared once a later
  // `running`/`done` event supersedes it.
  const [summaryStatus, setSummaryStatus] = useState<Record<string, SummaryEventState>>({})
  const [summaryError, setSummaryError] = useState<Record<string, string>>({})

  const errorTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Stable identity (only refs/setState in its closure) — required so that
  // startRec/togglePause/stopRec below, which all list it as a dependency,
  // can themselves have stable identities across renders (see their
  // `useCallback`s' docs for why that matters to RecordingView's memo).
  const reportError = useCallback((err: unknown) => {
    clearTimeout(errorTimeout.current)
    setLastErrorState(messageOf(err))
    errorTimeout.current = setTimeout(() => setLastErrorState(null), LAST_ERROR_TIMEOUT_MS)
  }, [])

  useEffect(() => () => clearTimeout(errorTimeout.current), [])

  // --- Note detail: real transcript loading for the selected note --------
  //
  // `selectedMeta`/`selectedTranscript`/`selectedSummary`/`selectedMarkdown`
  // back NoteView's Transcript/Markdown tabs and the AI notes panel once a
  // note is actually selected — fetched via `get_note` (the notes list
  // itself only carries `NoteMeta`, no segments/summary/markdown). Cached
  // per id in `transcriptCache` (LRU-capped — see `cacheGet`/`cacheSet`) so
  // re-selecting an already-viewed note is instant and doesn't re-hit the
  // backend; `renameNote`/`deleteNote`/the `summary-status` 'done' handler
  // below invalidate a note's cache entry since its on-disk content just
  // changed out from under whatever's cached.
  const [selectedTranscript, setSelectedTranscript] = useState<StoredSegment[]>([])
  const [selectedMeta, setSelectedMeta] = useState<NoteMeta | null>(null)
  const [selectedSummary, setSelectedSummary] = useState<SummaryDoc | null>(null)
  const [selectedMarkdown, setSelectedMarkdown] = useState('')
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const transcriptCache = useRef(new Map<string, NoteWithTranscript>())
  // Bumped on every `loadNoteTranscript` call and captured per in-flight
  // request — guards against an out-of-order resolution (e.g. quickly
  // selecting note A then B) clobbering newer state with a stale response.
  const transcriptRequestId = useRef(0)

  /** Reads a cache entry, marking it most-recently-used (moves it to the end of the map) — see `TRANSCRIPT_CACHE_CAP`'s docs. `undefined` on a miss, same as `Map.get`. */
  function cacheGet(id: string): NoteWithTranscript | undefined {
    const entry = transcriptCache.current.get(id)
    if (entry) {
      transcriptCache.current.delete(id)
      transcriptCache.current.set(id, entry)
    }
    return entry
  }

  /** Writes a cache entry as most-recently-used, evicting the single oldest entry if this pushes the map over `TRANSCRIPT_CACHE_CAP`. */
  function cacheSet(id: string, data: NoteWithTranscript) {
    transcriptCache.current.delete(id)
    transcriptCache.current.set(id, data)
    if (transcriptCache.current.size > TRANSCRIPT_CACHE_CAP) {
      const oldestId = transcriptCache.current.keys().next().value
      if (oldestId !== undefined) transcriptCache.current.delete(oldestId)
    }
  }

  function loadNoteTranscript(id: string, opts: { force?: boolean } = {}) {
    if (!opts.force) {
      const cached = cacheGet(id)
      if (cached) {
        setSelectedMeta(cached.meta)
        setSelectedTranscript(cached.transcript.segments)
        setSelectedSummary(cached.summary)
        setSelectedMarkdown(cached.markdown)
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
      })
      .catch(err => {
        if (transcriptRequestId.current !== requestId) return
        reportError(err)
      })
      .finally(() => {
        if (transcriptRequestId.current === requestId) setTranscriptLoading(false)
      })
  }

  const selectedNoteId = notes[sel]?.id ?? null

  useEffect(() => {
    if (!selectedNoteId) {
      setSelectedMeta(null)
      setSelectedTranscript([])
      setSelectedSummary(null)
      setSelectedMarkdown('')
      return
    }
    loadNoteTranscript(selectedNoteId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId])

  /** Header pencil → inline-edit commit: renames on disk, refreshes the notes list, and (if still selected) reloads this note's transcript with its fresh title. */
  function renameNote(id: string, title: string) {
    ipc
      .renameNote(id, title)
      .then(() => {
        transcriptCache.current.delete(id)
        return ipc.listNotes()
      })
      .then(freshNotes => {
        setNotes(freshNotes)
        if (id === selectedNoteId) loadNoteTranscript(id, { force: true })
      })
      .catch(reportError)
  }

  /** Header trash (after 4s-arm confirm) → deletes on disk, refreshes the notes list, and clamps the selection onto whatever note now sits at the same index (i.e. "the next note"). */
  function deleteNote(id: string) {
    ipc
      .deleteNote(id)
      .then(() => {
        transcriptCache.current.delete(id)
        return ipc.listNotes()
      })
      .then(freshNotes => {
        setNotes(freshNotes)
        setSel(prevSel => Math.min(prevSel, Math.max(freshNotes.length - 1, 0)))
      })
      .catch(reportError)
  }

  /** Markdown card "Reveal in Finder" → reveals the note's audio.wav (or its folder) in Finder. */
  function revealNote(id: string) {
    ipc.revealNote(id).catch(reportError)
  }

  // Model catalog, downloads, and the transcription-model selection are
  // split into their own hook — see useModelManager.ts. It also re-gates
  // `view` back to 'onboarding' if the last installed STT model gets
  // deleted, and reassigns `sttModel` off a now-uninstalled pick.
  const modelManager = useModelManager({ view, setView, loaded })

  // Initial load: models, notes, hardware, recommendation, and storage stats
  // all come from the backend in one shot. Until this resolves, `view`
  // stays 'loading' — App.tsx renders nothing but a spinner for that state.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      ipc.listModels(),
      ipc.listNotes(),
      ipc.hardwareInfo(),
      ipc.recommendedModels(),
      ipc.storageStats(),
      ipc.getSettings(),
    ])
      .then(([loadedModels, loadedNotes, loadedHardware, loadedRecommendation, loadedStorage, loadedSettings]) => {
        if (cancelled) return
        modelManager.applyInitialLoad(loadedModels, loadedRecommendation, loadedSettings)
        setNotes(loadedNotes)
        setHardware(loadedHardware)
        setStorage(loadedStorage)
        setTDel(loadedSettings.deleteAudioAfter30d)
        setTEnc(loadedSettings.encryptLibrary)
        const hasInstalledStt = loadedModels.some(m => m.kind === 'stt' && m.state === 'installed')
        setView(hasInstalledStt ? 'notes' : 'onboarding')
        setLoaded(true)
      })
      .catch(err => {
        if (cancelled) return
        reportError(err)
        // Nothing usable came back — fall through to the (empty) notes
        // view rather than stranding the app on the loading spinner.
        setView('notes')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribed unconditionally (not gated on `view === 'recording'`) so
  // there's no mount-timing race against `start_recording`'s response —
  // every handler below filters on `activeNoteId` instead. useTauriEvent
  // refreshes its callback closure on every render, so referencing
  // `activeNoteId` directly here always sees its latest value without a
  // manual ref.
  useTauriEvent(
    onRecordingState,
    payload => {
      if (payload.noteId !== activeNoteId) return
      setRecElapsed(payload.elapsed)
      setPaused(payload.state === 'paused')
    },
    [],
  )

  useTauriEvent(
    onTranscriptSegment,
    payload => {
      if (payload.noteId !== activeNoteId) return
      setLiveSegmentsRaw(prev => [...prev, payload])
    },
    [],
  )

  useTauriEvent(
    onSttStatus,
    payload => {
      if (payload.noteId !== activeNoteId) return
      setSttStatus(payload.state)
      setSttError(payload.error)
      setSttStatusNoteId(payload.noteId)
    },
    [],
  )

  // Registered unconditionally at app-mount level (not gated on a note
  // being selected, or on `view === 'notes'`) — same rationale as the
  // recording listeners above: `stop_recording` auto-triggers
  // summarization in the background, so the `running`/`done`/`error`
  // sequence for it must land even if the user has navigated to Settings
  // or a different note in the meantime. References `selectedNoteId`
  // directly rather than through a ref — safe because `useTauriEvent`
  // refreshes its callback closure on every render (see its docs), so this
  // always sees the latest selection without needing one.
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
        transcriptCache.current.delete(payload.noteId)
        if (payload.noteId === selectedNoteId) {
          loadNoteTranscript(payload.noteId, { force: true })
        }
        ipc.listNotes().then(setNotes).catch(reportError)
      }
    },
    [],
  )

  const sidebarNotes = useMemo(() => notesToSidebarItems(notes, new Date()), [notes])

  const statsLine = useMemo(() => {
    const totalBytes = storage ? storage.modelsBytes + storage.audioBytes + storage.notesBytes : 0
    return `${notes.length} notes · ${formatBytes(totalBytes)} local · nothing synced`
  }, [notes, storage])

  const liveSegments = useMemo(() => groupLiveSegments(liveSegmentsRaw), [liveSegmentsRaw])

  const sttModelDisplayName = useMemo(
    () => modelDisplayName(modelManager.models, modelManager.sttModel),
    [modelManager.models, modelManager.sttModel],
  )

  const llmModelDisplayName = useMemo(
    () => modelDisplayName(modelManager.models, modelManager.llmModel ?? ''),
    [modelManager.models, modelManager.llmModel],
  )

  /** Whether the currently selected summary model is actually installed — what the AI notes panel's empty state (a "Generate summary" button vs. a "download a model" prompt) branches on. */
  const llmInstalled = useMemo(
    () => modelManager.llmModel !== null && modelManager.models.some(m => m.kind === 'llm' && m.id === modelManager.llmModel && m.state === 'installed'),
    [modelManager.models, modelManager.llmModel],
  )

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
   */
  function regenerateSummary(id: string) {
    ipc.summarizeNote(id).catch(err => {
      setSummaryStatus(prev => ({ ...prev, [id]: 'error' }))
      setSummaryError(prev => ({ ...prev, [id]: messageOf(err) }))
    })
  }

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
   */
  function toggleActionItem(id: string, index: number, done: boolean) {
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
        transcriptCache.current.delete(id)
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
  }

  /**
   * Starts a new recording with the currently selected STT model.
   * `useCallback` (deps: `modelManager.sttModel`, `reportError`) so this
   * has a stable identity across renders that don't actually change either
   * — see `togglePause`/`stopRec`'s docs for why that matters.
   */
  const startRec = useCallback(() => {
    ipc
      .startRecording(modelManager.sttModel)
      .then(noteId => {
        setActiveNoteId(noteId)
        setLiveSegmentsRaw([])
        setRecElapsed(0)
        setPaused(false)
        setSttStatus('idle')
        setSttError(null)
        setSttStatusNoteId(null)
        setView('recording')
      })
      .catch(reportError)
  }, [modelManager.sttModel, reportError])

  /**
   * Flips `paused` optimistically, then asks the backend to actually
   * pause/resume. The next `recording-state` tick (at most ~1s away, or
   * immediate — `pause_recording`/`resume_recording` themselves emit one
   * synchronously) reconciles it either way, so a failed call just needs to
   * be reported, not manually rolled back. Re-entrant calls (a fast
   * double-click) while the previous pause/resume call is still in flight
   * are ignored outright via `pauseInFlight` — without this, a rapid
   * double-call would fire pause_recording *and* resume_recording back to
   * back with no ordering guarantee between their responses.
   *
   * `useCallback` (deps: `paused`, `reportError`) — RecordingView is
   * `React.memo`'d and receives this directly as a prop; without a stable
   * identity across renders that don't change `paused` itself, a plain
   * function literal here would be recreated on every `useAppState` render
   * (e.g. the 1Hz `recording-state` tick touching unrelated state) and
   * defeat that memo every time.
   */
  const togglePause = useCallback(() => {
    if (pauseInFlight.current) return
    pauseInFlight.current = true
    const nextPaused = !paused
    setPaused(nextPaused)
    const action = nextPaused ? ipc.pauseRecording() : ipc.resumeRecording()
    action.catch(reportError).finally(() => {
      pauseInFlight.current = false
    })
  }, [paused, reportError])

  /**
   * Stops the active recording: sets `stopping` (RecordingView disables its
   * controls off this) until the backend finishes finalizing, then
   * refreshes the note list + storage stats, selects the newly finalized
   * note, and returns to the notes view. `sttStatus`/`sttError`/
   * `sttStatusNoteId` are reset to idle *after* `stop_recording` resolves
   * (not before, and not left alone) — safe because the backend's
   * `stop_recording` command joins the stt worker thread before returning,
   * so the transcript is already complete and no further stt-status event
   * for this note will ever arrive; resetting here is what actually clears
   * a "Finalizing transcript…" pill NoteView would otherwise show forever
   * (nothing else ever moves `sttStatus` off `'finalizing'`).
   *
   * The `listNotes`/`storageStats` refresh is handled as its own inner
   * `.catch` + `.finally` — separate from `stop_recording`'s own outer
   * `.catch` below — precisely so that if `stop_recording` itself
   * *succeeds* but this follow-up refresh rejects (backend hiccup reading
   * the list back), the view still finishes leaving 'recording': `notes`/
   * `storage` stay whatever they were before (stale, but present — no
   * point discarding a known-good list for a failed refetch), the error is
   * still reported, and every recording-lifecycle field still gets reset.
   * Without this split, that refresh's rejection would fall through to the
   * *outer* `.catch` (which only handles `stop_recording` itself failing)
   * and leave the view stuck on 'recording' forever despite the recording
   * having actually stopped successfully on the backend.
   *
   * `useCallback` (deps: `reportError` only — everything else referenced
   * is either a stable setter or read fresh off the async results, not off
   * render-time state) for the same stable-identity-for-RecordingView's-
   * memo reason as `togglePause`.
   */
  const stopRec = useCallback(() => {
    setStopping(true)
    ipc
      .stopRecording()
      .then(newNote => {
        Promise.all([ipc.listNotes(), ipc.storageStats()])
          .then(([freshNotes, freshStorage]) => {
            setNotes(freshNotes)
            setStorage(freshStorage)
            transcriptCache.current.delete(newNote.id)
            const idx = freshNotes.findIndex(n => n.id === newNote.id)
            setSel(idx >= 0 ? idx : 0)
          })
          .catch(reportError)
          .finally(() => {
            setView('notes')
            setActiveNoteId(null)
            setLiveSegmentsRaw([])
            setSttStatus('idle')
            setSttError(null)
            setSttStatusNoteId(null)
            setStopping(false)
          })
      })
      .catch(err => {
        setStopping(false)
        reportError(err)
      })
  }, [reportError])

  // `useCallback` (stable identity, no deps beyond the setter) — passed
  // straight through to the memoized Sidebar/TitleBar as `onGoNotes`/
  // `onGoSettings`/`onReturnToRecording`; a fresh arrow here every render
  // would defeat those memos exactly like an unstable `startRec`/
  // `togglePause`/`stopRec` would defeat RecordingView's.
  const goNotes = useCallback(() => setView('notes'), [])
  const goSettings = useCallback(() => setView('settings'), [])
  // The REC pill's "return to recording" action — navigating to Settings or
  // the notes list mid-recording is legitimate (goNotes/goSettings above
  // stay unguarded), so this is the persistent way back to the live view.
  const goRecording = useCallback(() => setView('recording'), [])

  const toggleDel = useCallback(() => {
    setTDel(next => {
      const flipped = !next
      ipc.setSettings({ deleteAudioAfter30d: flipped }).catch(reportError)
      return flipped
    })
  }, [reportError])

  const toggleEnc = useCallback(() => {
    setTEnc(next => {
      const flipped = !next
      ipc.setSettings({ encryptLibrary: flipped }).catch(reportError)
      return flipped
    })
  }, [reportError])

  return {
    view,
    // Derived from backend truth (a recording is active iff the backend
    // gave us a note id for it via `start_recording` and we haven't seen
    // `stop_recording` resolve yet) rather than `view === 'recording'` —
    // `view` is just which screen is on-screen right now and legitimately
    // moves to 'notes'/'settings' while a recording keeps running in the
    // background (see `goNotes`/`goSettings`/`goRecording` below); this is
    // what TitleBar's REC pill vs "New recording" button switch on, so it
    // stays correct regardless of which view the user is currently looking
    // at.
    isRecording: activeNoteId !== null,
    models: modelManager.models,
    downloads: modelManager.downloads,
    notes,
    hardware,
    recommendation: modelManager.recommendation,
    storage,
    lastError: lastError ?? modelManager.lastError,
    sttModel: modelManager.sttModel,
    sttModelDisplayName,
    llmModel: modelManager.llmModel,
    llmModelDisplayName,
    llmInstalled,
    sel,
    recElapsed,
    paused,
    stopping,
    sttStatus,
    sttError,
    sttStatusNoteId,
    liveSegments,
    selectedTranscript,
    selectedMeta,
    selectedSummary,
    selectedMarkdown,
    summaryStatus,
    summaryError,
    transcriptLoading,
    tDel,
    tEnc,
    noteTab,
    sidebarNotes,
    statsLine,
    recTime: formatMmSs(recElapsed),
    goNotes,
    goSettings,
    goRecording,
    startRec,
    stopRec,
    togglePause,
    selectNote: setSel,
    setNoteTab,
    setSttModel: modelManager.setSttModel,
    setLlmModel: modelManager.setLlmModel,
    toggleDel,
    toggleEnc,
    downloadModel: modelManager.downloadModel,
    cancelDownload: modelManager.cancelDownload,
    deleteModel: modelManager.deleteModel,
    // Persists the recommended pair as the user's explicit selections for
    // whichever of the two actually finished installing during onboarding
    // (the STT one always did, by construction — "Start using Minute" is
    // disabled otherwise; the LLM one is optional) — `modelManager.sttModel`/
    // `llmModel` are already set to these in-memory (via the re-gate effect
    // reacting to the download completing), but that reassignment doesn't
    // itself write through to settings.json, so this call is what actually
    // persists the pick once the user commits to it.
    completeOnboarding: () => {
      const rec = modelManager.recommendation
      if (rec) {
        const sttInstalled = modelManager.models.find(m => m.kind === 'stt' && m.id === rec.stt && m.state === 'installed')
        if (sttInstalled) modelManager.setSttModel(sttInstalled.id)
        const llmInstalledEntry = modelManager.models.find(m => m.kind === 'llm' && m.id === rec.llm && m.state === 'installed')
        if (llmInstalledEntry) modelManager.setLlmModel(llmInstalledEntry.id)
      }
      setView('notes')
    },
    renameNote,
    deleteNote,
    revealNote,
    regenerateSummary,
    toggleActionItem,
    reportError,
  }
}

export type AppState = ReturnType<typeof useAppState>
