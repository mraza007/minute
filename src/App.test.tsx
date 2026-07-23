import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mockIPC } from '@tauri-apps/api/mocks'
import { describe, expect, it } from 'vitest'
import App from './App'
import type { Hardware, ModelStatus, NoteMeta, Recommendation, StorageStats } from './ipc/types'

const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
const storage: StorageStats = { modelsBytes: 500_000_000, audioBytes: 200_000_000, notesBytes: 100_000_000 }

function sttModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    desc: 'good for meetings',
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

function noteFixture(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    id: '20260722-120000',
    title: 'Client call — Acme',
    createdAt: '2026-07-22T12:00:00.000Z',
    durationSec: 48 * 60,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 4,
    ...overrides,
  }
}

function setupIPC(opts: { models?: ModelStatus[]; notes?: NoteMeta[] } = {}) {
  const models = opts.models ?? [sttModel({ state: 'installed' }), llmModel()]
  const notes = opts.notes ?? [noteFixture()]
  mockIPC(
    cmd => {
      switch (cmd) {
        case 'list_models':
          return models
        case 'list_notes':
          return notes
        case 'hardware_info':
          return hardware
        case 'recommended_models':
          return recommendation
        case 'storage_stats':
          return storage
        case 'start_recording':
          return '20260722-130000'
        case 'stop_recording':
          return notes[0] ?? noteFixture()
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}

describe('App', () => {
  it('shows a loading state before the initial IPC calls resolve', () => {
    setupIPC()
    render(<App />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('boots to the notes view with the sidebar and NoteView once an STT model is installed', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /new recording/i })).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('boots to the onboarding gate when no STT model is installed', async () => {
    setupIPC({ models: [sttModel({ state: 'notInstalled' }), llmModel()] })
    render(<App />)
    await waitFor(() => expect(screen.getByText('Minute runs entirely on this Mac.')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()
  })

  it('switches to RecordingView when "New recording" is clicked', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    await waitFor(() => expect(screen.getByText('LIVE TRANSCRIPT — AUDIO NEVER LEAVES THIS MACHINE')).toBeInTheDocument())
    expect(screen.getByText('REC 00:00')).toBeInTheDocument()
  })

  it('returns to the notes view when "Stop & transcribe" is clicked', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    await waitFor(() => screen.getByRole('button', { name: /stop & transcribe/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop & transcribe/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument())
  })

  it('shows SettingsView when Settings is clicked in the sidebar, and returns to notes via "All notes"', async () => {
    setupIPC()
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText('Nothing leaves this machine.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All notes' }))
    expect(screen.queryByText('Nothing leaves this machine.')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Client call — Acme' })).toBeInTheDocument()
  })

  it('shows the sidebar and NoteView empty states when the note library is empty', async () => {
    setupIPC({ notes: [] })
    render(<App />)
    await waitFor(() => screen.getByRole('button', { name: /new recording/i }))
    expect(screen.getAllByText(/no notes yet/i).length).toBeGreaterThan(0)
  })
})
