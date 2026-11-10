import type { Hardware } from '../ipc/types'
import { hardwareSpecs, type ModelSuitabilityResult } from '../state/modelSuitability'

/** The short fit label beside a model. The detail stays available to screen readers and as a tooltip. */
export function ModelFit({ result }: { result: ModelSuitabilityResult }) {
  return (
    <span className="st-fit" data-tone={result.tone} title={result.detail}>
      {result.label}
      <span className="visually-hidden">. {result.detail}</span>
    </span>
  )
}

export function HardwareSummary({ hardware }: { hardware: Hardware | null }) {
  return (
    <section className="st-hardware" aria-label="Detected Mac hardware">
      This Mac: {hardwareSpecs(hardware)}. Models download once and run offline.
      {!hardware && ' Compatibility will appear when detection finishes.'}
    </section>
  )
}
