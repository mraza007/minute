import { useCallback, useEffect, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onDownloadDone, onDownloadProgress } from '../ipc/events'
import type { ModelStatus, Recommendation, Settings } from '../ipc/types'
import type { View } from '../types'
import { pickInitialLlmModel, pickInitialSttModel, type DownloadProgressState } from './adapters'
import { useTauriEvent } from './useTauriEvent'

/** Used when `applyInitialLoad` is called without a real settings fixture (only ever happens in tests that don't care about settings-derived initial selections). */
const DEFAULT_SETTINGS: Settings = {
  sttModel: null,
  llmModel: null,
  deleteAudioAfter30d: true,
  meetingDetection: false,
  captureSystemAudio: false,
  libraryRoot: null,
  llmContextTokens: null,
  summaryStyle: 'standard',
  summaryInstructions: '',
  autoUpdateCheck: true,
  detectSpeakers: false,
  autoStopRecording: true,
  compressAudioAfterDays: null,
  speakerProfiles: false,
  autoApplySpeakerNames: true,
}

const LAST_ERROR_TIMEOUT_MS = 5000

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface UseModelManagerOptions {
  /** Current app view — read so the re-gate effect can tell it's already onboarding. */
  view: View
  setView: (v: View) => void
  /**
   * True once useAppState's initial IPC load has resolved and seeded this
   * hook via `applyInitialLoad`. Re-gating is gated on this too, so it
   * can't fire off the empty `models = []` this hook starts with before
   * the first load lands.
   */
  loaded: boolean
}

/**
 * Owns the model catalog: install state, in-flight downloads, the selected
 * transcription model, and the download/cancel/delete actions — split out
 * of useAppState so that hook stays reviewable once Task 9 layers
 * recording events on top of it.
 *
 * Also re-gates: if the selected (or the only) installed STT model gets
 * removed out from under the user — e.g. deleted from Settings — this
 * bounces the view back to onboarding and reassigns `sttModel` off the
 * now-uninstalled pick, via the same `pickInitialSttModel` rule used on
 * initial load. One-directional: it only ever forces *into* onboarding,
 * never out of it — "Start using Minute" is what clears the gate.
 */
export function useModelManager({ view, setView, loaded }: UseModelManagerOptions) {
  const [models, setModels] = useState<ModelStatus[]>([])
  const [downloads, setDownloads] = useState<Record<string, DownloadProgressState>>({})
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [sttModel, setSttModelState] = useState('')
  const [llmModel, setLlmModelState] = useState<string | null>(null)
  const [lastError, setLastErrorState] = useState<string | null>(null)

  const errorTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Stable identity (only refs/setters in its closure) — same rationale as
  // useAppState's own `reportError`: everything below that depends on it via
  // `useCallback` needs *this* to be stable too, or their own memoization is
  // a no-op (a fresh `[reportError]` dep every render still busts the cache).
  const reportError = useCallback((err: unknown) => {
    clearTimeout(errorTimeout.current)
    setLastErrorState(messageOf(err))
    errorTimeout.current = setTimeout(() => setLastErrorState(null), LAST_ERROR_TIMEOUT_MS)
  }, [])

  useEffect(() => () => clearTimeout(errorTimeout.current), [])

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

  // `view`/`setView`/`sttModel`/`recommendation` read through a ref so the
  // effect below triggers *only* off genuine `models` changes (a download
  // finishing, a delete's refetch, ...) — not off `view` changing for
  // unrelated reasons (e.g. the user clicking "Start using Minute", or the
  // initial-load error fallback setting `view` to 'notes' with nothing
  // installed). Those are legitimate view transitions this effect must not
  // immediately re-fight; re-gating is specifically about the model catalog
  // changing out from under an already-settled view, not about reacting to
  // the view itself moving.
  const latest = useRef({ view, setView, sttModel, recommendation, loaded })
  latest.current = { view, setView, sttModel, recommendation, loaded }

  // Re-gate onboarding + reassign the selection whenever `models` changes:
  // forces the view to 'onboarding' if no STT model is installed anymore,
  // and reassigns `sttModel` if the currently-selected entry is no longer
  // installed. One-directional — never auto-clears onboarding.
  useEffect(() => {
    const { view, setView, sttModel, recommendation, loaded } = latest.current
    if (!loaded) return

    const hasInstalledStt = models.some(m => m.kind === 'stt' && m.state === 'installed')
    if (!hasInstalledStt && view !== 'onboarding') {
      setView('onboarding')
    }

    if (recommendation) {
      const selected = models.find(m => m.id === sttModel)
      if (selected && selected.state !== 'installed') {
        setSttModelState(pickInitialSttModel(models, recommendation))
      }
    }
    // Deliberately depends on `models` only — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  /** Seeds this hook from useAppState's initial combined IPC load. */
  function applyInitialLoad(loadedModels: ModelStatus[], loadedRecommendation: Recommendation, settings: Settings = DEFAULT_SETTINGS) {
    setModels(loadedModels)
    setRecommendation(loadedRecommendation)
    setSttModelState(pickInitialSttModel(loadedModels, loadedRecommendation, settings.sttModel))
    setLlmModelState(pickInitialLlmModel(loadedModels, loadedRecommendation, settings.llmModel))
  }

  /** Sets the selected transcription model and persists it to settings.json (fire-and-forget — a failed persist just gets reported, the in-memory selection still applies). */
  const setSttModel = useCallback(
    (id: string) => {
      setSttModelState(id)
      ipc.setSettings({ sttModel: id }).catch(reportError)
    },
    [reportError],
  )

  /** Sets the selected summary (LLM) model and persists it to settings.json — same fire-and-forget shape as `setSttModel`. */
  const setLlmModel = useCallback(
    (id: string) => {
      setLlmModelState(id)
      ipc.setSettings({ llmModel: id }).catch(reportError)
    },
    [reportError],
  )

  const downloadModel = useCallback(
    (id: string) => {
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
    },
    [models, reportError],
  )

  const cancelDownload = useCallback(
    (id: string) => {
      ipc.cancelDownload(id).catch(reportError)
    },
    [reportError],
  )

  const deleteModel = useCallback(
    (id: string) => {
      ipc
        .deleteModel(id)
        .then(() => ipc.listModels())
        .then(setModels)
        .catch(reportError)
    },
    [reportError],
  )

  return {
    models,
    downloads,
    recommendation,
    sttModel,
    setSttModel,
    llmModel,
    setLlmModel,
    lastError,
    downloadModel,
    cancelDownload,
    deleteModel,
    applyInitialLoad,
  }
}

export type ModelManager = ReturnType<typeof useModelManager>
