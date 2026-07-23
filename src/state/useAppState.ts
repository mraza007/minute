import { useEffect, useMemo, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onRecordingState, onSttStatus, onTranscriptSegment } from '../ipc/events'
import type { Hardware, NoteMeta, StorageStats, TranscriptSegmentEvent } from '../ipc/types'
import type { NoteTab, SttStatus, View } from '../types'
import { formatBytes, formatMmSs, groupLiveSegments, modelDisplayName, notesToSidebarItems } from './adapters'
import { useModelManager } from './useModelManager'
import { useTauriEvent } from './useTauriEvent'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const LAST_ERROR_TIMEOUT_MS = 5000

export function useAppState() {
  const [view, setView] = useState<View>('loading')
  const [loaded, setLoaded] = useState(false)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [lastError, setLastErrorState] = useState<string | null>(null)

  const [sel, setSel] = useState(0)
  const [asked, setAsked] = useState(false)
  const [askDraft, setAskDraft] = useState('')
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

  // TODO: not yet persisted — settings.json is a backend task (see the
  // design doc's storage shapes); local-only until then.
  const [tDel, setTDel] = useState(true)
  const [tEnc, setTEnc] = useState(false)

  const errorTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  function reportError(err: unknown) {
    clearTimeout(errorTimeout.current)
    setLastErrorState(messageOf(err))
    errorTimeout.current = setTimeout(() => setLastErrorState(null), LAST_ERROR_TIMEOUT_MS)
  }

  useEffect(() => () => clearTimeout(errorTimeout.current), [])

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
    Promise.all([ipc.listModels(), ipc.listNotes(), ipc.hardwareInfo(), ipc.recommendedModels(), ipc.storageStats()])
      .then(([loadedModels, loadedNotes, loadedHardware, loadedRecommendation, loadedStorage]) => {
        if (cancelled) return
        modelManager.applyInitialLoad(loadedModels, loadedRecommendation)
        setNotes(loadedNotes)
        setHardware(loadedHardware)
        setStorage(loadedStorage)
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

  /** Starts a new recording with the currently selected STT model. */
  function startRec() {
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
  }

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
   */
  function togglePause() {
    if (pauseInFlight.current) return
    pauseInFlight.current = true
    const nextPaused = !paused
    setPaused(nextPaused)
    const action = nextPaused ? ipc.pauseRecording() : ipc.resumeRecording()
    action.catch(reportError).finally(() => {
      pauseInFlight.current = false
    })
  }

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
   */
  function stopRec() {
    setStopping(true)
    ipc
      .stopRecording()
      .then(newNote =>
        Promise.all([ipc.listNotes(), ipc.storageStats()]).then(([freshNotes, freshStorage]) => {
          setNotes(freshNotes)
          setStorage(freshStorage)
          const idx = freshNotes.findIndex(n => n.id === newNote.id)
          setSel(idx >= 0 ? idx : 0)
          setView('notes')
          setActiveNoteId(null)
          setLiveSegmentsRaw([])
          setSttStatus('idle')
          setSttError(null)
          setSttStatusNoteId(null)
          setStopping(false)
        }),
      )
      .catch(err => {
        setStopping(false)
        reportError(err)
      })
  }

  return {
    view,
    models: modelManager.models,
    downloads: modelManager.downloads,
    notes,
    hardware,
    recommendation: modelManager.recommendation,
    storage,
    lastError: lastError ?? modelManager.lastError,
    sttModel: modelManager.sttModel,
    sttModelDisplayName,
    sel,
    recElapsed,
    paused,
    stopping,
    sttStatus,
    sttError,
    sttStatusNoteId,
    liveSegments,
    asked,
    askDraft,
    tDel,
    tEnc,
    noteTab,
    sidebarNotes,
    statsLine,
    recTime: formatMmSs(recElapsed),
    askText: askDraft || 'What did we promise Acme?',
    goNotes: () => setView('notes'),
    goSettings: () => setView('settings'),
    startRec,
    stopRec,
    togglePause,
    selectNote: setSel,
    setNoteTab,
    setAskDraft,
    ask: () => setAsked(true),
    setSttModel: modelManager.setSttModel,
    toggleDel: () => setTDel(v => !v),
    toggleEnc: () => setTEnc(v => !v),
    downloadModel: modelManager.downloadModel,
    cancelDownload: modelManager.cancelDownload,
    deleteModel: modelManager.deleteModel,
    completeOnboarding: () => setView('notes'),
  }
}

export type AppState = ReturnType<typeof useAppState>
