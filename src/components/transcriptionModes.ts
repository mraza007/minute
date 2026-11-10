import type { Hardware, ModelStatus, Recommendation } from '../ipc/types'
import { assessModelSuitability, type ModelSuitabilityTone } from '../state/modelSuitability'

export type TranscriptionMode = 'fast' | 'balanced' | 'accurate'

export const TRANSCRIPTION_MODES: readonly TranscriptionMode[] = ['fast', 'balanced', 'accurate']

export const MODE_LABEL: Record<TranscriptionMode, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  accurate: 'Most accurate',
}

/** The speed tier a Whisper model belongs to, read from its name. */
export function transcriptionModeOf(modelName: string): TranscriptionMode {
  const normalized = modelName.toLowerCase()
  if (/\b(tiny|base|small)\b/.test(normalized)) return 'fast'
  if (/\bmedium\b/.test(normalized)) return 'balanced'
  return 'accurate'
}

const FIT_LABEL: Record<ModelSuitabilityTone, string | null> = {
  recommended: 'recommended for this Mac',
  comfortable: 'good fit for this Mac',
  constrained: 'near the memory limit of this Mac',
  unsupported: 'not supported on this Mac',
  unverified: 'from a publisher Minute has not checked',
  unknown: null,
}

export interface TranscriptionModeOption {
  mode: TranscriptionMode
  label: string
  /** The catalog model behind this mode, or `null` if the catalog has none. */
  modelId: string | null
  modelName: string | null
  /** Only an installed model can be chosen. */
  installed: boolean
  selected: boolean
  /** How well the model suits this Mac, or `null` while hardware is unknown. */
  fit: string | null
}

/** One option per mode, in display order, from the transcription models in the catalog. */
export function transcriptionModeOptions(
  models: readonly ModelStatus[],
  selectedModelId: string,
  hardware: Hardware | null,
  recommendation: Recommendation | null,
): TranscriptionModeOption[] {
  const stt = models.filter(model => model.kind === 'stt')
  return TRANSCRIPTION_MODES.map(mode => {
    const candidates = stt.filter(model => transcriptionModeOf(model.displayName) === mode)
    const model =
      candidates.find(candidate => candidate.id === selectedModelId) ??
      candidates.find(candidate => candidate.state === 'installed') ??
      candidates[0] ??
      null
    return {
      mode,
      label: MODE_LABEL[mode],
      modelId: model?.id ?? null,
      modelName: model?.displayName ?? null,
      installed: model?.state === 'installed',
      selected: model !== null && model.id === selectedModelId,
      fit: model ? FIT_LABEL[assessModelSuitability(model, hardware, recommendation).tone] : null,
    }
  })
}
