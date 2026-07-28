import type { Hardware } from '../ipc/types'
import type { ModelSuitabilityResult } from '../state/modelSuitability'

export function ModelSuitabilityLine({ result }: { result: ModelSuitabilityResult }) {
  return (
    <span className="model-suitability" data-tone={result.tone}>
      <span className="model-suitability-dot" aria-hidden="true" />
      <strong>{result.label}</strong>
      <span>{result.detail}</span>
    </span>
  )
}

export function HardwareSummary({ hardware }: { hardware: Hardware | null }) {
  const specs = hardware
    ? `${hardware.appleSilicon ? 'Apple silicon' : 'Intel'} · ${hardware.totalRamGb} GB memory · ${hardware.cores} CPU cores`
    : 'Checking hardware…'

  return (
    <section className="hardware-summary" aria-label="Detected Mac hardware">
      <span className="mlab">This Mac</span>
      {hardware ? (
        <>
          <p className="hardware-summary-specs" aria-label={specs}>{specs}</p>
          <p className="hardware-summary-detail">Recommendations use memory and processor compatibility. They are guidance, not benchmark results.</p>
        </>
      ) : (
        <>
          <p className="hardware-summary-specs" aria-label={specs}>{specs}</p>
          <p className="hardware-summary-detail">Model compatibility will appear when detection finishes.</p>
        </>
      )}
    </section>
  )
}
