import { useEffect, useMemo, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import type { Hardware, NoteMeta, StorageStats } from '../ipc/types'
import type { NoteTab, View } from '../types'
import { formatBytes, notesToSidebarItems } from './adapters'
import { useModelManager } from './useModelManager'

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
  const [recSeconds, setRecSeconds] = useState(0)
  const [paused, setPaused] = useState(false)
  const [asked, setAsked] = useState(false)
  const [askDraft, setAskDraft] = useState('')
  const [noteTab, setNoteTab] = useState<NoteTab>('transcript')

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

  // Local recording timer — Task 9 replaces this with the real `elapsed`
  // field off `recording-state` events and drops this interval entirely.
  useEffect(() => {
    if (view !== 'recording' || paused) return
    const t = setInterval(() => setRecSeconds(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [view, paused])

  const sidebarNotes = useMemo(() => notesToSidebarItems(notes, new Date()), [notes])

  const statsLine = useMemo(() => {
    const totalBytes = storage ? storage.modelsBytes + storage.audioBytes + storage.notesBytes : 0
    return `${notes.length} notes · ${formatBytes(totalBytes)} local · nothing synced`
  }, [notes, storage])

  const mm = Math.floor(recSeconds / 60)
  const ss = recSeconds % 60

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
    sel,
    recSeconds,
    paused,
    asked,
    askDraft,
    tDel,
    tEnc,
    noteTab,
    sidebarNotes,
    statsLine,
    recTime: `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`,
    askText: askDraft || 'What did we promise Acme?',
    goNotes: () => setView('notes'),
    goSettings: () => setView('settings'),
    startRec: () => {
      setView('recording')
      setRecSeconds(0)
      setPaused(false)
    },
    stopRec: () => setView('notes'),
    togglePause: () => setPaused(p => !p),
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
