import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onMeetingPopupStart, onRecordingState, onSttStatus, onTranscriptSegment } from '../ipc/events'
import type { Hardware, NoteMeta, StorageStats, TranscriptSegmentEvent } from '../ipc/types'
import type { NoteTab, SttStatus, View } from '../types'
import { formatBytes, formatMmSs, groupLiveSegments, modelDisplayName, notesToSidebarItems } from './adapters'
import { useModelManager } from './useModelManager'
import { useNoteDetail } from './useNoteDetail'
import { useTauriEvent } from './useTauriEvent'

// `SummaryEventState`/`SummaryStatus` moved to `useNoteDetail.ts` (Stage 4
// Task 5's extraction of this hook's note-detail slice) — re-exported here
// unchanged so existing imports (`NoteView` imports `SummaryStatus` from
// this module) don't have to churn.
export type { SummaryEventState, SummaryStatus } from './useNoteDetail'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const LAST_ERROR_TIMEOUT_MS = 5000

/** Debounce window (ms) between a keystroke in the sidebar search input and the `search_notes` call it triggers — same value the ⌘K palette (`SearchPalette`) debounces its own input at. */
const SIDEBAR_SEARCH_DEBOUNCE_MS = 150

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

  // Settings-backed storage/privacy toggle — seeded from `get_settings` in
  // the initial load effect below; `toggleDel` further down flips this
  // optimistically and persists through `set_settings`. There used to be a
  // second one (`tEnc`/`toggleEnc`, "Encrypt note library") — Stage 4 Task 3
  // removed it as a fake capability (the app never implemented at-rest
  // encryption of its own); Settings.tsx now shows a passive FileVault line
  // in its place instead of a toggle.
  const [tDel, setTDel] = useState(true)

  // Settings-backed meeting-detection toggle (Stage 5 Task 3) — same
  // optimistic-flip-then-persist shape as `tDel`/`toggleDel` just above.
  // Seeded from `get_settings` in the initial load effect below; also set
  // (once, at most) by `completeOnboarding` if the onboarding opt-in row was
  // checked — see that callback's docs.
  const [tMeetingDetection, setTMeetingDetection] = useState(false)

  // --- ⌘K search palette + sidebar filter ---------------------------------
  //
  // `searchOpen` gates SearchPalette's mount in App.tsx. `pendingSeek` is a
  // one-shot "open this note, then seek to this position once its audio is
  // ready" request (see `requestSeek`'s docs below) — deliberately separate
  // from `sel`/`selectedNoteId` because note *selection* is synchronous (an
  // index into the already-loaded `notes` list) while a note's `audioPath`
  // only becomes known once its `get_note` fetch resolves; NoteView applies
  // the pending seek itself once that's ready, via `clearPendingSeek`. Two
  // effects further down (once `selectedNoteId`/`view` are in scope)
  // invalidate a still-unapplied `pendingSeek` the instant it's no longer
  // for "the note currently on screen, still in the notes view" — without
  // that, a transcript hit whose target note the user wanders away from
  // before it's ever applied would stay armed and go off as a surprise
  // seek+autoplay whenever that note is later reselected normally.
  const [searchOpen, setSearchOpen] = useState(false)
  const [pendingSeek, setPendingSeek] = useState<{ noteId: string; seconds: number } | null>(null)

  // Sidebar filter input: `sidebarQuery` is the raw text box value (kept
  // even while empty, for the input's own display); `sidebarMatchedIds` is
  // `null` when no filter is active (Sidebar renders every note, grouped as
  // normal) or a `Set` of matching note ids once a debounced `search_notes`
  // call has resolved for the current (non-blank) query — see
  // `setSidebarQuery` below.
  const [sidebarQuery, setSidebarQueryState] = useState('')
  const [sidebarMatchedIds, setSidebarMatchedIds] = useState<Set<string> | null>(null)
  const sidebarSearchTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Bumped on every debounced sidebar search call and captured per in-flight
  // request — same stale-response guard as `transcriptRequestId` above, so
  // a slow response to an abandoned query can never clobber a newer one's
  // result.
  const sidebarSearchSeq = useRef(0)

  useEffect(() => () => clearTimeout(sidebarSearchTimeout.current), [])

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

  const selectedNoteId = notes[sel]?.id ?? null

  /**
   * The selected note's transcript/summary/markdown/audio-path (LRU-cached),
   * summarization lifecycle, and ask-your-notes session state — see
   * `useNoteDetail`'s own docs for why this extraction exists and why
   * `selectedNoteId`/`reportError`/`refreshNotes` are threaded in rather
   * than this hook reaching for shared context.
   */
  const refreshNotes = useCallback(() => {
    ipc.listNotes().then(setNotes).catch(reportError)
  }, [reportError])
  const noteDetail = useNoteDetail({ selectedNoteId, reportError, refreshNotes })
  const { loadNoteTranscript, invalidateNoteCache, pruneNoteDetail } = noteDetail

  // Invalidates a still-pending seek the instant it's no longer for the
  // note currently on screen — covers every way `sel` can change
  // (`selectNoteById`, the search palette's own `requestSeek`,
  // `stopRec`/`deleteNote`'s index adjustments, ...) from one place, rather
  // than threading a "clear pendingSeek if it doesn't match" check through
  // each of those individually. `requestSeek` itself is not a special case
  // here: it sets `sel` and `pendingSeek` together in the same synchronous
  // call, so by the time this effect runs after that render, `selectedNoteId`
  // already equals the fresh `pendingSeek.noteId` and nothing is cleared.
  // The functional update returns `prev` itself (same reference) when
  // nothing needs to change, which is a documented React bail-out — safe to
  // run on every `selectedNoteId` change without an extra re-render when
  // there's nothing to invalidate.
  useEffect(() => {
    setPendingSeek(prev => (prev && prev.noteId !== selectedNoteId ? null : prev))
  }, [selectedNoteId])

  // Invalidates a still-pending seek the instant the user navigates away
  // from the notes view entirely (Settings, or back to a live recording) —
  // even if the target note's `sel` never actually changes underneath it
  // (NoteView, and the effect that applies `pendingSeek`, aren't mounted at
  // all outside the notes view — see App.tsx). Without this, going to
  // Settings and back to Notes on the very note a stale `pendingSeek`
  // targets would apply it the moment NoteView remounts, even though the
  // user never touched search again.
  useEffect(() => {
    if (view !== 'notes') setPendingSeek(null)
  }, [view])

  /**
   * Selects a note by id rather than list index — what the ⌘K search
   * palette (and `requestSeek` below) use, since a search hit only carries
   * a `noteId`, not the note's current position in `notes`. A no-op if `id`
   * isn't found in the current list. `useCallback` (deps: `notes`) — a
   * fresh identity only when the note list itself changes.
   */
  const selectNoteById = useCallback(
    (id: string) => {
      setSel(prevSel => {
        const idx = notes.findIndex(n => n.id === id)
        return idx >= 0 ? idx : prevSel
      })
    },
    [notes],
  )

  const openSearch = useCallback(() => setSearchOpen(true), [])
  const closeSearch = useCallback(() => setSearchOpen(false), [])

  /**
   * ⌘K palette "open this transcript hit" action: selects the hit's note
   * (by id — see `selectNoteById`) and records the timestamp to seek to
   * once that note's audio is actually loaded — see `pendingSeek`'s docs
   * above. `useCallback` (deps: `selectNoteById`, itself only refreshing
   * when `notes` changes).
   */
  const requestSeek = useCallback(
    (noteId: string, seconds: number) => {
      selectNoteById(noteId)
      setPendingSeek({ noteId, seconds })
    },
    [selectNoteById],
  )

  /**
   * Clears `pendingSeek` once NoteView has actually applied it — the *only*
   * path that fires this is a successful apply (matching note, audio
   * ready); NoteView never calls it for a mismatch, since there's nothing
   * to signal in that case. A pending seek that never gets applied at all
   * (the target note is abandoned before its audio loads, or the user
   * leaves the notes view) is invalidated separately, by the two effects
   * above `selectedNoteId`/`view` react to — not by this function.
   * `useCallback` with no deps — a permanently stable identity so it can be
   * handed to NoteView without defeating memoization.
   */
  const clearPendingSeek = useCallback(() => setPendingSeek(null), [])

  /**
   * Thin passthrough to `ipc.searchNotes` — exposed here (rather than
   * SearchPalette calling `ipc/commands` directly) so every backend call in
   * the app funnels through this hook, and so SearchPalette can be tested
   * with a plain injected function instead of mocking the IPC bridge.
   * `useCallback` with no deps — permanently stable.
   */
  const searchNotes = useCallback((query: string) => ipc.searchNotes(query), [])

  /**
   * Sidebar search input's `onChange` handler: updates the raw text value
   * immediately, then (re)starts a debounced `search_notes` call — cleared
   * and restarted on every keystroke, same debounce shape as
   * `SearchPalette`'s own input. A blank (or whitespace-only) query clears
   * `sidebarMatchedIds` back to `null` (no filter — every note shows,
   * grouped as normal) synchronously, without ever hitting the backend, so
   * clearing the search box restores the full list instantly rather than
   * waiting out a debounce window. `useCallback` with no deps (only touches
   * stable setters/refs) — permanently stable, so Sidebar's memo isn't
   * defeated by this prop.
   */
  const setSidebarQuery = useCallback((query: string) => {
    setSidebarQueryState(query)
    clearTimeout(sidebarSearchTimeout.current)
    // Bumped unconditionally — including the blank-query clear branch below
    // — so a response for whatever query was previously in flight can never
    // land after this call, even though the clear branch itself doesn't
    // start a new debounced search. Without this, clearing the box while a
    // search is still in flight would leave that stale request's id
    // current, and its eventual `.then`/`.catch` would repopulate
    // `sidebarMatchedIds` right after this call just set it back to `null`.
    const requestId = ++sidebarSearchSeq.current

    const trimmed = query.trim()
    if (trimmed === '') {
      setSidebarMatchedIds(null)
      return
    }

    sidebarSearchTimeout.current = setTimeout(() => {
      ipc
        .searchNotes(trimmed)
        .then(hits => {
          if (sidebarSearchSeq.current !== requestId) return
          setSidebarMatchedIds(new Set(hits.map(h => h.noteId)))
        })
        .catch(() => {
          if (sidebarSearchSeq.current !== requestId) return
          // Honest degrade: a failed search shows "no matches" rather than
          // silently falling back to the unfiltered list (which would look
          // like the search box has no effect) or a stale result set.
          setSidebarMatchedIds(new Set())
        })
    }, SIDEBAR_SEARCH_DEBOUNCE_MS)
  }, [])

  /**
   * Header pencil → inline-edit commit: renames on disk, refreshes the notes
   * list, and (if still selected) reloads this note's transcript with its
   * fresh title. `useCallback` (deps: `selectedNoteId`, `loadNoteTranscript`,
   * `reportError`) — same stable-identity rationale as `startRec`/
   * `togglePause`/`stopRec` above.
   */
  const renameNote = useCallback(
    (id: string, title: string) => {
      ipc
        .renameNote(id, title)
        .then(() => {
          invalidateNoteCache(id)
          return ipc.listNotes()
        })
        .then(freshNotes => {
          setNotes(freshNotes)
          if (id === selectedNoteId) loadNoteTranscript(id, { force: true })
        })
        .catch(reportError)
    },
    [selectedNoteId, loadNoteTranscript, invalidateNoteCache, reportError],
  )

  /**
   * Header trash (after 4s-arm confirm) → deletes on disk, refreshes the
   * notes list, and clamps the selection onto whatever note now sits at the
   * same index (i.e. "the next note"). `useCallback` (deps: `reportError`
   * only) — doesn't close over `selectedNoteId`/`sel` at all (the post-delete
   * selection is derived functionally off the fresh list), so this has a
   * permanently stable identity.
   */
  const deleteNote = useCallback(
    (id: string) => {
      ipc
        .deleteNote(id)
        .then(() => {
          invalidateNoteCache(id)
          // The note is gone on disk — its summarization/ask lifecycle
          // state (`summaryStatus`/`summaryError`/`askStatusMap`/
          // `askHistoryMap`) would otherwise sit around in memory for the
          // rest of the session with nothing left to ever clear it.
          pruneNoteDetail(id)
          return ipc.listNotes()
        })
        .then(freshNotes => {
          setNotes(freshNotes)
          setSel(prevSel => Math.min(prevSel, Math.max(freshNotes.length - 1, 0)))
        })
        .catch(reportError)
    },
    [invalidateNoteCache, pruneNoteDetail, reportError],
  )

  /**
   * Markdown card "Reveal in Finder" → reveals the note's audio.wav (or its
   * folder) in Finder. `useCallback` (deps: `reportError` only) — closes
   * over nothing else, so this has a permanently stable identity; passed
   * straight through to MarkdownCard as `onReveal`.
   */
  const revealNote = useCallback(
    (id: string) => {
      ipc.revealNote(id).catch(reportError)
    },
    [reportError],
  )

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
        setTMeetingDetection(loadedSettings.meetingDetection)
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
   * The meeting-popup's "Start recording" click (`popup::popup_start`'s
   * `meeting-popup-start` event) — see that command's docs (src-tauri/src/
   * popup.rs) for why the backend deliberately doesn't call
   * `start_recording` itself and emits this plain event instead: `startRec`
   * above is the *only* place the main window's `view` actually navigates
   * to `'recording'` (it's driven by `ipc.startRecording(...)`'s own
   * `.then`, not by listening for a `recording-state` event — that event
   * only ever updates an already-showing recording view's elapsed/paused
   * fields), so reusing it here — rather than duplicating a second,
   * lower-level recording-start path — is both the least code and the only
   * way this actually navigates anywhere.
   *
   * Mirrors `useModelManager`'s own `hasInstalledStt` re-gate check (same
   * `models.some(...)` shape) to decide whether there's actually a
   * transcription model to record with: `start_recording` itself has no
   * such guard (it happily records with no live transcript if the model
   * isn't installed — see `audio::spawn_stt_worker_if_model_installed`), so
   * this is the one place that check needs to be re-applied before calling
   * `startRec` from the popup path specifically. If none is installed, this
   * sends the user to onboarding with an honest message instead of quietly
   * starting an untranscribed recording.
   *
   * Two guards before any of that: `activeNoteId !== null` (Minute is
   * already recording) is a silent no-op rather than calling `startRec` —
   * `start_recording` would just reject with "a recording is already in
   * progress" server-side, which would only ever surface here as a
   * confusing toast for something the user didn't ask for from this event
   * in the first place; `DetectorCore` already suppresses showing a *new*
   * prompt while Minute is recording, so in practice this guards a rare
   * edge case (e.g. a recording started some other way while an
   * already-shown popup from just before it started is still up) rather
   * than the expected path. `view === 'onboarding'` is also a silent no-op
   * — meeting detection has no live detector thread (and Task 3 hasn't yet
   * added an onboarding-time opt-in row) while onboarding is showing today,
   * so this isn't reachable yet either, but guarding it now means it won't
   * fight the onboarding flow the moment Task 3 makes it reachable.
   */
  useTauriEvent(
    onMeetingPopupStart,
    () => {
      if (activeNoteId !== null || view === 'onboarding') return
      const hasInstalledStt = modelManager.models.some(m => m.kind === 'stt' && m.state === 'installed')
      if (hasInstalledStt) {
        startRec()
      } else {
        setView('onboarding')
        reportError('Install a transcription model in onboarding before Minute can start recording.')
      }
    },
    [activeNoteId, view, modelManager.models, startRec, reportError],
  )

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
            invalidateNoteCache(newNote.id)
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
  }, [reportError, invalidateNoteCache])

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

  /**
   * Settings screen's "Offer to record when a meeting starts" toggle —
   * identical optimistic-flip-then-persist shape as `toggleDel` above.
   * `set_settings` (lib.rs) live-applies this: it starts/stops the backend
   * detector thread synchronously off the very same call, so flipping this
   * on/off here takes effect immediately, not just on next launch.
   */
  const toggleMeetingDetection = useCallback(() => {
    setTMeetingDetection(next => {
      const flipped = !next
      ipc.setSettings({ meetingDetection: flipped }).catch(reportError)
      return flipped
    })
  }, [reportError])

  /**
   * Persists the recommended pair as the user's explicit selections for
   * whichever of the two actually finished installing during onboarding
   * (the STT one always did, by construction — "Start using Minute" is
   * disabled otherwise; the LLM one is optional) — `modelManager.sttModel`/
   * `llmModel` are already set to these in-memory (via the re-gate effect
   * reacting to the download completing), but that reassignment doesn't
   * itself write through to settings.json, so this call is what actually
   * persists the pick once the user commits to it.
   *
   * `useCallback` (deps: `modelManager.recommendation`, `modelManager.models`,
   * `modelManager.setSttModel`, `modelManager.setLlmModel`) — the latter two
   * are themselves permanently stable (see useModelManager), so this only
   * gets a fresh identity when the recommendation or model catalog actually
   * changes.
   */
  const { recommendation: modelRecommendation, models: modelCatalog, setSttModel: setSttModelOnComplete, setLlmModel: setLlmModelOnComplete } = modelManager

  /**
   * "Start using Minute" — persists whichever of the recommended STT/LLM
   * pair actually finished installing (unchanged from before), and now also
   * `meetingDetectionOptIn`: the onboarding opt-in row's checked state (see
   * `OnboardingView`'s `onStart` prop). Only actually calls `set_settings`
   * when the row was checked — `settings.meetingDetection` already defaults
   * to `false` (see `settings.rs`'s `Default` impl), so leaving the row
   * unchecked is a genuine no-op rather than a redundant write of a value
   * that's already correct; this keeps "unchecked changes nothing" an
   * honest, literal claim, not just a UI one. Chosen over writing it
   * together with the model selections in one batched patch because
   * `setSttModelOnComplete`/`setLlmModelOnComplete` above already each fire
   * their own independent `set_settings` call (see `useModelManager`) —
   * there's no existing "single onboarding-completion write" to join, so a
   * third small, independent patch call matches the established pattern
   * rather than introducing a new one.
   */
  const completeOnboarding = useCallback(
    (meetingDetectionOptIn: boolean) => {
      const rec = modelRecommendation
      if (rec) {
        const sttInstalled = modelCatalog.find(m => m.kind === 'stt' && m.id === rec.stt && m.state === 'installed')
        if (sttInstalled) setSttModelOnComplete(sttInstalled.id)
        const llmInstalledEntry = modelCatalog.find(m => m.kind === 'llm' && m.id === rec.llm && m.state === 'installed')
        if (llmInstalledEntry) setLlmModelOnComplete(llmInstalledEntry.id)
      }
      if (meetingDetectionOptIn) {
        setTMeetingDetection(true)
        ipc.setSettings({ meetingDetection: true }).catch(reportError)
      }
      setView('notes')
    },
    [modelRecommendation, modelCatalog, setSttModelOnComplete, setLlmModelOnComplete, reportError],
  )

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
    // `useNoteDetail`'s slice — handed through by name (not a blanket
    // `...noteDetail` spread) so this hook's return shape stays exactly what
    // it was before that extraction, plus the new ask-your-notes fields
    // (`askHistory`/`askStatus`/`askQuestion`/`llmBusy`) it now also owns —
    // `loadNoteTranscript`/`invalidateNoteCache`/`pruneNoteDetail` are
    // `useNoteDetail`'s own internal seam (used above by `renameNote`/
    // `deleteNote`/`stopRec`), not part of this hook's public surface.
    selectedTranscript: noteDetail.selectedTranscript,
    selectedMeta: noteDetail.selectedMeta,
    selectedSummary: noteDetail.selectedSummary,
    selectedMarkdown: noteDetail.selectedMarkdown,
    selectedAudioPath: noteDetail.selectedAudioPath,
    summaryStatus: noteDetail.summaryStatus,
    summaryError: noteDetail.summaryError,
    transcriptLoading: noteDetail.transcriptLoading,
    regenerateSummary: noteDetail.regenerateSummary,
    toggleActionItem: noteDetail.toggleActionItem,
    askHistory: noteDetail.askHistory,
    askStatus: noteDetail.askStatus,
    askQuestion: noteDetail.askQuestion,
    llmBusy: noteDetail.llmBusy,
    tDel,
    tMeetingDetection,
    toggleMeetingDetection,
    noteTab,
    sidebarNotes,
    statsLine,
    searchOpen,
    openSearch,
    closeSearch,
    pendingSeek,
    requestSeek,
    clearPendingSeek,
    selectNoteById,
    searchNotes,
    sidebarQuery,
    setSidebarQuery,
    sidebarMatchedIds,
    selectedNoteId,
    recTime: formatMmSs(recElapsed),
    goNotes,
    goSettings,
    goRecording,
    startRec,
    stopRec,
    togglePause,
    setNoteTab,
    setSttModel: modelManager.setSttModel,
    setLlmModel: modelManager.setLlmModel,
    toggleDel,
    downloadModel: modelManager.downloadModel,
    cancelDownload: modelManager.cancelDownload,
    deleteModel: modelManager.deleteModel,
    completeOnboarding,
    renameNote,
    deleteNote,
    revealNote,
    reportError,
  }
}

export type AppState = ReturnType<typeof useAppState>
