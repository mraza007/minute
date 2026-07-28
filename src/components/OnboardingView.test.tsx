import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Hardware, ModelStatus, Recommendation } from '../ipc/types'
import { OnboardingView } from './OnboardingView'

const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }

function sttModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    desc: '62× realtime · good for meetings',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: 'a'.repeat(64),
    sizeBytes: 466_000_000,
    minRamGb: 0,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

function llmModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'qwen3.5-4b',
    kind: 'llm',
    displayName: 'Qwen3.5-4B',
    desc: 'fast default summarizer',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    sha256: 'b'.repeat(64),
    sizeBytes: 2_600_000_000,
    minRamGb: 8,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

const base = {
  models: [sttModel(), llmModel()],
  hardware,
  recommendation,
  downloads: {},
  onDownload: vi.fn(),
  onCancel: vi.fn(),
  onStart: vi.fn(),
}

describe('OnboardingView', () => {
  it('exposes the model section as a heading for screen-reader navigation', () => {
    render(<OnboardingView {...base} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Models' })).toBeInTheDocument()
  })

  it('shows the privacy hero and the recommended STT + LLM pair', () => {
    render(<OnboardingView {...base} />)
    expect(screen.getByText('Minute runs entirely on this Mac.')).toBeInTheDocument()
    expect(screen.getByText(/Whisper small/)).toBeInTheDocument()
    expect(screen.getByText(/Qwen3.5-4B/)).toBeInTheDocument()
  })

  it('shows a "not downloaded" sub-line with size for a not-yet-installed model', () => {
    render(<OnboardingView {...base} />)
    expect(screen.getByText('Not downloaded · 466 MB')).toBeInTheDocument()
  })

  it('notes the LLM card is optional and can be added later', () => {
    render(<OnboardingView {...base} />)
    expect(screen.getByText(/add it now or later/i)).toBeInTheDocument()
  })

  it('clicking Download calls onDownload with the model id', () => {
    const onDownload = vi.fn()
    render(<OnboardingView {...base} onDownload={onDownload} />)
    fireEvent.click(screen.getByRole('button', { name: /download \(466 mb\)/i }))
    expect(onDownload).toHaveBeenCalledWith('whisper-small')
  })

  it('renders download progress and a Cancel button while a model is downloading', () => {
    render(
      <OnboardingView
        {...base}
        models={[sttModel({ state: 'downloading' }), llmModel()]}
        downloads={{ 'whisper-small': { downloaded: 233_000_000, total: 466_000_000 } }}
      />,
    )
    expect(screen.getByText('Downloading 50%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('233 MB / 466 MB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('clicking Cancel calls onCancel with the model id', () => {
    const onCancel = vi.fn()
    render(
      <OnboardingView
        {...base}
        onCancel={onCancel}
        models={[sttModel({ state: 'downloading' }), llmModel()]}
        downloads={{ 'whisper-small': { downloaded: 100, total: 200 } }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledWith('whisper-small')
  })

  it('disables "Start using Minute" until an STT model is installed', () => {
    render(<OnboardingView {...base} />)
    expect(screen.getByRole('button', { name: /start using minute/i })).toBeDisabled()
  })

  it('enables "Start using Minute" once an STT model is installed', () => {
    render(<OnboardingView {...base} models={[sttModel({ state: 'installed' }), llmModel()]} />)
    expect(screen.getByRole('button', { name: /start using minute/i })).toBeEnabled()
  })

  it('calls onStart with false when the enabled Start button is clicked without opting in', () => {
    const onStart = vi.fn()
    render(<OnboardingView {...base} models={[sttModel({ state: 'installed' }), llmModel()]} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: /start using minute/i }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(false)
  })

  it('shows an in-use sub-line once the recommended STT model is installed', () => {
    render(<OnboardingView {...base} models={[sttModel({ state: 'installed' }), llmModel()]} />)
    expect(screen.getByText('Installed · in use')).toBeInTheDocument()
  })

  it('shows the meeting detection opt-in row unchecked by default', () => {
    render(<OnboardingView {...base} />)
    const toggle = screen.getByRole('switch', { name: /offer to record when a meeting starts/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('checking the opt-in row then starting calls onStart with true', () => {
    const onStart = vi.fn()
    render(<OnboardingView {...base} models={[sttModel({ state: 'installed' }), llmModel()]} onStart={onStart} />)

    fireEvent.click(screen.getByRole('switch', { name: /offer to record when a meeting starts/i }))
    fireEvent.click(screen.getByRole('button', { name: /start using minute/i }))

    expect(onStart).toHaveBeenCalledWith(true)
  })
})
