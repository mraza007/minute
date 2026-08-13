import axe from 'axe-core'
import { mockIPC } from '@tauri-apps/api/mocks'
import { fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react'
import App from './App'
import type {
  Hardware,
  ModelStatus,
  NoteMeta,
  NoteWithTranscript,
  Recommendation,
  Settings,
  StorageStats,
} from './ipc/types'

const hardware: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
const recommendation: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
const storage: StorageStats = { modelsBytes: 500_000_000, audioBytes: 200_000_000, notesBytes: 100_000_000 }
const settings: Settings = {
  sttModel: 'whisper-small',
  llmModel: 'qwen3.5-4b',
  deleteAudioAfter30d: true,
  meetingDetection: false,
  captureSystemAudio: false,
  libraryRoot: null,
  llmContextTokens: null,
  summaryStyle: 'standard',
  summaryInstructions: '',
  autoUpdateCheck: true,
  detectSpeakers: false,
  autoStopRecording: true,
  compressAudioAfterDays: null,
  speakerProfiles: false,
  autoApplySpeakerNames: true,
}

function model(kind: 'stt' | 'llm', installed: boolean): ModelStatus {
  const stt = kind === 'stt'
  return {
    id: stt ? 'whisper-small' : 'qwen3.5-4b',
    kind,
    displayName: stt ? 'Whisper small' : 'Qwen3.5-4B',
    desc: stt ? 'good for meetings' : 'fast default summarizer',
    url: `https://example.com/${kind}.bin`,
    sha256: (stt ? 'a' : 'b').repeat(64),
    sizeBytes: stt ? 466_000_000 : 2_600_000_000,
    minRamGb: stt ? 0 : 8,
    requiresAppleSilicon: false,
    state: installed ? 'installed' : 'notInstalled',
  }
}

const note: NoteMeta = {
  id: '20260722-120000',
  title: 'Client call — Acme',
  createdAt: '2026-07-22T12:00:00.000Z',
  durationSec: 180,
  model: 'whisper-small',
  status: 'ready',
  speakers: 2,
  audioDeleted: false,
  sources: ['mic'],
  pinned: true,
  markers: [{ seconds: 94, label: 'Pricing decision' }],
}

const noteDetail: NoteWithTranscript = {
  meta: note,
  transcript: {
    segments: [
      { speaker: 'You', start: 0, end: 10, text: 'Opening context.' },
      { speaker: 'Sam', start: 94, end: 110, text: 'The team approved the pricing change.' },
    ],
  },
  summary: {
    summary: 'The team approved the pricing change.',
    topics: [],
    decisions: ['Ship the new pricing on Friday.'],
    actionItems: [{ text: 'Write the release note.', done: false }],
  },
  markdown: '# Client call — Acme',
  audioPath: null,
}

function installIpc({ installed = true }: { installed?: boolean } = {}) {
  const models = [model('stt', installed), model('llm', installed)]
  mockIPC(
    (cmd, args) => {
      switch (cmd) {
        case 'list_models':
          return models
        case 'list_notes':
          return [note]
        case 'hardware_info':
          return hardware
        case 'recommended_models':
          return recommendation
        case 'storage_stats':
          return storage
        case 'note_storage_stats':
          return { totalBytes: 12_000, audioBytes: 10_000, documentBytes: 2_000 }
        case 'get_settings':
        case 'set_settings':
          return settings
        case 'get_note':
          return noteDetail
        case 'audio_input_status':
          return {
            devices: [{ id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true }],
            defaultDeviceId: 'built-in',
            permission: 'authorized',
          }
        case 'request_microphone_permission':
          return 'authorized'
        case 'sys_audio_status':
          return { availability: 'ready' }
        case 'start_audio_input_preview':
        case 'stop_audio_input_preview':
          return null
        case 'start_recording':
          return '20260722-130000'
        case 'search_notes':
          return []
        case 'toggle_action_item':
          return noteDetail.summary
        case 'set_note_pinned':
        case 'update_note_marker':
        case 'delete_note_marker':
          return note
        case 'rename_speaker':
          return noteDetail.transcript
        case 'rename_note': {
          const { title } = args as { title: string }
          return { ...note, title }
        }
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}

async function expectNoAccessibilityViolations(view: RenderResult) {
  const result = await axe.run(view.container, {
    rules: {
      // jsdom has no layout or canvas implementation, so axe cannot compute
      // real contrast here. Contrast remains part of the visual/manual matrix.
      'color-contrast': { enabled: false },
    },
  })
  const details = result.violations
    .map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`)
    .join('\n')
  expect(result.violations, details).toHaveLength(0)
}

describe('core flow accessibility', () => {
  it('checks the library and transcript workspace', async () => {
    installIpc()
    const view = render(<App />)
    await screen.findByRole('heading', { name: note.title })
    await screen.findByText('Opening context.')
    await expectNoAccessibilityViolations(view)
  })

  it('checks the post-recording overview and marker actions', async () => {
    installIpc()
    const view = render(<App />)
    await screen.findByRole('heading', { name: note.title })
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    await screen.findByText('Pricing decision')
    await expectNoAccessibilityViolations(view)
  })

  it('checks the inline speaker merge confirmation', async () => {
    installIpc()
    const view = render(<App />)
    await screen.findByRole('heading', { name: note.title })
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter transcript by speaker' }), {
      target: { value: 'You' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Merge speaker' }))
    await screen.findByRole('combobox', { name: 'Merge into speaker' })
    await expectNoAccessibilityViolations(view)
  })

  it('checks the recording preflight', async () => {
    installIpc()
    const view = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New recording' }))
    await screen.findByRole('dialog', { name: 'Ready to record' })
    await expectNoAccessibilityViolations(view)
  })

  it('checks the active recording workspace', async () => {
    installIpc()
    const view = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'New recording' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start recording' }))
    await screen.findByText('Live transcript — audio never leaves this machine')
    await expectNoAccessibilityViolations(view)
  })

  it('checks settings', async () => {
    installIpc()
    const view = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    await screen.findByRole('radiogroup', { name: 'Transcription model' })
    await expectNoAccessibilityViolations(view)
  })

  it('checks the keyboard shortcut reference dialog', async () => {
    installIpc()
    const view = render(<App />)
    await screen.findByRole('heading', { name: note.title })
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    await expectNoAccessibilityViolations(view)
  })

  it('checks onboarding', async () => {
    installIpc({ installed: false })
    const view = render(<App />)
    await waitFor(() => expect(screen.getByText('Minute runs entirely on this Mac.')).toBeInTheDocument())
    await expectNoAccessibilityViolations(view)
  })
})
