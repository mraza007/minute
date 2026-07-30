import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hardware, ModelStatus, Recommendation, StorageStats } from '../ipc/types'
import { SettingsView, storageBarSegments } from './SettingsView'

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

function diarModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'diar-segmentation',
    kind: 'diarization',
    displayName: 'Speaker segmentation',
    desc: 'pyannote segmentation-3.0 · finds speech turns',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
    sha256: 'c'.repeat(64),
    sizeBytes: 5_992_913,
    minRamGb: 0,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

const models: ModelStatus[] = [
  sttModel({ id: 'whisper-small', state: 'installed' }),
  sttModel({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'notInstalled', sizeBytes: 1_500_000_000, minRamGb: 16 }),
  sttModel({ id: 'whisper-large-v3-turbo', displayName: 'Whisper large-v3-turbo', state: 'downloading' }),
  llmModel({ id: 'qwen3.5-4b', state: 'installed' }),
  llmModel({ id: 'gemma-4-e4b', displayName: 'Gemma 4 E4B', state: 'notInstalled', sizeBytes: 5_300_000_000 }),
  llmModel({ id: 'qwen3.5-9b', displayName: 'Qwen3.5-9B', state: 'notInstalled', sizeBytes: 5_600_000_000 }),
]

const storage: StorageStats = { modelsBytes: 6_400_000_000, audioBytes: 4_100_000_000, notesBytes: 1_900_000_000 }
const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }

const base = {
  models,
  hardware,
  recommendation,
  downloads: { 'whisper-large-v3-turbo': { downloaded: 800_000_000, total: 1_600_000_000 } },
  sttModel: 'whisper-small',
  setSttModel: vi.fn(),
  llmModel: 'qwen3.5-4b',
  setLlmModel: vi.fn(),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  deleteModel: vi.fn(),
  storage,
  libraryPath: '~/Library/Application Support/dev.minute.app',
  libraryTitle: '/Users/test/Library/Application Support/dev.minute.app',
  movingLibrary: false,
  onChangeLibraryFolder: vi.fn().mockResolvedValue(undefined),
  noteCount: 14,
  tDel: true,
  toggleDel: vi.fn(),
  meetingDetection: false,
  toggleMeetingDetection: vi.fn(),
  captureSystemAudio: false,
  toggleCaptureSystemAudio: vi.fn(),
  sysAudioAvailability: 'ready' as const,
  onRequestSysAudioPermission: vi.fn(),
  detectSpeakers: false,
  toggleDetectSpeakers: vi.fn(),
  onExportDiagnostics: vi.fn().mockResolvedValue(undefined),
  summaryStyle: 'standard' as const,
  setSummaryStyle: vi.fn(),
  llmContextTokens: null,
  setLlmContextTokens: vi.fn(),
  summaryInstructions: '',
  setSummaryInstructions: vi.fn(),
  appVersion: '1.3.0',
  autoUpdateCheck: true,
  toggleAutoUpdateCheck: vi.fn(),
  updateAvailable: null,
  updateInstalling: false,
  updateCheckStatus: 'idle' as const,
  onCheckForUpdates: vi.fn(),
  onInstallUpdate: vi.fn(),
}

describe('SettingsView', () => {
  afterEach(() => vi.useRealTimers())

  it('explains this Mac and marks the backend-recommended model', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByRole('region', { name: 'Detected Mac hardware' })).toHaveTextContent(
      'Apple silicon · 16 GB memory · 8 CPU cores',
    )
    expect(screen.getByRole('radio', { name: /whisper small/i })).toHaveTextContent(
      'RecommendedMinute’s default for this 16 GB Mac.',
    )
    expect(screen.getByRole('radio', { name: /whisper medium/i })).toHaveTextContent('Near memory limit')
  })

  it('exports a privacy-safe diagnostics report', () => {
    const onExportDiagnostics = vi.fn().mockResolvedValue(undefined)
    render(<SettingsView {...base} onExportDiagnostics={onExportDiagnostics} />)
    expect(screen.getByText(/never includes note titles/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))
    expect(onExportDiagnostics).toHaveBeenCalledTimes(1)
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

  it('renders all three real LLM entries with a note on what the summary model powers', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Qwen3.5-4B', { exact: false })).toBeInTheDocument()
    expect(screen.getByText(/Gemma 4 E4B/)).toBeInTheDocument()
    expect(screen.getByText(/Qwen3.5-9B/)).toBeInTheDocument()
    expect(screen.getByText(/powers summaries, decisions & action items/i)).toBeInTheDocument()
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

  it('wires the delete-audio toggle to its handler', () => {
    const toggleDel = vi.fn()
    render(<SettingsView {...base} toggleDel={toggleDel} />)

    fireEvent.click(screen.getByRole('switch', { name: /delete original audio 30 days after transcription/i }))
    expect(toggleDel).toHaveBeenCalledTimes(1)
  })

  it('reflects toggle state via aria-checked', () => {
    render(<SettingsView {...base} tDel={true} />)
    expect(screen.getByRole('switch', { name: /delete original audio/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows a passive FileVault line instead of an encryption toggle', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Your library inherits FileVault full-disk encryption.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /encrypt/i })).not.toBeInTheDocument()
  })

  it('renders the meeting detection card with its toggle off by default', () => {
    render(<SettingsView {...base} />)
    expect(screen.getByText('Meeting detection')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: /offer to record when a meeting starts/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('reflects an enabled meeting detection setting via aria-checked', () => {
    render(<SettingsView {...base} meetingDetection={true} />)
    expect(screen.getByRole('switch', { name: /offer to record when a meeting starts/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('wires the meeting detection toggle to its handler', () => {
    const toggleMeetingDetection = vi.fn()
    render(<SettingsView {...base} toggleMeetingDetection={toggleMeetingDetection} />)
    fireEvent.click(screen.getByRole('switch', { name: /offer to record when a meeting starts/i }))
    expect(toggleMeetingDetection).toHaveBeenCalledTimes(1)
  })

  it('shows the local-only caption and the supported-apps line', () => {
    render(<SettingsView {...base} />)
    expect(
      screen.getByText('When another app starts using the microphone, Minute shows a small prompt. Detection is fully local and never listens to audio.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Zoom, Teams, Webex, Slack, FaceTime, Discord, and browser calls.')).toBeInTheDocument()
  })

  describe('System audio card — Capture system audio (Stage 5 Task 5)', () => {
    it('renders the System audio card with its toggle off by default', () => {
      render(<SettingsView {...base} />)
      expect(screen.getByText('System audio')).toBeInTheDocument()
      const toggle = screen.getByRole('switch', { name: /capture system audio/i })
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })

    it('reflects an enabled captureSystemAudio setting via aria-checked', () => {
      render(<SettingsView {...base} captureSystemAudio={true} />)
      expect(screen.getByRole('switch', { name: /capture system audio/i })).toHaveAttribute('aria-checked', 'true')
    })

    it('wires the toggle to its handler when availability is ready', () => {
      const toggleCaptureSystemAudio = vi.fn()
      render(<SettingsView {...base} sysAudioAvailability="ready" toggleCaptureSystemAudio={toggleCaptureSystemAudio} />)
      fireEvent.click(screen.getByRole('switch', { name: /capture system audio/i }))
      expect(toggleCaptureSystemAudio).toHaveBeenCalledTimes(1)
    })

    it('shows the requires-permission caption', () => {
      render(<SettingsView {...base} />)
      expect(
        screen.getByText(/Include what you hear — the other side of calls — in recordings and transcripts\./),
      ).toBeInTheDocument()
    })

    it('disables the toggle and shows no Grant button when unsupported (macOS <13)', () => {
      const toggleCaptureSystemAudio = vi.fn()
      render(<SettingsView {...base} sysAudioAvailability="unsupported" toggleCaptureSystemAudio={toggleCaptureSystemAudio} />)
      const toggle = screen.getByRole('switch', { name: /capture system audio/i })
      expect(toggle).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(toggle)
      expect(toggleCaptureSystemAudio).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: /grant permission/i })).not.toBeInTheDocument()
      expect(screen.getByText('Requires macOS 13 or later.')).toBeInTheDocument()
    })

    it('disables the toggle and shows a Grant permission affordance when not granted', () => {
      const toggleCaptureSystemAudio = vi.fn()
      const onRequestSysAudioPermission = vi.fn()
      render(
        <SettingsView
          {...base}
          sysAudioAvailability="notGranted"
          toggleCaptureSystemAudio={toggleCaptureSystemAudio}
          onRequestSysAudioPermission={onRequestSysAudioPermission}
        />,
      )
      const toggle = screen.getByRole('switch', { name: /capture system audio/i })
      expect(toggle).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(toggle)
      expect(toggleCaptureSystemAudio).not.toHaveBeenCalled()

      const grantButton = screen.getByRole('button', { name: /grant permission/i })
      fireEvent.click(grantButton)
      expect(onRequestSysAudioPermission).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/may need Minute to restart/)).toBeInTheDocument()
    })

    it('shows no Grant button and no restart caption when availability is ready', () => {
      render(<SettingsView {...base} sysAudioAvailability="ready" />)
      expect(screen.queryByRole('button', { name: /grant permission/i })).not.toBeInTheDocument()
      expect(screen.queryByText('Requires macOS 13 or later.')).not.toBeInTheDocument()
      expect(screen.queryByText(/may need Minute to restart/)).not.toBeInTheDocument()
    })
  })

  describe('library location', () => {
    it('shows the current library path with a working Change… button', () => {
      const onChangeLibraryFolder = vi.fn().mockResolvedValue(undefined)
      render(<SettingsView {...base} onChangeLibraryFolder={onChangeLibraryFolder} />)
      expect(screen.getByText('~/Library/Application Support/dev.minute.app')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
      expect(onChangeLibraryFolder).toHaveBeenCalledTimes(1)
    })

    it('disables the button and shows progress copy while a move is in flight', () => {
      render(<SettingsView {...base} movingLibrary />)
      const button = screen.getByRole('button', { name: 'Moving…' })
      expect(button).toBeDisabled()
    })
  })

  describe('storage bar segments', () => {
    it('floors tiny non-zero categories so they stay visible next to multi-GB models', () => {
      const segments = storageBarSegments(3_200_000_000, 7_000_000, 7_600)
      const [modelsSeg, audioSeg, notesSeg] = segments
      expect(audioSeg.pct).toBeGreaterThanOrEqual(1.5)
      expect(notesSeg.pct).toBeGreaterThanOrEqual(1.5)
      expect(modelsSeg.pct).toBeGreaterThan(90)
      const sum = segments.reduce((acc, s) => acc + s.pct, 0)
      expect(sum).toBeLessThanOrEqual(100.0001)
    })

    it('keeps true proportions when no category is tiny, and zero stays zero', () => {
      const balanced = storageBarSegments(500, 300, 200)
      expect(balanced.map(s => Math.round(s.pct))).toEqual([50, 30, 20])
      const withZero = storageBarSegments(1_000, 0, 1_000)
      expect(withZero[1].pct).toBe(0)
    })
  })

  describe('Updates section (issue #4)', () => {
    it('shows the current version and a Check now button when up to date', () => {
      render(<SettingsView {...base} />)
      expect(screen.getByText('Minute 1.3.0')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
    })

    it('wires Check now to the handler and shows the checking state', () => {
      const onCheckForUpdates = vi.fn()
      render(<SettingsView {...base} onCheckForUpdates={onCheckForUpdates} />)
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
      expect(onCheckForUpdates).toHaveBeenCalledTimes(1)
      cleanup()
      render(<SettingsView {...base} updateCheckStatus="checking" />)
      expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    })

    it('shows the install button when an update is available and wires it', () => {
      const onInstallUpdate = vi.fn()
      render(<SettingsView {...base} updateAvailable={{ version: '1.4.0' }} onInstallUpdate={onInstallUpdate} />)
      const install = screen.getByRole('button', { name: 'Update to 1.4.0 & restart' })
      fireEvent.click(install)
      expect(onInstallUpdate).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
    })

    it('shows Installing… disabled while the update applies', () => {
      render(<SettingsView {...base} updateAvailable={{ version: '1.4.0' }} updateInstalling />)
      expect(screen.getByRole('button', { name: 'Installing…' })).toBeDisabled()
    })

    it('reports up-to-date and error outcomes of a manual check', () => {
      render(<SettingsView {...base} updateCheckStatus="upToDate" />)
      expect(screen.getByText('You’re on the latest version.')).toBeInTheDocument()
      cleanup()
      render(<SettingsView {...base} updateCheckStatus="error" />)
      expect(screen.getByText('Couldn’t reach GitHub — try again later.')).toBeInTheDocument()
    })

    it('wires the automatic-check toggle', () => {
      const toggleAutoUpdateCheck = vi.fn()
      render(<SettingsView {...base} toggleAutoUpdateCheck={toggleAutoUpdateCheck} />)
      fireEvent.click(screen.getByRole('switch', { name: /check for updates automatically/i }))
      expect(toggleAutoUpdateCheck).toHaveBeenCalledTimes(1)
    })
  })

  describe('grouped page structure', () => {
    it('renders the three group chapters as headings', () => {
      render(<SettingsView {...base} />)
      expect(screen.getByRole('heading', { level: 2, name: 'Models' })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'Recording' })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'Data' })).toBeInTheDocument()
    })
  })

  describe('Summary behavior — style and context window', () => {
    it('reflects the current summary style via aria-checked', () => {
      render(<SettingsView {...base} summaryStyle="detailed" />)
      const group = screen.getByRole('radiogroup', { name: 'Summary style' })
      expect(within(group).getByRole('radio', { name: 'Detailed' })).toHaveAttribute('aria-checked', 'true')
      expect(within(group).getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'false')
    })

    it('wires the style picker to its handler', () => {
      const setSummaryStyle = vi.fn()
      render(<SettingsView {...base} setSummaryStyle={setSummaryStyle} />)
      fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Summary style' })).getByRole('radio', { name: 'Short' }))
      expect(setSummaryStyle).toHaveBeenCalledWith('short')
    })

    it('defaults the context window to Auto and wires a manual pick', () => {
      const setLlmContextTokens = vi.fn()
      render(<SettingsView {...base} setLlmContextTokens={setLlmContextTokens} />)
      const group = screen.getByRole('radiogroup', { name: 'Context window' })
      expect(within(group).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(within(group).getByRole('radio', { name: '16k' }))
      expect(setLlmContextTokens).toHaveBeenCalledWith(16_384)
    })

    it('returns to automatic when Auto is picked over an override', () => {
      const setLlmContextTokens = vi.fn()
      render(<SettingsView {...base} llmContextTokens={32_768} setLlmContextTokens={setLlmContextTokens} />)
      const group = screen.getByRole('radiogroup', { name: 'Context window' })
      expect(within(group).getByRole('radio', { name: '32k' })).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(within(group).getByRole('radio', { name: 'Auto' }))
      expect(setLlmContextTokens).toHaveBeenCalledWith(null)
    })

    it('shows the persisted custom instructions and commits an edit via the Save button', () => {
      const setSummaryInstructions = vi.fn()
      render(<SettingsView {...base} summaryInstructions="Focus on deadlines." setSummaryInstructions={setSummaryInstructions} />)
      const box = screen.getByLabelText('Custom instructions')
      expect(box).toHaveValue('Focus on deadlines.')

      fireEvent.change(box, { target: { value: 'Write the summary in German.' } })
      // Typing alone must not persist — only Save does.
      expect(setSummaryInstructions).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(setSummaryInstructions).toHaveBeenCalledWith('Write the summary in German.')
    })

    it('disables Save while the draft matches the persisted value and shows Saved', () => {
      render(<SettingsView {...base} summaryInstructions="Keep it brief." />)
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(screen.getByText('Saved')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Custom instructions'), { target: { value: 'Keep it very brief.' } })
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })

    it('saving an emptied box clears the instructions', () => {
      const setSummaryInstructions = vi.fn()
      render(<SettingsView {...base} summaryInstructions="Old instructions." setSummaryInstructions={setSummaryInstructions} />)
      fireEvent.change(screen.getByLabelText('Custom instructions'), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(setSummaryInstructions).toHaveBeenCalledWith('')
    })
  })

  describe('Speakers — Detect speakers (issue #6)', () => {
    const diarPair = [
      diarModel(),
      diarModel({ id: 'diar-embedding', displayName: 'Voice embeddings', sizeBytes: 28_281_164 }),
    ]

    it('flips the setting via its toggle', () => {
      const toggleDetectSpeakers = vi.fn()
      render(<SettingsView {...base} toggleDetectSpeakers={toggleDetectSpeakers} />)
      fireEvent.click(screen.getByRole('switch', { name: 'Detect speakers' }))
      expect(toggleDetectSpeakers).toHaveBeenCalledTimes(1)
    })

    it('never lists the diarization pair in the model pickers', () => {
      render(<SettingsView {...base} models={[...models, ...diarPair]} />)
      const sttGroup = screen.getByRole('radiogroup', { name: 'Transcription model' })
      const llmGroup = screen.getByRole('radiogroup', { name: 'Summary model' })
      expect(within(sttGroup).queryByText('Speaker segmentation')).not.toBeInTheDocument()
      expect(within(llmGroup).queryByText('Voice embeddings')).not.toBeInTheDocument()
    })

    it('offers a retry download when enabled but the models are missing', () => {
      const downloadModel = vi.fn()
      render(
        <SettingsView
          {...base}
          models={[...models, ...diarPair]}
          detectSpeakers
          downloadModel={downloadModel}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Download models' }))
      expect(downloadModel).toHaveBeenCalledWith('diar-segmentation')
      expect(downloadModel).toHaveBeenCalledWith('diar-embedding')
    })

    it('shows in-flight download progress instead of the retry button', () => {
      render(
        <SettingsView
          {...base}
          models={[...models, ...diarPair]}
          detectSpeakers
          downloads={{ ...base.downloads, 'diar-segmentation': { downloaded: 3_000_000, total: 5_992_913 } }}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Download models' })).not.toBeInTheDocument()
    })

    it('confirms once both models are installed', () => {
      const installedPair = diarPair.map(m => ({ ...m, state: 'installed' as const }))
      render(<SettingsView {...base} models={[...models, ...installedPair]} detectSpeakers />)
      expect(screen.getByText(/Speaker models installed/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Download models' })).not.toBeInTheDocument()
    })
  })
})
