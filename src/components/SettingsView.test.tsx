import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelStatus, StorageStats } from '../ipc/types'
import { SettingsView } from './SettingsView'

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

const models: ModelStatus[] = [
  sttModel({ id: 'whisper-small', state: 'installed' }),
  sttModel({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'notInstalled', sizeBytes: 1_500_000_000 }),
  sttModel({ id: 'whisper-large-v3-turbo', displayName: 'Whisper large-v3-turbo', state: 'downloading' }),
  llmModel({ id: 'qwen3.5-4b', state: 'installed' }),
  llmModel({ id: 'gemma-4-e4b', displayName: 'Gemma 4 E4B', state: 'notInstalled', sizeBytes: 5_300_000_000 }),
  llmModel({ id: 'qwen3.5-9b', displayName: 'Qwen3.5-9B', state: 'notInstalled', sizeBytes: 5_600_000_000 }),
]

const storage: StorageStats = { modelsBytes: 6_400_000_000, audioBytes: 4_100_000_000, notesBytes: 1_900_000_000 }

const base = {
  models,
  downloads: { 'whisper-large-v3-turbo': { downloaded: 800_000_000, total: 1_600_000_000 } },
  sttModel: 'whisper-small',
  setSttModel: vi.fn(),
  llmModel: 'qwen3.5-4b',
  setLlmModel: vi.fn(),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  deleteModel: vi.fn(),
  storage,
  noteCount: 14,
  tDel: true,
  toggleDel: vi.fn(),
  tEnc: false,
  toggleEnc: vi.fn(),
}

describe('SettingsView', () => {
  afterEach(() => vi.useRealTimers())

  it('shows the privacy hero text', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Nothing leaves this machine.')).toBeInTheDocument()
  })

  it('groups the transcription models under a radiogroup with one radio per STT entry', () => {
    render(<SettingsView {...base} />)
    const group = screen.getByRole('radiogroup', { name: /transcription model/i })
    expect(group).toBeInTheDocument()
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
  })

  it('calls setSttModel when clicking an installed, not-currently-selected model', () => {
    const setSttModel = vi.fn()
    const installedModels: ModelStatus[] = [
      sttModel({ id: 'whisper-small', state: 'installed' }),
      sttModel({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'installed' }),
    ]
    render(<SettingsView {...base} models={installedModels} setSttModel={setSttModel} />)
    fireEvent.click(screen.getByRole('radio', { name: /whisper medium/i }))
    expect(setSttModel).toHaveBeenCalledWith('whisper-medium')
  })

  it('does not call setSttModel when clicking a not-installed model — the radio is inert until it is downloaded', () => {
    const setSttModel = vi.fn()
    render(<SettingsView {...base} setSttModel={setSttModel} />)
    const row = screen.getByRole('radio', { name: /whisper medium/i })
    fireEvent.click(row)
    expect(setSttModel).not.toHaveBeenCalled()
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveAttribute('tabindex', '-1')
  })

  it('does not call setSttModel when clicking a downloading model — only Cancel is actionable', () => {
    const setSttModel = vi.fn()
    render(<SettingsView {...base} setSttModel={setSttModel} />)
    fireEvent.click(screen.getByRole('radio', { name: /whisper large-v3-turbo/i }))
    expect(setSttModel).not.toHaveBeenCalled()
  })

  it('keeps the installed, selected row selectable (aria-disabled false, tabindex 0)', () => {
    render(<SettingsView {...base} />)
    const row = screen.getByRole('radio', { name: /whisper small/i })
    expect(row).toHaveAttribute('aria-disabled', 'false')
    expect(row).toHaveAttribute('tabindex', '0')
  })

  it('shows "Installed · in use" for the selected installed model and aria-checked reflects selection', () => {
    render(<SettingsView {...base} sttModel="whisper-small" />)
    const selected = screen.getByRole('radio', { name: /whisper small/i })
    expect(selected).toHaveTextContent('Installed · in use')
    expect(selected).toHaveAttribute('aria-checked', 'true')
  })

  it('shows "Not downloaded · X GB/MB" and a Download button for a not-installed model', () => {
    render(<SettingsView {...base} />)
    const row = screen.getByRole('radio', { name: /whisper medium/i })
    expect(row).toHaveTextContent('Not downloaded · 1.5 GB')
    expect(screen.getByRole('button', { name: /download \(1\.5 gb\)/i })).toBeInTheDocument()
  })

  it('clicking Download does not also select the radio', () => {
    const setSttModel = vi.fn()
    const downloadModel = vi.fn()
    render(<SettingsView {...base} setSttModel={setSttModel} downloadModel={downloadModel} />)
    fireEvent.click(screen.getByRole('button', { name: /download \(1\.5 gb\)/i }))
    expect(downloadModel).toHaveBeenCalledWith('whisper-medium')
    expect(setSttModel).not.toHaveBeenCalled()
  })

  it('shows a progress bar and Cancel button for a downloading model', () => {
    const cancelDownload = vi.fn()
    render(<SettingsView {...base} cancelDownload={cancelDownload} />)
    const row = screen.getByRole('radio', { name: /whisper large-v3-turbo/i })
    expect(row).toHaveTextContent('Downloading 50%')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelDownload).toHaveBeenCalledWith('whisper-large-v3-turbo')
  })

  it('requires a second click within 4s to actually remove an installed model', () => {
    const deleteModel = vi.fn()
    render(<SettingsView {...base} sttModel="whisper-medium" models={[sttModel({ id: 'whisper-small', state: 'installed' })]} deleteModel={deleteModel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(deleteModel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm removal?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal?' }))
    expect(deleteModel).toHaveBeenCalledWith('whisper-small')
  })

  it('reverts the Remove button back from "Confirm removal?" after 4s without a second click', () => {
    vi.useFakeTimers()
    const deleteModel = vi.fn()
    render(<SettingsView {...base} sttModel="whisper-medium" models={[sttModel({ id: 'whisper-small', state: 'installed' })]} deleteModel={deleteModel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('button', { name: 'Confirm removal?' })).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm removal?' })).not.toBeInTheDocument()
    expect(deleteModel).not.toHaveBeenCalled()
  })

  it('does not select the radio when confirming or completing a removal', () => {
    const setSttModel = vi.fn()
    const deleteModel = vi.fn()
    render(<SettingsView {...base} setSttModel={setSttModel} sttModel="whisper-medium" models={[sttModel({ id: 'whisper-small', state: 'installed' })]} deleteModel={deleteModel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal?' }))
    expect(deleteModel).toHaveBeenCalledWith('whisper-small')
    expect(setSttModel).not.toHaveBeenCalled()
  })

  it('renders all three real LLM entries with a coming-later note', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Qwen3.5-4B', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/Gemma 4 E4B/)).toBeInTheDocument()
    expect(screen.getByText(/Qwen3.5-9B/)).toBeInTheDocument()
    expect(screen.getByText(/powers summaries — coming in a later update/i)).toBeInTheDocument()
  })

  it('groups the summary models under their own radiogroup with one radio per LLM entry', () => {
    render(<SettingsView {...base} />)
    const group = screen.getByRole('radiogroup', { name: /summary model/i })
    expect(group).toBeInTheDocument()
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
  })

  it('shows "Installed · in use" for the selected installed llm model, aria-checked true', () => {
    render(<SettingsView {...base} llmModel="qwen3.5-4b" />)
    const selected = screen.getByRole('radio', { name: /qwen3\.5-4b/i })
    expect(selected).toHaveTextContent('Installed · in use')
    expect(selected).toHaveAttribute('aria-checked', 'true')
  })

  it('calls setLlmModel when clicking a different installed llm model', () => {
    const setLlmModel = vi.fn()
    const installedModels: ModelStatus[] = [
      sttModel({ id: 'whisper-small', state: 'installed' }),
      llmModel({ id: 'qwen3.5-4b', state: 'installed' }),
      llmModel({ id: 'gemma-4-e4b', displayName: 'Gemma 4 E4B', state: 'installed' }),
    ]
    render(<SettingsView {...base} models={installedModels} llmModel="qwen3.5-4b" setLlmModel={setLlmModel} />)
    fireEvent.click(screen.getByRole('radio', { name: /gemma 4 e4b/i }))
    expect(setLlmModel).toHaveBeenCalledWith('gemma-4-e4b')
  })

  it('does not call setLlmModel when clicking a not-installed llm model — the radio is inert until it is downloaded', () => {
    const setLlmModel = vi.fn()
    render(<SettingsView {...base} setLlmModel={setLlmModel} />)
    const row = screen.getByRole('radio', { name: /gemma 4 e4b/i })
    fireEvent.click(row)
    expect(setLlmModel).not.toHaveBeenCalled()
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveAttribute('tabindex', '-1')
  })

  it('renders real storage stats and note count', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText(/Models 6.4 GB/)).toBeInTheDocument()
    expect(screen.getByText(/Audio 4.1 GB/)).toBeInTheDocument()
    expect(screen.getByText(/Notes 1.9 GB/)).toBeInTheDocument()
    expect(screen.getByText('14 notes')).toBeInTheDocument()
  })

  it('wires the storage toggles to their handlers', () => {
    const toggleDel = vi.fn()
    const toggleEnc = vi.fn()
    render(<SettingsView {...base} toggleDel={toggleDel} toggleEnc={toggleEnc} />)

    fireEvent.click(screen.getByRole('switch', { name: /delete original audio 30 days after transcription/i }))
    expect(toggleDel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('switch', { name: /encrypt note library with filevault key/i }))
    expect(toggleEnc).toHaveBeenCalledTimes(1)
  })

  it('reflects toggle state via aria-checked', () => {
    render(<SettingsView {...base} tDel={true} tEnc={false} />)
    expect(screen.getByRole('switch', { name: /delete original audio/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('switch', { name: /encrypt note library/i })).toHaveAttribute('aria-checked', 'false')
  })
})
