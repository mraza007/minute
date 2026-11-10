import type { Hardware, ModelStatus, Recommendation } from '../ipc/types'

export type ModelSuitabilityTone =
  | 'recommended'
  | 'comfortable'
  | 'constrained'
  | 'unsupported'
  | 'unverified'
  | 'unknown'

export interface ModelSuitabilityResult {
  tone: ModelSuitabilityTone
  label: string
  detail: string
}

function recommendedId(entry: ModelStatus, recommendation: Recommendation | null): string | null {
  if (!recommendation) return null
  return entry.kind === 'stt' ? recommendation.stt : recommendation.llm
}

/**
 * Honest compatibility guidance derived only from facts the native catalog
 * already knows: memory, architecture, and the backend-selected default.
 * It deliberately avoids made-up speed scores—the app has not benchmarked
 * this exact Mac.
 */
export function assessModelSuitability(
  entry: ModelStatus,
  hardware: Hardware | null,
  recommendation: Recommendation | null,
): ModelSuitabilityResult {
  if (!hardware) {
    return {
      tone: 'unknown',
      label: 'Checking this Mac',
      detail: 'Hardware details are not available yet.',
    }
  }

  if (entry.requiresAppleSilicon && !hardware.appleSilicon) {
    return {
      tone: 'unsupported',
      label: 'Not supported',
      detail: 'Requires Apple silicon; this is an Intel Mac.',
    }
  }

  if (hardware.totalRamGb < entry.minRamGb) {
    return {
      tone: 'unsupported',
      label: 'Below minimum',
      detail: `Needs ${entry.minRamGb} GB memory; this Mac has ${hardware.totalRamGb} GB.`,
    }
  }

  // Trust outranks memory fit until the file is on this Mac: the user has to
  // decide about the publisher before the download, not after.
  if (entry.origin.kind === 'huggingFace' && !entry.origin.trusted && entry.state !== 'installed') {
    return {
      tone: 'unverified',
      label: 'Unknown publisher',
      detail: `Minute has not checked files from ${entry.origin.publisher}.`,
    }
  }

  if (entry.id === recommendedId(entry, recommendation)) {
    return {
      tone: 'recommended',
      label: 'Recommended',
      detail: `Minute’s default for this ${hardware.totalRamGb} GB Mac.`,
    }
  }

  const memoryHeadroomGb = hardware.totalRamGb - entry.minRamGb
  if (entry.minRamGb === 0 || memoryHeadroomGb >= 8) {
    return {
      tone: 'comfortable',
      label: 'Good fit',
      detail: `Fits comfortably in ${hardware.totalRamGb} GB memory.`,
    }
  }

  return {
    tone: 'constrained',
    label: 'Near memory limit',
    detail: `Meets the ${entry.minRamGb} GB minimum; close other memory-heavy apps.`,
  }
}

/** "Apple silicon · 16 GB memory · 8 CPU cores", or a placeholder until detection finishes. */
export function hardwareSpecs(hardware: Hardware | null): string {
  return hardware
    ? `${hardware.appleSilicon ? 'Apple silicon' : 'Intel'} · ${hardware.totalRamGb} GB memory · ${hardware.cores} CPU cores`
    : 'Checking hardware…'
}
