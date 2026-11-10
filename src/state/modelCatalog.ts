import type { CatalogEntry } from '../ipc/types'
import { formatBytes } from './adapters'

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
