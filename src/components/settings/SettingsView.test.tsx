import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASK_FOR_EVERY_APP } from '../../ipc/meetingPolicy'
import type { Hardware, ModelBrowse, ModelOrigin, ModelStatus, Recommendation, StorageStats } from '../../ipc/types'
import { DEFAULT_OBSIDIAN_SETTINGS } from '../../state/obsidian'
import type { BrowseState, HuggingFaceBrowse } from '../../state/useModelManager'
import { SettingsNav } from './SettingsNav'
import { SettingsView, type SettingsViewProps } from './SettingsView'
import type { SettingsSectionId } from './sections'
import { storageBarSegments } from './storageBar'

function sttModel(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    traits: [],
    origin: { kind: 'tested' },
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
    traits: [],
    origin: { kind: 'tested' },
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
    traits: [],
    origin: { kind: 'tested' },
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
    sha256: 'c'.repeat(64),
    sizeBytes: 5_992_913,
    minRamGb: 0,
    requiresAppleSilicon: false,
    state: 'notInstalled',
    ...overrides,
  }
}

function hfModel(file: string, overrides: Partial<ModelStatus> = {}, origin: Partial<Extract<ModelOrigin, { kind: 'huggingFace' }>> = {}): ModelStatus {
  const publisher = origin.publisher ?? 'ibm-granite'
  return llmModel({
    id: `hf:${publisher}/repo-GGUF/${file}`,
    displayName: file,
    traits: [],
    origin: {
      kind: 'huggingFace',
      repo: `${publisher}/repo-GGUF`,
      file,
      publisher,
      trusted: true,
      architecture: 'llama',
      parameters: 6_940_000_000,
      quantization: 'Q4_K_M',
      updatedAt: `${new Date().getFullYear()}-10-02T12:00:00Z`,
      downloads: 1_000,
      ...origin,
    },
    sizeBytes: 4_900_000_000,
    ...overrides,
  })
}

function answer(overrides: Partial<ModelBrowse> = {}): ModelBrowse {
  return { entries: [], fetchedAt: null, unsupportedCount: 0, error: null, ...overrides }
}

/** A stand-in for the model manager's Hugging Face controller: `models` are the browsed rows, `stt`/`llm` the per-kind state. */
function browse({ models = [], stt = {}, llm = {} }: { models?: ModelStatus[]; stt?: Partial<BrowseState>; llm?: Partial<BrowseState> } = {}): HuggingFaceBrowse {
  return {
    state: {
      stt: { result: answer(), loading: false, query: '', ...stt },
      llm: { result: answer(), loading: false, query: '', ...llm },
    },
    models,
    open: vi.fn(),
    setQuery: vi.fn(),
    search: vi.fn(),
    refresh: vi.fn(),
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

const base: Omit<SettingsViewProps, 'section'> = {
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
  huggingFace: browse(),
  storage,
  libraryPath: '~/Library/Application Support/dev.minute.app',
  libraryTitle: '/Users/test/Library/Application Support/dev.minute.app',
  movingLibrary: false,
  onChangeLibraryFolder: vi.fn().mockResolvedValue(undefined),
  noteCount: 14,
  tDel: true,
  toggleDel: vi.fn(),
  compressAudioAfterDays: null,
  setCompressAudioAfterDays: vi.fn(),
  meetingDetection: false,
  toggleMeetingDetection: vi.fn(),
  meetingPolicies: ASK_FOR_EVERY_APP,
  onSetMeetingPolicy: vi.fn(),
  captureSystemAudio: false,
  toggleCaptureSystemAudio: vi.fn(),
  sysAudioAvailability: 'ready',
  onRequestSysAudioPermission: vi.fn(),
  detectSpeakers: false,
  toggleDetectSpeakers: vi.fn(),
  autoStopRecording: true,
  toggleAutoStopRecording: vi.fn(),
  speakerProfiles: false,
  toggleSpeakerProfiles: vi.fn(),
  autoApplySpeakerNames: true,
  toggleAutoApplySpeakerNames: vi.fn(),
  voiceProfiles: [],
  onDeleteVoiceProfile: vi.fn(),
  onExportDiagnostics: vi.fn().mockResolvedValue(undefined),
  summaryStyle: 'standard',
  setSummaryStyle: vi.fn(),
  llmContextTokens: null,
  setLlmContextTokens: vi.fn(),
  summaryInstructions: '',
  setSummaryInstructions: vi.fn(),
  obsidian: DEFAULT_OBSIDIAN_SETTINGS,
  onSaveObsidian: vi.fn().mockResolvedValue(null),
  onCheckObsidianVault: vi.fn().mockResolvedValue(null),
  onChooseObsidianVault: vi.fn().mockResolvedValue(null),
  obsidianLastSave: null,
  obsidianPreviewNote: null,
  appVersion: '1.3.0',
  autoUpdateCheck: true,
  toggleAutoUpdateCheck: vi.fn(),
  updateAvailable: null,
  updateInstalling: false,
  updateCheckStatus: 'idle',
  onCheckForUpdates: vi.fn(),
  onInstallUpdate: vi.fn(),
}

function renderSection(section: SettingsSectionId, overrides: Partial<SettingsViewProps> = {}) {
  return render(<SettingsView {...base} section={section} {...overrides} />)
}

describe('SettingsNav', () => {
  it('lists the seven sections, marks the current one, and goes back to the notes', () => {
    const onSelect = vi.fn()
    const onBack = vi.fn()
    render(<SettingsNav section="models" onSelect={onSelect} onBack={onBack} />)

    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Recording',
      'Summaries',
      'Speakers',
      'Models',
      'Integrations',
      'Storage',
      'About',
    ])
    expect(screen.getByRole('button', { name: 'Models' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Recording' })).not.toHaveAttribute('aria-current')

    fireEvent.click(screen.getByRole('button', { name: 'Storage' }))
    expect(onSelect).toHaveBeenCalledWith('storage')
    fireEvent.click(screen.getByRole('button', { name: 'Back to notes' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsView', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('shows one section at a time under its own heading', () => {
    renderSection('summaries')
    expect(screen.getByRole('heading', { level: 1, name: 'Summaries' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Transcription model' })).not.toBeInTheDocument()
  })

  describe('Recording', () => {
    it('keeps the per-app policies out of sight while detection is off', () => {
      renderSection('recording')
      const toggle = screen.getByRole('switch', { name: 'Detect meetings' })
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })

    it('wires the detection switch to its handler', () => {
      const toggleMeetingDetection = vi.fn()
      renderSection('recording', { toggleMeetingDetection })
      fireEvent.click(screen.getByRole('switch', { name: 'Detect meetings' }))
      expect(toggleMeetingDetection).toHaveBeenCalledTimes(1)
    })

    it('lists a policy for every app while detection is on and saves a change for that app only', () => {
      const onSetMeetingPolicy = vi.fn()
      renderSection('recording', {
        meetingDetection: true,
        meetingPolicies: { ...ASK_FOR_EVERY_APP, teams: 'record', faceTime: 'ignore' },
        onSetMeetingPolicy,
      })

      expect(screen.getAllByRole('combobox')).toHaveLength(7)
      expect(screen.getByRole('combobox', { name: 'When a meeting starts in Microsoft Teams' })).toHaveDisplayValue('Record automatically')
      expect(screen.getByRole('combobox', { name: 'When a meeting starts in FaceTime' })).toHaveDisplayValue('Do nothing')
      expect(screen.getByRole('combobox', { name: 'When a meeting starts in Zoom' })).toHaveDisplayValue('Ask me')

      fireEvent.change(screen.getByRole('combobox', { name: 'When a meeting starts in Zoom' }), { target: { value: '1' } })
      expect(onSetMeetingPolicy).toHaveBeenCalledTimes(1)
      expect(onSetMeetingPolicy).toHaveBeenCalledWith('zoom', 'record')
    })

    it('flips auto-stop and shows its persisted state', () => {
      const toggleAutoStopRecording = vi.fn()
      renderSection('recording', { toggleAutoStopRecording })
      const toggle = screen.getByRole('switch', { name: 'Stop when the meeting ends' })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(toggle)
      expect(toggleAutoStopRecording).toHaveBeenCalledTimes(1)
    })

    describe('Capture system audio', () => {
      it('reflects the setting and wires the switch when availability is ready', () => {
        const toggleCaptureSystemAudio = vi.fn()
        renderSection('recording', { captureSystemAudio: true, toggleCaptureSystemAudio })
        const toggle = screen.getByRole('switch', { name: 'Capture system audio' })
        expect(toggle).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(toggle)
        expect(toggleCaptureSystemAudio).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('button', { name: /grant permission/i })).not.toBeInTheDocument()
        expect(screen.queryByText('Requires macOS 13 or later.')).not.toBeInTheDocument()
        expect(screen.queryByText(/may need Minute to restart/)).not.toBeInTheDocument()
      })

      it('disables the switch and shows no Grant button when unsupported (macOS before 13)', () => {
        const toggleCaptureSystemAudio = vi.fn()
        renderSection('recording', { sysAudioAvailability: 'unsupported', toggleCaptureSystemAudio })
        const toggle = screen.getByRole('switch', { name: 'Capture system audio' })
        expect(toggle).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(toggle)
        expect(toggleCaptureSystemAudio).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: /grant permission/i })).not.toBeInTheDocument()
        expect(screen.getByText('Requires macOS 13 or later.')).toBeInTheDocument()
      })

      it('disables the switch and offers Grant permission when not granted', () => {
        const toggleCaptureSystemAudio = vi.fn()
        const onRequestSysAudioPermission = vi.fn()
        renderSection('recording', { sysAudioAvailability: 'notGranted', toggleCaptureSystemAudio, onRequestSysAudioPermission })
        const toggle = screen.getByRole('switch', { name: 'Capture system audio' })
        expect(toggle).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(toggle)
        expect(toggleCaptureSystemAudio).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: /grant permission/i }))
        expect(onRequestSysAudioPermission).toHaveBeenCalledTimes(1)
        expect(screen.getByText(/may need Minute to restart/)).toBeInTheDocument()
      })
    })
  })

  describe('Summaries', () => {
    it('reflects the current length via aria-checked and wires a pick', () => {
      const setSummaryStyle = vi.fn()
      renderSection('summaries', { summaryStyle: 'detailed', setSummaryStyle })
      const group = screen.getByRole('radiogroup', { name: 'Summary length' })
      expect(within(group).getByRole('radio', { name: 'Detailed' })).toHaveAttribute('aria-checked', 'true')
      expect(within(group).getByRole('radio', { name: 'Standard' })).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(within(group).getByRole('radio', { name: 'Short' }))
      expect(setSummaryStyle).toHaveBeenCalledWith('short')
    })

    it('defaults the context size to Automatic and wires a manual pick', () => {
      const setLlmContextTokens = vi.fn()
      renderSection('summaries', { setLlmContextTokens })
      const select = screen.getByRole('combobox', { name: 'Context size' })
      expect(select).toHaveDisplayValue('Automatic')
      fireEvent.change(select, { target: { value: '2' } })
      expect(setLlmContextTokens).toHaveBeenCalledWith(16_384)
    })

    it('returns to automatic when Automatic is picked over an override', () => {
      const setLlmContextTokens = vi.fn()
      renderSection('summaries', { llmContextTokens: 32_768, setLlmContextTokens })
      const select = screen.getByRole('combobox', { name: 'Context size' })
      expect(select).toHaveDisplayValue('32k tokens')
      fireEvent.change(select, { target: { value: '0' } })
      expect(setLlmContextTokens).toHaveBeenCalledWith(null)
    })

    it('shows the persisted instructions and saves an edit with the Save button only', () => {
      const setSummaryInstructions = vi.fn()
      renderSection('summaries', { summaryInstructions: 'Focus on deadlines.', setSummaryInstructions })
      const box = screen.getByLabelText('Your instructions')
      expect(box).toHaveValue('Focus on deadlines.')

      fireEvent.change(box, { target: { value: 'Write the summary in German.' } })
      expect(setSummaryInstructions).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(setSummaryInstructions).toHaveBeenCalledWith('Write the summary in German.')
    })

    it('disables Save while the draft matches the saved value and shows Saved', () => {
      renderSection('summaries', { summaryInstructions: 'Keep it brief.' })
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(screen.getByText('Saved')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Your instructions'), { target: { value: 'Keep it very brief.' } })
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })

    it('saving an emptied box clears the instructions', () => {
      const setSummaryInstructions = vi.fn()
      renderSection('summaries', { summaryInstructions: 'Old instructions.', setSummaryInstructions })
      fireEvent.change(screen.getByLabelText('Your instructions'), { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      expect(setSummaryInstructions).toHaveBeenCalledWith('')
    })
  })

  describe('Speakers', () => {
    const diarPair = [diarModel(), diarModel({ id: 'diar-embedding', displayName: 'Voice embeddings', sizeBytes: 28_281_164 })]

    it('flips detection via its switch', () => {
      const toggleDetectSpeakers = vi.fn()
      renderSection('speakers', { toggleDetectSpeakers })
      fireEvent.click(screen.getByRole('switch', { name: 'Detect speakers' }))
      expect(toggleDetectSpeakers).toHaveBeenCalledTimes(1)
    })

    it('hides the voice options while detection is off', () => {
      renderSection('speakers', { detectSpeakers: false })
      expect(screen.queryByText('Remember named speakers')).not.toBeInTheDocument()
      expect(screen.queryByText('Remembered voices')).not.toBeInTheDocument()
    })

    it('nests the automatic-insertion switch under remembered names', () => {
      const toggleAutoApplySpeakerNames = vi.fn()
      const { rerender } = renderSection('speakers', { detectSpeakers: true, speakerProfiles: false })
      expect(screen.getByRole('switch', { name: 'Remember named speakers' })).toHaveAttribute('aria-checked', 'false')
      expect(screen.queryByRole('switch', { name: 'Use remembered names automatically' })).not.toBeInTheDocument()

      rerender(<SettingsView {...base} section="speakers" detectSpeakers speakerProfiles toggleAutoApplySpeakerNames={toggleAutoApplySpeakerNames} />)
      fireEvent.click(screen.getByRole('switch', { name: 'Use remembered names automatically' }))
      expect(toggleAutoApplySpeakerNames).toHaveBeenCalledTimes(1)
    })

    it('lists remembered voices with Forget', () => {
      const onDeleteVoiceProfile = vi.fn()
      renderSection('speakers', {
        detectSpeakers: true,
        speakerProfiles: true,
        voiceProfiles: [
          { name: 'Sarah', embedding: [0.1, 0.2], samples: 3, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-05T00:00:00Z' },
        ],
        onDeleteVoiceProfile,
      })
      const list = screen.getByRole('list', { name: 'Saved voice profiles' })
      expect(within(list).getByText('Sarah')).toBeInTheDocument()
      expect(within(list).getByText('heard 3 times')).toBeInTheDocument()
      expect(screen.getByText('1 voice · stored on this Mac')).toBeInTheDocument()
      fireEvent.click(within(list).getByRole('button', { name: 'Forget Sarah' }))
      expect(onDeleteVoiceProfile).toHaveBeenCalledWith('Sarah')
    })

    it('invites the first rename when no voice is saved yet', () => {
      renderSection('speakers', { detectSpeakers: true, speakerProfiles: true, voiceProfiles: [] })
      expect(screen.getByText(/No voices saved yet/)).toBeInTheDocument()
    })

    it('offers a retry download when enabled but the models are missing', () => {
      const downloadModel = vi.fn()
      renderSection('speakers', { models: [...models, ...diarPair], detectSpeakers: true, downloadModel })
      fireEvent.click(screen.getByRole('button', { name: 'Download models' }))
      expect(downloadModel).toHaveBeenCalledWith('diar-segmentation')
      expect(downloadModel).toHaveBeenCalledWith('diar-embedding')
    })

    it('shows in-flight download progress instead of the retry button', () => {
      renderSection('speakers', {
        models: [...models, ...diarPair],
        detectSpeakers: true,
        downloads: { 'diar-segmentation': { downloaded: 3_000_000, total: 5_992_913 } },
      })
      expect(screen.queryByRole('button', { name: 'Download models' })).not.toBeInTheDocument()
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    })

    it('confirms once both models are installed', () => {
      const installedPair = diarPair.map(m => ({ ...m, state: 'installed' as const }))
      renderSection('speakers', { models: [...models, ...installedPair], detectSpeakers: true })
      expect(screen.getByText(/Speaker models installed/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Download models' })).not.toBeInTheDocument()
    })
  })

  describe('Models', () => {
    it('explains this Mac, says when it asks Hugging Face, and marks the recommended model', () => {
      renderSection('models')
      const lede = screen.getByRole('region', { name: 'Detected Mac hardware' })
      expect(lede).toHaveTextContent('Apple silicon · 16 GB memory · 8 CPU cores')
      expect(lede).toHaveTextContent('When this page opens, Minute asks Hugging Face for newer models; nothing about your notes is sent.')
      expect(screen.getByRole('radio', { name: /whisper small/i })).toHaveTextContent('Recommended. Minute’s default for this 16 GB Mac.')
    })

    it('asks Hugging Face once when the page opens', () => {
      const huggingFace = browse()
      renderSection('models', { huggingFace })
      expect(huggingFace.open).toHaveBeenCalledTimes(1)
    })

    it('offers only downloaded models as choices, one radio group per kind', () => {
      renderSection('models', { models: [...models, diarModel()] })
      const stt = screen.getByRole('radiogroup', { name: 'Transcription model' })
      const llm = screen.getByRole('radiogroup', { name: 'Summary model' })
      expect(within(stt).getAllByRole('radio').map(radio => radio.getAttribute('data-model-id'))).toEqual(['whisper-small'])
      expect(within(llm).getAllByRole('radio').map(radio => radio.getAttribute('data-model-id'))).toEqual(['qwen3.5-4b'])
      expect(screen.queryByText('Speaker segmentation')).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'Summaries and Ask' })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 3, name: 'Tested by Minute' })).toBeInTheDocument()
    })

    it('describes each model by its traits and size', () => {
      renderSection('models', { models: [sttModel({ state: 'installed', traits: ['Fast', '99 languages'] })] })
      expect(screen.getByRole('radio', { name: /whisper small/i })).toHaveTextContent('Fast · 99 languages · 466 MB')
    })

    it('selects a downloaded model that is not the current one', () => {
      const setSttModel = vi.fn()
      const installed = [sttModel({ id: 'whisper-small', state: 'installed' }), sttModel({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'installed' })]
      renderSection('models', { models: installed, setSttModel })
      fireEvent.click(screen.getByRole('radio', { name: /whisper medium/i }))
      expect(setSttModel).toHaveBeenCalledWith('whisper-medium')
    })

    it('moves focus and the selection with the arrow keys, with one tab stop', () => {
      const setSttModel = vi.fn()
      const installed = [
        sttModel({ id: 'whisper-small', state: 'installed' }),
        sttModel({ id: 'whisper-medium', displayName: 'Whisper medium', state: 'notInstalled' }),
        sttModel({ id: 'whisper-large', displayName: 'Whisper large', state: 'installed' }),
      ]
      renderSection('models', { models: installed, setSttModel })
      const small = screen.getByRole('radio', { name: /whisper small/i })
      const large = screen.getByRole('radio', { name: /whisper large/i })
      expect([small.tabIndex, large.tabIndex]).toEqual([0, -1])
      fireEvent.keyDown(small, { key: 'ArrowDown' })
      expect(setSttModel).toHaveBeenCalledWith('whisper-large')
      expect(large).toHaveFocus()
    })

    it('marks the model in use and still lets it be removed', () => {
      const deleteModel = vi.fn()
      renderSection('models', { deleteModel })
      const row = screen.getByRole('radio', { name: /qwen3\.5-4b/i }).parentElement as HTMLElement
      expect(row).toHaveTextContent('In use')
      fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
      fireEvent.click(within(row).getByRole('button', { name: 'Confirm removal?' }))
      expect(deleteModel).toHaveBeenCalledWith('qwen3.5-4b')
    })

    it('needs a second click within 4 seconds to remove a downloaded model', () => {
      const deleteModel = vi.fn()
      const setSttModel = vi.fn()
      renderSection('models', { sttModel: 'whisper-medium', models: [sttModel({ id: 'whisper-small', state: 'installed' })], deleteModel, setSttModel })

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      expect(deleteModel).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Confirm removal?' }))
      expect(deleteModel).toHaveBeenCalledWith('whisper-small')
      expect(setSttModel).not.toHaveBeenCalled()
    })

    it('reverts Remove after 4 seconds without a second click', () => {
      vi.useFakeTimers()
      const deleteModel = vi.fn()
      renderSection('models', { sttModel: 'whisper-medium', models: [sttModel({ id: 'whisper-small', state: 'installed' })], deleteModel })

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
      expect(deleteModel).not.toHaveBeenCalled()
    })

    it('downloads a tested model from its named Download button, without selecting it', () => {
      const setSttModel = vi.fn()
      const downloadModel = vi.fn()
      renderSection('models', { setSttModel, downloadModel })
      fireEvent.click(screen.getByRole('button', { name: 'Download Whisper medium, 1.5 GB' }))
      expect(downloadModel).toHaveBeenCalledWith('whisper-medium')
      expect(setSttModel).not.toHaveBeenCalled()
    })

    it('shows progress and Cancel for a downloading model', () => {
      const cancelDownload = vi.fn()
      renderSection('models', { cancelDownload })
      const progress = screen.getByRole('progressbar')
      expect(progress).toHaveAttribute('aria-valuenow', '50')
      expect(progress).toHaveAttribute('aria-valuetext', '800 MB of 1.6 GB')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel downloading Whisper large-v3-turbo' }))
      expect(cancelDownload).toHaveBeenCalledWith('whisper-large-v3-turbo')
    })

    it('folds the other whisper.cpp files away behind the tested transcription models', () => {
      const tiny = hfModel(
        'ggml-tiny.en-q5_1.bin',
        { kind: 'stt', displayName: 'Whisper tiny, English (q5_1)', traits: [], sizeBytes: 32_000_000, minRamGb: 0 },
        { publisher: 'ggerganov' },
      )
      renderSection('models', { huggingFace: browse({ models: [tiny] }) })
      const available = screen.getByRole('heading', { level: 3, name: 'Available to download' }).parentElement?.nextElementSibling as HTMLElement
      expect(within(available).getByText('Whisper medium')).toBeInTheDocument()
      expect(screen.queryByText('Whisper tiny, English (q5_1)')).not.toBeInTheDocument()

      const fold = screen.getByRole('button', { name: /1 more file from whisper\.cpp on Hugging Face/ })
      expect(fold).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(fold)
      expect(fold).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('Whisper tiny, English (q5_1)')).toBeInTheDocument()
    })

    it('downloads a trusted publisher’s file at once', () => {
      const downloadModel = vi.fn()
      const granite = hfModel('granite-4.0-h-tiny-Q4_K_M.gguf', { displayName: 'Granite 4.0 H Tiny', sizeBytes: 4_200_000_000 }, { publisher: 'ibm-granite' })
      renderSection('models', { downloadModel, huggingFace: browse({ models: [granite] }) })
      expect(screen.getByText('ibm-granite · 6.9B · Q4_K_M · 4.2 GB · Oct 2')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Download Granite 4.0 H Tiny, 4.2 GB' }))
      expect(downloadModel).toHaveBeenCalledWith(granite.id)
    })

    it('asks before downloading from an unknown publisher, with focus in the question and back after', () => {
      const downloadModel = vi.fn()
      const llama = hfModel('llama-Q4_K_M.gguf', { displayName: 'Llama 3.1 8B Instruct' }, { publisher: 'jdoe-quants', trusted: false })
      renderSection('models', { downloadModel, huggingFace: browse({ models: [llama] }) })
      expect(screen.getByText('Unknown publisher')).toBeInTheDocument()

      const download = screen.getByRole('button', { name: 'Download Llama 3.1 8B Instruct, 4.9 GB' })
      fireEvent.click(download)
      expect(downloadModel).not.toHaveBeenCalled()
      const question = screen.getByRole('group', { name: /Minute has not checked files from jdoe-quants\./ })
      expect(question).toHaveTextContent('A damaged or hostile model file can crash the app. Download only if you trust this publisher.')
      expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus()
      expect(screen.queryByRole('button', { name: 'Download Llama 3.1 8B Instruct, 4.9 GB' })).not.toBeInTheDocument()

      fireEvent.keyDown(question, { key: 'Escape' })
      expect(screen.queryByRole('group', { name: /Minute has not checked/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download Llama 3.1 8B Instruct, 4.9 GB' })).toHaveFocus()

      fireEvent.click(screen.getByRole('button', { name: 'Download Llama 3.1 8B Instruct, 4.9 GB' }))
      fireEvent.click(screen.getByRole('button', { name: 'Download anyway' }))
      expect(downloadModel).toHaveBeenCalledWith(llama.id, true)
      expect(screen.queryByRole('group', { name: /Minute has not checked/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download Llama 3.1 8B Instruct, 4.9 GB' })).toHaveFocus()
    })

    it('folds away models that need more memory than this Mac has until asked', () => {
      const big = [
        hfModel('llama-70b.gguf', { displayName: 'Llama 3.3 70B', minRamGb: 48 }),
        hfModel('qwen-32b.gguf', { displayName: 'Qwen3 32B', minRamGb: 24 }),
      ]
      renderSection('models', { huggingFace: browse({ models: big }) })
      const fold = screen.getByRole('button', { name: /2 more need more memory than this Mac has/ })
      expect(fold).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Llama 3.3 70B')).not.toBeInTheDocument()

      fireEvent.click(fold)
      expect(fold).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('Llama 3.3 70B')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download Qwen3 32B, 4.9 GB' })).toBeInTheDocument()
    })

    it('searches as the user types and at once on Enter', () => {
      const huggingFace = browse({ llm: { query: 'gran' } })
      renderSection('models', { huggingFace })
      const field = screen.getByRole('searchbox', { name: 'Search any model on Hugging Face' })
      expect(field).toHaveValue('gran')
      fireEvent.change(field, { target: { value: 'granite' } })
      expect(huggingFace.setQuery).toHaveBeenCalledWith('llm', 'granite')
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(huggingFace.search).toHaveBeenCalledWith('llm')
    })

    it('says how fresh the list is and refreshes it', () => {
      const huggingFace = browse({ llm: { result: answer({ fetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }) } })
      renderSection('models', { huggingFace })
      expect(screen.getByText(/Updated 2 h ago/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      expect(huggingFace.refresh).toHaveBeenCalledWith('llm')
    })

    it('says it is checking while the first answer is on its way', () => {
      renderSection('models', { huggingFace: browse({ llm: { result: null, loading: true } }) })
      expect(screen.getByText('Checking…')).toBeInTheDocument()
      expect(screen.getByText('Checking Hugging Face for newer models…')).toBeInTheDocument()
    })

    it('keeps tested models downloadable when Hugging Face cannot be reached', () => {
      const offline = answer({ fetchedAt: null, error: 'network is offline' })
      const huggingFace = browse({ stt: { result: offline }, llm: { result: offline } })
      renderSection('models', { huggingFace })
      expect(screen.getByText(/Could not reach Hugging Face\. Models on this Mac keep working\./)).toBeInTheDocument()
      expect(screen.getByText(/Could not reach Hugging Face for more transcription models\./)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download Gemma 4 E4B, 5.3 GB' })).toBeInTheDocument()

      const retries = screen.getAllByRole('button', { name: 'Try again' })
      expect(retries).toHaveLength(2)
      retries.forEach(button => fireEvent.click(button))
      expect(huggingFace.refresh).toHaveBeenCalledWith('stt')
      expect(huggingFace.refresh).toHaveBeenCalledWith('llm')
    })

    it('says when a search finds nothing', () => {
      renderSection('models', { huggingFace: browse({ llm: { query: 'zzz' } }) })
      expect(screen.getByText('No models match “zzz”.')).toBeInTheDocument()
    })

    it('counts newer models that need a Minute update in one quiet line', () => {
      renderSection('models', { huggingFace: browse({ llm: { result: answer({ unsupportedCount: 3 }) } }) })
      expect(screen.getByText('3 newer models need a Minute update.')).toBeInTheDocument()
    })
  })

  describe('Integrations (Obsidian)', () => {
    const configured = { ...DEFAULT_OBSIDIAN_SETTINGS, enabled: true, vaultPath: '/Users/test/Vault' }

    it('turns the integration on and off through the save surface', async () => {
      const onSaveObsidian = vi.fn().mockResolvedValue(null)
      renderSection('integrations', { onSaveObsidian })
      fireEvent.click(screen.getByRole('switch', { name: 'Save summaries to Obsidian' }))
      expect(onSaveObsidian).toHaveBeenCalledWith({ enabled: true })
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })

    it('shows the reason inline when turning it on is refused', async () => {
      const onSaveObsidian = vi.fn().mockResolvedValue('Choose your Obsidian vault folder in Settings.')
      renderSection('integrations', { onSaveObsidian })
      fireEvent.click(screen.getByRole('switch', { name: 'Save summaries to Obsidian' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Choose your Obsidian vault folder in Settings.')
    })

    it('saves a typed vault path when the field loses focus and shows a refusal inline', async () => {
      const onSaveObsidian = vi.fn().mockResolvedValue('The vault folder /nope does not exist. Check the path in Settings.')
      renderSection('integrations', { obsidian: configured, onSaveObsidian })
      const field = screen.getByLabelText('Vault')
      fireEvent.change(field, { target: { value: '/nope' } })
      fireEvent.blur(field)
      expect(onSaveObsidian).toHaveBeenCalledWith({ vaultPath: '/nope' })
      expect(await screen.findByRole('alert')).toHaveTextContent('does not exist')
      expect(field).toHaveAttribute('aria-invalid', 'true')
    })

    it('does not save an unchanged field', () => {
      const onSaveObsidian = vi.fn().mockResolvedValue(null)
      renderSection('integrations', { obsidian: configured, onSaveObsidian })
      fireEvent.blur(screen.getByLabelText('Folder'))
      expect(onSaveObsidian).not.toHaveBeenCalled()
    })

    it('saves the vault the folder picker returns, and nothing when it is cancelled', async () => {
      const onSaveObsidian = vi.fn().mockResolvedValue(null)
      const onChooseObsidianVault = vi.fn().mockResolvedValueOnce('/Users/test/Notes').mockResolvedValueOnce(null)
      renderSection('integrations', { onSaveObsidian, onChooseObsidianVault })
      fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
      await waitFor(() => expect(onSaveObsidian).toHaveBeenCalledWith({ vaultPath: '/Users/test/Notes' }))
      onSaveObsidian.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
      await waitFor(() => expect(onChooseObsidianVault).toHaveBeenCalledTimes(2))
      expect(onSaveObsidian).not.toHaveBeenCalled()
    })

    it('warns about a vault that has gone missing while the integration is on', async () => {
      const onCheckObsidianVault = vi.fn().mockResolvedValue('The vault folder /Users/test/Vault does not exist. Check the path in Settings.')
      renderSection('integrations', { obsidian: configured, onCheckObsidianVault })
      expect(await screen.findByRole('alert')).toHaveTextContent('does not exist')
      expect(onCheckObsidianVault).toHaveBeenCalledWith('/Users/test/Vault')
    })

    it('does not check the vault while the integration is off', () => {
      const onCheckObsidianVault = vi.fn().mockResolvedValue(null)
      renderSection('integrations', { obsidian: { ...configured, enabled: false }, onCheckObsidianVault })
      expect(onCheckObsidianVault).not.toHaveBeenCalled()
    })

    it('shows why the folder picker did not open under the Vault field', async () => {
      const onSaveObsidian = vi.fn().mockResolvedValue(null)
      const onChooseObsidianVault = vi.fn().mockRejectedValue(new Error('dialog plugin unavailable'))
      renderSection('integrations', { onSaveObsidian, onChooseObsidianVault })
      fireEvent.click(screen.getByRole('button', { name: 'Choose…' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('The folder picker did not open. dialog plugin unavailable')
      expect(screen.getByLabelText('Vault')).toHaveAccessibleDescription(/did not open/)
      expect(onSaveObsidian).not.toHaveBeenCalled()
    })

    // The saved file is named for the local day. A UTC date is a day off
    // for a recording made late in the evening west of Greenwich, or early
    // in the morning east of it, so this covers both ends of one local day.
    it.each([
      ['just after local midnight', new Date(2026, 10, 9, 0, 20)],
      ['just before local midnight', new Date(2026, 10, 9, 23, 40)],
    ])('dates the preview by the local day for a note made %s', (_when, createdAt) => {
      renderSection('integrations', { obsidianPreviewNote: { title: 'Aurora launch sync', createdAt: createdAt.toISOString() } })
      expect(screen.getByTestId('obsidian-preview')).toHaveTextContent('Meetings/2026-11-09 - Aurora launch sync.md')
    })

    it('previews the file name live from the folder and template as they are typed', () => {
      renderSection('integrations', { obsidianPreviewNote: { title: 'Aurora launch sync', createdAt: new Date(2026, 10, 9, 10, 2).toISOString() } })
      const preview = screen.getByTestId('obsidian-preview')
      expect(preview).toHaveTextContent('Meetings/2026-11-09 - Aurora launch sync.md')

      fireEvent.change(screen.getByLabelText('File name'), { target: { value: '{title}' } })
      expect(preview).toHaveTextContent('Meetings/Aurora launch sync.md')
      fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Work/Notes' } })
      expect(preview).toHaveTextContent('Work/Notes/Aurora launch sync.md')
    })

    it('flags a folder that leaves the vault', () => {
      renderSection('integrations')
      fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '../out' } })
      expect(screen.getByRole('alert')).toHaveTextContent('The folder cannot contain “..”.')
      expect(screen.getByTestId('obsidian-preview')).toHaveTextContent('—')
    })

    it('saves the two note options', () => {
      const onSaveObsidian = vi.fn().mockResolvedValue(null)
      renderSection('integrations', { onSaveObsidian })
      fireEvent.click(screen.getByRole('switch', { name: 'Add properties' }))
      expect(onSaveObsidian).toHaveBeenCalledWith({ addProperties: false })
      fireEvent.click(screen.getByRole('switch', { name: 'Include the transcript' }))
      expect(onSaveObsidian).toHaveBeenCalledWith({ includeTranscript: true })
    })

    it('shows the last saved note only once one was saved', () => {
      const { unmount } = renderSection('integrations')
      expect(screen.queryByText(/Last saved/)).not.toBeInTheDocument()
      unmount()
      renderSection('integrations', { obsidianLastSave: { title: 'Aurora launch sync', savedAt: new Date().toISOString() } })
      expect(screen.getByText(/Last saved: Aurora launch sync, (today|yesterday) at \d\d:\d\d/)).toBeInTheDocument()
    })
  })

  describe('Storage', () => {
    it('renders the real storage stats, the total, and the note count', () => {
      renderSection('storage')
      expect(screen.getByText(/Models 6.4 GB/)).toBeInTheDocument()
      expect(screen.getByText(/Audio 4.1 GB/)).toBeInTheDocument()
      expect(screen.getByText(/Notes and transcripts 1.9 GB/)).toBeInTheDocument()
      expect(screen.getByText('12.4 GB on this Mac')).toBeInTheDocument()
      expect(screen.getByText('14 notes')).toBeInTheDocument()
    })

    it('wires the delete-audio switch and reflects its state', () => {
      const toggleDel = vi.fn()
      renderSection('storage', { toggleDel })
      const toggle = screen.getByRole('switch', { name: 'Delete audio after 30 days' })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(toggle)
      expect(toggleDel).toHaveBeenCalledTimes(1)
    })

    it('shows a passive FileVault line instead of an encryption switch', () => {
      renderSection('storage')
      expect(screen.getByText(/Your library inherits FileVault full-disk encryption\./)).toBeInTheDocument()
      expect(screen.queryByRole('switch', { name: /encrypt/i })).not.toBeInTheDocument()
    })

    it('defaults compression to Off and wires a pick', () => {
      const setCompressAudioAfterDays = vi.fn()
      renderSection('storage', { setCompressAudioAfterDays })
      const select = screen.getByRole('combobox', { name: 'Compress older audio' })
      expect(select).toHaveDisplayValue('Off')
      fireEvent.change(select, { target: { value: '2' } })
      expect(setCompressAudioAfterDays).toHaveBeenCalledWith(14)
    })

    it('returns compression to Off over an existing selection', () => {
      const setCompressAudioAfterDays = vi.fn()
      renderSection('storage', { compressAudioAfterDays: 30, setCompressAudioAfterDays })
      const select = screen.getByRole('combobox', { name: 'Compress older audio' })
      expect(select).toHaveDisplayValue('After 30 days')
      fireEvent.change(select, { target: { value: '0' } })
      expect(setCompressAudioAfterDays).toHaveBeenCalledWith(null)
    })

    it('shows the library path with a working Change… button, and progress while moving', () => {
      const onChangeLibraryFolder = vi.fn().mockResolvedValue(undefined)
      renderSection('storage', { onChangeLibraryFolder })
      expect(screen.getByText('~/Library/Application Support/dev.minute.app')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
      expect(onChangeLibraryFolder).toHaveBeenCalledTimes(1)
      cleanup()
      renderSection('storage', { movingLibrary: true })
      expect(screen.getByRole('button', { name: 'Moving…' })).toBeDisabled()
    })

    it('exports a privacy-safe diagnostics report', () => {
      const onExportDiagnostics = vi.fn().mockResolvedValue(undefined)
      renderSection('storage', { onExportDiagnostics })
      expect(screen.getByText(/never includes note titles/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))
      expect(onExportDiagnostics).toHaveBeenCalledTimes(1)
    })

    describe('usage bar segments', () => {
      it('floors tiny non-zero categories so they stay visible next to multi-GB models', () => {
        const segments = storageBarSegments(3_200_000_000, 7_000_000, 7_600)
        const byKey = Object.fromEntries(segments.map(s => [s.key, s.pct]))
        expect(byKey.audio).toBeGreaterThanOrEqual(1.5)
        expect(byKey.notes).toBeGreaterThanOrEqual(1.5)
        expect(byKey.models).toBeGreaterThan(90)
        expect(segments.reduce((acc, s) => acc + s.pct, 0)).toBeLessThanOrEqual(100.0001)
      })

      it('keeps true proportions when no category is tiny, and zero stays zero', () => {
        const balanced = storageBarSegments(500, 300, 200)
        expect(balanced.map(s => [s.key, Math.round(s.pct)])).toEqual([['audio', 30], ['models', 50], ['notes', 20]])
        expect(storageBarSegments(1_000, 0, 1_000).find(s => s.key === 'audio')?.pct).toBe(0)
      })
    })
  })

  describe('About', () => {
    it('shows the version in the heading and a Check now button when up to date', () => {
      renderSection('about')
      expect(screen.getByRole('heading', { level: 1, name: 'Minute 1.3.0' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
    })

    it('wires Check now and shows the checking state', () => {
      const onCheckForUpdates = vi.fn()
      renderSection('about', { onCheckForUpdates })
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
      expect(onCheckForUpdates).toHaveBeenCalledTimes(1)
      cleanup()
      renderSection('about', { updateCheckStatus: 'checking' })
      expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    })

    it('offers Update & restart when an update is available, and disables it while installing', () => {
      const onInstallUpdate = vi.fn()
      renderSection('about', { updateAvailable: { version: '1.4.0' }, onInstallUpdate })
      fireEvent.click(screen.getByRole('button', { name: 'Update to 1.4.0 & restart' }))
      expect(onInstallUpdate).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
      cleanup()
      renderSection('about', { updateAvailable: { version: '1.4.0' }, updateInstalling: true })
      expect(screen.getByRole('button', { name: 'Installing…' })).toBeDisabled()
    })

    it('reports the up-to-date and error outcomes of a manual check', () => {
      renderSection('about', { updateCheckStatus: 'upToDate' })
      expect(screen.getByText('You’re on the latest version.')).toBeInTheDocument()
      cleanup()
      renderSection('about', { updateCheckStatus: 'error' })
      expect(screen.getByText('Couldn’t reach GitHub — try again later.')).toBeInTheDocument()
    })

    it('wires the automatic-check switch', () => {
      const toggleAutoUpdateCheck = vi.fn()
      renderSection('about', { toggleAutoUpdateCheck })
      fireEvent.click(screen.getByRole('switch', { name: 'Check for updates automatically' }))
      expect(toggleAutoUpdateCheck).toHaveBeenCalledTimes(1)
    })

    it('lists the keyboard shortcuts the app handles', () => {
      renderSection('about')
      const list = screen.getByRole('list', { name: 'Keyboard shortcuts' })
      expect(within(list).getByText('Search notes and transcripts')).toBeInTheDocument()
      expect(within(list).getByText('⌘K or ⌘F')).toBeInTheDocument()
      expect(within(list).getByText('Stop and transcribe')).toBeInTheDocument()
    })
  })
})
