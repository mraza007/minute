import { render, screen } from '@testing-library/react'
import type { Hardware, ModelStatus, Recommendation } from '../ipc/types'
import { assessModelSuitability } from '../state/modelSuitability'
import { HardwareSummary, ModelSuitabilityLine } from './ModelSuitability'

const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-medium', llm: 'qwen3.5-4b' }

function model(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-medium',
    kind: 'stt',
    displayName: 'Whisper medium',
    desc: 'Better accents and jargon',
    url: 'https://example.com/model.bin',
    sha256: 'a'.repeat(64),
    sizeBytes: 1_500_000_000,
    minRamGb: 16,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

describe('model suitability', () => {
  it('uses the backend recommendation as the best-fit signal', () => {
    expect(assessModelSuitability(model(), hardware, recommendation)).toEqual({
      tone: 'recommended',
      label: 'Recommended',
      detail: 'Minute’s default for this 16 GB Mac.',
    })
  })

  it('reports insufficient memory without pretending to benchmark speed', () => {
    expect(assessModelSuitability(model({ minRamGb: 24 }), hardware, recommendation)).toMatchObject({
      tone: 'unsupported',
      label: 'Below minimum',
      detail: 'Needs 24 GB memory; this Mac has 16 GB.',
    })
  })

  it('reports an Apple-silicon-only model as unsupported on Intel', () => {
    expect(
      assessModelSuitability(
        model({ requiresAppleSilicon: true }),
        { ...hardware, appleSilicon: false },
        recommendation,
      ),
    ).toMatchObject({
      tone: 'unsupported',
      label: 'Not supported',
    })
  })

  it('distinguishes comfortable headroom from meeting the minimum', () => {
    expect(
      assessModelSuitability(model({ id: 'whisper-small', minRamGb: 8 }), hardware, recommendation),
    ).toMatchObject({ tone: 'comfortable', label: 'Good fit' })
    expect(
      assessModelSuitability(model({ id: 'whisper-large', minRamGb: 16 }), hardware, recommendation),
    ).toMatchObject({ tone: 'constrained', label: 'Near memory limit' })
  })

  it('renders text labels and detected hardware so meaning never depends on color', () => {
    const result = assessModelSuitability(model(), hardware, recommendation)
    render(
      <>
        <HardwareSummary hardware={hardware} />
        <ModelSuitabilityLine result={result} />
      </>,
    )
    expect(screen.getByRole('region', { name: 'Detected Mac hardware' })).toHaveTextContent(
      'Apple silicon · 16 GB memory · 8 CPU cores',
    )
    expect(screen.getByText('Recommended')).toBeInTheDocument()
  })
})
