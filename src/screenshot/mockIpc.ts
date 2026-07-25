// Backend stand-in for the screenshot harness — installs the same
// `mockIPC`/event-mocking machinery src/state/useAppState.test.ts's
// `setupIPC` uses, wired to curated marketing data (demoData.ts) instead of
// test fixtures. Reused pattern, not reused code: the test helper lives in a
// `.test.ts` file (not importable from app code) and is shaped around
// per-test override options this harness doesn't need — scenario selection
// here is a single `state` string instead.

import { mockIPC } from '@tauri-apps/api/mocks'
import type { ModelStatus, NoteMeta, NoteWithTranscript, SummaryDoc } from '../ipc/types'
import {
  AURORA_MARKDOWN,
  AURORA_NOTE_ID,
  AURORA_SUMMARY,
  AURORA_TRANSCRIPT,
  CATALOG,
  fallbackTranscriptFor,
  HARDWARE,
  NOTES,
  PRICING_SEARCH_HITS,
  RECOMMENDATION,
  SETTINGS,
  STORAGE,
} from './demoData'

export type ScreenshotState = 'note' | 'recording' | 'palette' | 'settings' | 'onboarding'

function buildModels(state: ScreenshotState): ModelStatus[] {
  const onboarding = state === 'onboarding'
  return CATALOG.map(entry => {
    if (onboarding) return { ...entry, state: 'notInstalled' as const }
    // Realistic mixed install state for the Settings/model-manager shot:
    // recommended pair installed + in use, one extra STT tier installed,
    // the rest available to download.
    if (entry.id === 'whisper-small' || entry.id === 'whisper-medium' || entry.id === 'qwen3.5-4b') {
      return { ...entry, state: 'installed' as const }
    }
    return { ...entry, state: 'notInstalled' as const }
  })
}

function noteWithTranscript(meta: NoteMeta): NoteWithTranscript {
  if (meta.id === AURORA_NOTE_ID) {
    return {
      meta,
      transcript: { segments: AURORA_TRANSCRIPT },
      summary: AURORA_SUMMARY satisfies SummaryDoc,
      markdown: AURORA_MARKDOWN,
      audioPath: '/Users/demo/Library/Application Support/Minute/notes/note-aurora/audio.wav',
    }
  }
  return {
    meta,
    transcript: { segments: fallbackTranscriptFor(meta.id) },
    summary: null,
    markdown: `# ${meta.title}\n\n(Not summarized in this demo.)`,
    audioPath: null,
  }
}

/** Installs the mocked Tauri IPC surface for `state` — call once, before mounting `<App/>`. */
export function installMockIpc(state: ScreenshotState): void {
  const models = buildModels(state)
  const notes = [...NOTES]

  mockIPC(
    (cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      switch (cmd) {
        case 'hardware_info':
          return HARDWARE
        case 'list_models':
          return models
        case 'recommended_models':
          return RECOMMENDATION
        case 'download_model':
        case 'cancel_download':
        case 'delete_model':
          return null
        case 'list_notes':
          return notes
        case 'get_note': {
          const { id } = args as { id: string }
          const meta = notes.find(n => n.id === id) ?? notes[0]
          return noteWithTranscript(meta)
        }
        case 'search_notes':
          return PRICING_SEARCH_HITS
        case 'rename_note': {
          const { id, title } = args as { id: string; title: string }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return { ...match, title }
        }
        case 'delete_note':
        case 'reveal_note':
          return null
        case 'storage_stats':
          return STORAGE
        case 'start_recording':
          return 'note-recording-live'
        case 'pause_recording':
        case 'resume_recording':
          return null
        case 'stop_recording':
          return notes[0]
        case 'get_settings':
          return SETTINGS
        case 'set_settings':
          return SETTINGS
        case 'summarize_note':
          return null
        case 'toggle_action_item': {
          const { id } = args as { id: string; index: number; done: boolean }
          const meta = notes.find(n => n.id === id) ?? notes[0]
          return noteWithTranscript(meta).summary
        }
        case 'ask_note':
          return null
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}
