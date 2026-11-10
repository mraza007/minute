import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ipc from '../ipc/commands'
import { onDownloadDone, onDownloadProgress } from '../ipc/events'
import type { BrowseKind, ModelBrowse, ModelStatus, Recommendation, Settings } from '../ipc/types'
import type { View } from '../types'
import { pickInitialLlmModel, pickInitialSttModel, type DownloadProgressState } from './adapters'
import { useTauriEvent } from './useTauriEvent'
import { DEFAULT_OBSIDIAN_SETTINGS } from './obsidian'

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
  obsidian: DEFAULT_OBSIDIAN_SETTINGS,
}

const LAST_ERROR_TIMEOUT_MS = 5000
const SEARCH_DEBOUNCE_MS = 300

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** One kind's Hugging Face listing on the Models page. */
export interface BrowseState {
  /** The last answer, kept on screen while a newer request runs. `null` until the first answer. */
  result: ModelBrowse | null
  loading: boolean
  /** The search field's text. Blank lists the trusted publishers' models. */
  query: string
}

const NOT_BROWSED: BrowseState = { result: null, loading: false, query: '' }

/** Hugging Face browsing. Nothing here contacts Hugging Face until the Models page calls `open`. */
export interface HuggingFaceBrowse {
  state: Record<BrowseKind, BrowseState>
  /** Files from both kinds' answers, plus downloads started from an answer that a newer search replaced. */
  models: ModelStatus[]
  /** Fetches both kinds. The Models page calls it when it opens. */
  open: () => void
  /** Sets the search text and fetches once typing pauses. */
  setQuery: (kind: BrowseKind, query: string) => void
  /** Fetches the current search text now (Enter). */
  search: (kind: BrowseKind) => void
  /** Fetches again past the backend's cache. */
  refresh: (kind: BrowseKind) => void
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
 * transcription model, Hugging Face browsing, and the download/cancel/delete actions — split out
 * of useAppState so that hook stays reviewable once Task 9 layers
 * recording events on top of it.
 *
 * Also re-gates: if the selected (or the only) installed STT model gets
 * removed out from under the user — e.g. deleted from Settings — this
 * bounces the view back to onboarding and reassigns `sttModel` (and
 * `llmModel`) off the now-uninstalled pick, via the same `pickInitial*`
 * rules used on initial load. One-directional: it only ever forces *into*
 * onboarding, never out of it — "Open Minute" is what clears the gate.
 */
export function useModelManager({ view, setView, loaded }: UseModelManagerOptions) {
  const [models, setModels] = useState<ModelStatus[]>([])
  const [downloads, setDownloads] = useState<Record<string, DownloadProgressState>>({})
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [sttModel, setSttModelState] = useState('')
  const [llmModel, setLlmModelState] = useState<string | null>(null)
  const [lastError, setLastErrorState] = useState<string | null>(null)
  const [browseState, setBrowseState] = useState<Record<BrowseKind, BrowseState>>({ stt: NOT_BROWSED, llm: NOT_BROWSED })
  // Hugging Face files mid-download, so a new search cannot hide their progress and Cancel.
  const [inFlight, setInFlight] = useState<Record<string, ModelStatus>>({})

  const errorTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  const browseRequest = useRef<Record<BrowseKind, number>>({ stt: 0, llm: 0 })
  const browseQuery = useRef<Record<BrowseKind, string>>({ stt: '', llm: '' })
  const searchTimer = useRef<Record<BrowseKind, ReturnType<typeof setTimeout> | undefined>>({ stt: undefined, llm: undefined })

  // Stable identity (only refs/setters in its closure) — same rationale as
  // useAppState's own `reportError`: everything below that depends on it via
  // `useCallback` needs *this* to be stable too, or their own memoization is
  // a no-op (a fresh `[reportError]` dep every render still busts the cache).
  const reportError = useCallback((err: unknown) => {
    clearTimeout(errorTimeout.current)
    setLastErrorState(messageOf(err))
    errorTimeout.current = setTimeout(() => setLastErrorState(null), LAST_ERROR_TIMEOUT_MS)
  }, [])

  useEffect(
    () => () => {
      clearTimeout(errorTimeout.current)
      clearTimeout(searchTimer.current.stt)
      clearTimeout(searchTimer.current.llm)
    },
    [],
  )

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
      setDownloads(prev => withoutKey(prev, payload.modelId))
      if (!payload.ok && !payload.cancelled) {
        reportError(payload.error ?? `Download failed for ${payload.modelId}`)
      }
      // Dropped only after the refetch, so a finished file never vanishes
      // between leaving the browse list and joining "On this Mac".
      ipc
        .listModels()
        .then(setModels)
        .catch(reportError)
        .finally(() => setInFlight(prev => withoutKey(prev, payload.modelId)))
    },
    [],
  )

  // `view`/`setView`/`sttModel`/`llmModel`/`recommendation` read through a ref so the
  // effect below triggers *only* off genuine `models` changes (a download
  // finishing, a delete's refetch, ...) — not off `view` changing for
  // unrelated reasons (e.g. the user clicking "Open Minute", or the
  // initial-load error fallback setting `view` to 'notes' with nothing
  // installed). Those are legitimate view transitions this effect must not
  // immediately re-fight; re-gating is specifically about the model catalog
  // changing out from under an already-settled view, not about reacting to
  // the view itself moving.
  const latest = useRef({ view, setView, sttModel, llmModel, recommendation, loaded })
  latest.current = { view, setView, sttModel, llmModel, recommendation, loaded }

  // Re-gate onboarding + reassign the selection whenever `models` changes:
  // forces the view to 'onboarding' if no STT model is installed anymore,
  // and reassigns `sttModel`/`llmModel` when the selected id is no longer an
  // installed model. A removed Hugging Face model drops out of `models`
  // entirely, so a missing id counts too. One-directional — never
  // auto-clears onboarding.
  useEffect(() => {
    const { view, setView, sttModel, llmModel, recommendation, loaded } = latest.current
    if (!loaded) return

    const hasInstalledStt = models.some(m => m.kind === 'stt' && m.state === 'installed')
    if (!hasInstalledStt && view !== 'onboarding') {
      setView('onboarding')
    }

    if (recommendation) {
      const isInstalled = (id: string) => models.some(m => m.id === id && m.state === 'installed')
      if (!isInstalled(sttModel)) {
        setSttModelState(pickInitialSttModel(models, recommendation))
      }
      if (llmModel !== null && !isInstalled(llmModel)) {
        setLlmModelState(pickInitialLlmModel(models, recommendation))
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

  const browsedModels = useMemo(
    () => [...(browseState.stt.result?.entries ?? []), ...(browseState.llm.result?.entries ?? []), ...Object.values(inFlight)],
    [browseState, inFlight],
  )

  const fetchBrowse = useCallback((kind: BrowseKind, refresh: boolean) => {
    clearTimeout(searchTimer.current[kind])
    browseRequest.current[kind] += 1
    const request = browseRequest.current[kind]
    const query = browseQuery.current[kind].trim()
    setBrowseState(prev => ({ ...prev, [kind]: { ...prev[kind], loading: true } }))
    ipc
      .browseModels(kind, query === '' ? null : query, refresh)
      .catch((err): ModelBrowse => ({ entries: [], fetchedAt: null, unsupportedCount: 0, error: messageOf(err) }))
      .then(result => {
        // A slow answer to an older search must not replace a newer one.
        if (request !== browseRequest.current[kind]) return
        setBrowseState(prev => ({ ...prev, [kind]: { ...prev[kind], result, loading: false } }))
      })
  }, [])

  const openBrowse = useCallback(() => {
    fetchBrowse('stt', false)
    fetchBrowse('llm', false)
  }, [fetchBrowse])

  const setBrowseQuery = useCallback(
    (kind: BrowseKind, query: string) => {
      browseQuery.current[kind] = query
      setBrowseState(prev => ({ ...prev, [kind]: { ...prev[kind], query } }))
      clearTimeout(searchTimer.current[kind])
      searchTimer.current[kind] = setTimeout(() => fetchBrowse(kind, false), SEARCH_DEBOUNCE_MS)
    },
    [fetchBrowse],
  )

  const searchNow = useCallback((kind: BrowseKind) => fetchBrowse(kind, false), [fetchBrowse])
  const refreshBrowse = useCallback((kind: BrowseKind) => fetchBrowse(kind, true), [fetchBrowse])

  const huggingFace = useMemo<HuggingFaceBrowse>(
    () => ({ state: browseState, models: browsedModels, open: openBrowse, setQuery: setBrowseQuery, search: searchNow, refresh: refreshBrowse }),
    [browseState, browsedModels, openBrowse, setBrowseQuery, searchNow, refreshBrowse],
  )

  const downloadModel = useCallback(
    (id: string, allowUnknownPublisher = false) => {
      const entry = models.find(m => m.id === id) ?? browsedModels.find(m => m.id === id)
      // Optimistic: mark it "downloading" immediately so the card reflects
      // the click right away, ahead of the first (throttled) progress event.
      setDownloads(prev => ({ ...prev, [id]: { downloaded: 0, total: entry?.sizeBytes ?? 0 } }))
      if (entry?.origin.kind === 'huggingFace') setInFlight(prev => ({ ...prev, [id]: entry }))
      ipc.downloadModel(id, allowUnknownPublisher).catch(err => {
        reportError(err)
        setDownloads(prev => withoutKey(prev, id))
        setInFlight(prev => withoutKey(prev, id))
      })
    },
    [models, browsedModels, reportError],
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
    huggingFace,
    downloadModel,
    cancelDownload,
    deleteModel,
    applyInitialLoad,
  }
}

export type ModelManager = ReturnType<typeof useModelManager>
