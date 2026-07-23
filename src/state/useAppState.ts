import { useEffect, useMemo, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onDownloadDone, onDownloadProgress } from '../ipc/events'
import type { Hardware, ModelStatus, NoteMeta, Recommendation, StorageStats } from '../ipc/types'
import type { NoteTab, View } from '../types'
import { formatBytes, notesToSidebarItems, pickInitialSttModel, type DownloadProgressState } from './adapters'
import { useTauriEvent } from './useTauriEvent'

const LAST_ERROR_TIMEOUT_MS = 5000

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useAppState() {
  const [view, setView] = useState<View>('loading')
  const [models, setModels] = useState<ModelStatus[]>([])
  const [downloads, setDownloads] = useState<Record<string, DownloadProgressState>>({})
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [lastError, setLastErrorState] = useState<string | null>(null)

  // TODO(settings-persistence): once settings.json (a backend task) lands,
  // read the persisted selection here instead of re-deriving it from the
  // recommendation on every launch, and write through set_settings on change.
  const [sttModel, setSttModel] = useState('')

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

  // Initial load: models, notes, hardware, recommendation, and storage stats
  // all come from the backend in one shot. Until this resolves, `view`
  // stays 'loading' — App.tsx renders nothing but a spinner for that state.
  useEffect(() => {
    let cancelled = false
    Promise.all([ipc.listModels(), ipc.listNotes(), ipc.hardwareInfo(), ipc.recommendedModels(), ipc.storageStats()])
      .then(([loadedModels, loadedNotes, loadedHardware, loadedRecommendation, loadedStorage]) => {
        if (cancelled) return
        setModels(loadedModels)
        setNotes(loadedNotes)
        setHardware(loadedHardware)
        setRecommendation(loadedRecommendation)
        setStorage(loadedStorage)
        setSttModel(pickInitialSttModel(loadedModels, loadedRecommendation))
        const hasInstalledStt = loadedModels.some(m => m.kind === 'stt' && m.state === 'installed')
        setView(hasInstalledStt ? 'notes' : 'onboarding')
      })
      .catch(err => {
        if (cancelled) return
        reportError(err)
        // Nothing usable came back — fall through to the (empty) notes
        // view rather than stranding the app on the loading spinner.
        setView('notes')
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Local recording timer — Task 9 replaces this with the real `elapsed`
  // field off `recording-state` events and drops this interval entirely.
  useEffect(() => {
    if (view !== 'recording' || paused) return
    const t = setInterval(() => setRecSeconds(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [view, paused])

  useTauriEvent(
    onDownloadProgress,
    payload => {
      setDownloads(prev => ({ ...prev, [payload.modelId]: { downloaded: payload.downloaded, total: payload.total } }))
    },
    [],
  )

  useTauriEvent(
    onDownloadDone,
    payload => {
      setDownloads(prev => {
        if (!(payload.modelId in prev)) return prev
        const next = { ...prev }
        delete next[payload.modelId]
        return next
      })
      if (!payload.ok && !payload.cancelled) {
        reportError(payload.error ?? `Download failed for ${payload.modelId}`)
      }
      ipc.listModels().then(setModels).catch(reportError)
    },
    [],
  )

  const sidebarNotes = useMemo(() => notesToSidebarItems(notes, new Date()), [notes])

  const statsLine = useMemo(() => {
    const totalBytes = storage ? storage.modelsBytes + storage.audioBytes + storage.notesBytes : 0
    return `${notes.length} notes · ${formatBytes(totalBytes)} local · nothing synced`
  }, [notes, storage])

  const mm = Math.floor(recSeconds / 60)
  const ss = recSeconds % 60

  function downloadModel(id: string) {
    const entry = models.find(m => m.id === id)
    // Optimistic: mark it "downloading" immediately so the card reflects
    // the click right away, ahead of the first (throttled) progress event.
    setDownloads(prev => ({ ...prev, [id]: { downloaded: 0, total: entry?.sizeBytes ?? 0 } }))
    ipc.downloadModel(id).catch(err => {
      reportError(err)
      setDownloads(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    })
  }

  function cancelDownload(id: string) {
    ipc.cancelDownload(id).catch(reportError)
  }

  function deleteModel(id: string) {
    ipc
      .deleteModel(id)
      .then(() => ipc.listModels())
      .then(setModels)
      .catch(reportError)
  }

  return {
    view,
    models,
    downloads,
    notes,
    hardware,
    recommendation,
    storage,
    lastError,
    sttModel,
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
    setSttModel,
    toggleDel: () => setTDel(v => !v),
    toggleEnc: () => setTEnc(v => !v),
    downloadModel,
    cancelDownload,
    deleteModel,
    completeOnboarding: () => setView('notes'),
  }
}

export type AppState = ReturnType<typeof useAppState>
