import type { BrowseKind, CatalogEntry, Hardware, ModelStatus, Recommendation } from '../ipc/types'
import { formatBytes, type DownloadProgressState } from './adapters'
import { assessModelSuitability, type ModelSuitabilityResult } from './modelSuitability'

/** One model as a row on the Models page. */
export interface CatalogRow {
  model: ModelStatus
  /** A live download wins over `model.state`, which only refreshes when it ends. */
  status: 'installed' | 'downloading' | 'available'
  progress: DownloadProgressState | null
  selected: boolean
  fit: ModelSuitabilityResult
  detail: string
  /** Set for a Hugging Face file, not yet downloaded, from a publisher Minute has not checked: Download asks first. */
  unknownPublisher: string | null
  /** A Hugging Face file `list_models` returns: Minute keeps it from the moment its download starts, so a cancelled or failed one can be removed. */
  saved: boolean
}

/** One kind's models, split the way the Models page shows them. */
export interface CatalogGroup {
  /** Downloaded, so selectable. In `list_models` order. */
  onThisMac: CatalogRow[]
  /** Built-in tested models that are not downloaded. */
  tested: CatalogRow[]
  /** Hugging Face files that are not downloaded: trusted publishers first, then newest first. */
  huggingFace: CatalogRow[]
  /** Not downloaded and needing more memory than this Mac has, folded away by default. */
  tooLarge: CatalogRow[]
}

export interface CatalogInput {
  /** `list_models`: every tested model plus downloaded Hugging Face models. */
  listed: ModelStatus[]
  /** Hugging Face files from `browse_models` answers and downloads still running. */
  browsed: ModelStatus[]
  hardware: Hardware | null
  recommendation: Recommendation | null
  downloads: Record<string, DownloadProgressState>
  selected: Record<BrowseKind, string | null>
  now: Date
}

function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
}

/** A raw parameter count as a model card writes it: "350M", "3.1B", "70B". */
export function formatParameters(count: number): string {
  if (count >= 1e9) {
    const billions = count / 1e9
    return `${billions >= 10 ? Math.round(billions) : oneDecimal(billions)}B`
  }
  return `${Math.round(count / 1e6)}M`
}

/** "Oct 2", with the year only when it is not this year. Null for a date that does not parse. */
export function formatShortDate(iso: string, now: Date): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const options: Intl.DateTimeFormatOptions =
    date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }
  return date.toLocaleDateString('en-US', options)
}

/** How old a fetched list is: "just now", "12 min ago", "2 h ago", "3 d ago". Null for a time that does not parse. */
export function formatAge(iso: string, now: Date): string | null {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return null
  const minutes = Math.floor(Math.max(0, now.getTime() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/**
 * The line under a model's name. A model with editorial traits shows them and
 * its size: "Most accurate · 99 languages · 1.6 GB". A Hugging Face file
 * without traits shows the facts Minute read from the repo instead:
 * "ibm-granite · 7B · Q4_K_M · 4.2 GB · Oct 2".
 */
export function modelDetail(entry: CatalogEntry, now: Date = new Date()): string {
  const size = formatBytes(entry.sizeBytes)
  if (entry.traits.length > 0 || entry.origin.kind === 'tested') return [...entry.traits, size].join(' · ')
  const { publisher, parameters, quantization, updatedAt } = entry.origin
  return [
    publisher,
    parameters === null ? null : formatParameters(parameters),
    quantization,
    size,
    updatedAt === null ? null : formatShortDate(updatedAt, now),
  ]
    .filter(part => part !== null && part !== '')
    .join(' · ')
}

function isBrowseKind(kind: ModelStatus['kind']): kind is BrowseKind {
  return kind === 'stt' || kind === 'llm'
}

function isTrusted(model: ModelStatus): boolean {
  return model.origin.kind === 'tested' || model.origin.trusted
}

function updatedTime(model: ModelStatus): number {
  const time = model.origin.kind === 'huggingFace' && model.origin.updatedAt ? Date.parse(model.origin.updatedAt) : NaN
  return Number.isNaN(time) ? 0 : time
}

function trustedThenNewest(a: ModelStatus, b: ModelStatus): number {
  return Number(isTrusted(b)) - Number(isTrusted(a)) || updatedTime(b) - updatedTime(a)
}

/**
 * Sorts every stt and llm model into the subgroups the Models page renders.
 * A browsed file that `list_models` also returns shows once, from `listed`:
 * a browse answer can predate the download that installed it.
 */
export function buildModelCatalog({ listed, browsed, hardware, recommendation, downloads, selected, now }: CatalogInput): Record<BrowseKind, CatalogGroup> {
  const groups: Record<BrowseKind, CatalogGroup> = {
    stt: { onThisMac: [], tested: [], huggingFace: [], tooLarge: [] },
    llm: { onThisMac: [], tested: [], huggingFace: [], tooLarge: [] },
  }
  const saved = new Set(listed.filter(model => model.origin.kind === 'huggingFace').map(model => model.id))
  const shown = new Set(listed.map(model => model.id))
  const fresh: ModelStatus[] = []
  for (const model of browsed) {
    if (shown.has(model.id)) continue
    shown.add(model.id)
    fresh.push(model)
  }

  for (const model of [...listed, ...fresh.sort(trustedThenNewest)]) {
    if (!isBrowseKind(model.kind)) continue
    const progress = downloads[model.id] ?? null
    const status = progress ? 'downloading' : model.state === 'installed' ? 'installed' : 'available'
    const row: CatalogRow = {
      model,
      status,
      progress,
      selected: selected[model.kind] === model.id,
      fit: assessModelSuitability(model, hardware, recommendation),
      detail: modelDetail(model, now),
      unknownPublisher: model.origin.kind === 'huggingFace' && !model.origin.trusted && status !== 'installed' ? model.origin.publisher : null,
      saved: saved.has(model.id),
    }
    const group = groups[model.kind]
    if (status === 'installed') group.onThisMac.push(row)
    else if (status === 'available' && hardware !== null && hardware.totalRamGb < model.minRamGb) group.tooLarge.push(row)
    else if (model.origin.kind === 'tested') group.tested.push(row)
    else group.huggingFace.push(row)
  }
  return groups
}
