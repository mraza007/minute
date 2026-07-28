// Backend stand-in for the screenshot harness — installs the same
// `mockIPC`/event-mocking machinery src/state/useAppState.test.ts's
// `setupIPC` uses, wired to curated marketing data (demoData.ts) instead of
// test fixtures. Reused pattern, not reused code: the test helper lives in a
// `.test.ts` file (not importable from app code) and is shaped around
// per-test override options this harness doesn't need — scenario selection
// here is a single `state` string instead.

import { mockIPC } from '@tauri-apps/api/mocks'
import type { ModelStatus, NoteMeta, NoteWithTranscript, SpeakerMergeUndo, StoredSegment, SummaryDoc } from '../ipc/types'
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

export type ScreenshotState = 'note' | 'recording' | 'preflight' | 'palette' | 'settings' | 'onboarding' | 'popup'

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

function noteWithTranscript(meta: NoteMeta, transcriptOverride?: StoredSegment[]): NoteWithTranscript {
  if (meta.id === AURORA_NOTE_ID) {
    return {
      meta,
      transcript: { segments: transcriptOverride ?? AURORA_TRANSCRIPT },
      summary: AURORA_SUMMARY satisfies SummaryDoc,
      markdown: AURORA_MARKDOWN,
      audioPath: '/Users/demo/Library/Application Support/Minute/notes/note-aurora/audio.wav',
    }
  }
  return {
    meta,
    transcript: { segments: transcriptOverride ?? fallbackTranscriptFor(meta.id) },
    summary: null,
    markdown: `# ${meta.title}\n\n(Not summarized in this demo.)`,
    audioPath: null,
  }
}

/** Installs the mocked Tauri IPC surface for `state` — call once, before mounting `<App/>`. */
export function installMockIpc(state: ScreenshotState, params = new URLSearchParams()): void {
  const models = buildModels(state)
  const notes = [...NOTES]
  const transcriptOverrides = new Map<string, StoredSegment[]>()

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
          return noteWithTranscript(meta, transcriptOverrides.get(meta.id))
        }
        case 'search_notes':
          return PRICING_SEARCH_HITS
        case 'rename_note': {
          const { id, title } = args as { id: string; title: string }
          const match = notes.find(n => n.id === id) ?? notes[0]
          return { ...match, title }
        }
        case 'set_note_pinned': {
          const { id, pinned } = args as { id: string; pinned: boolean }
          const index = notes.findIndex(note => note.id === id)
          const match = index >= 0 ? notes[index] : notes[0]
          const updated = { ...match, pinned }
          if (index >= 0) notes[index] = updated
          return updated
        }
        case 'add_note_marker': {
          const { id, seconds, label } = args as { id: string; seconds: number; label: string }
          const index = notes.findIndex(note => note.id === id)
          const match = index >= 0
            ? notes[index]
            : {
                ...notes[0],
                id,
                title: 'Weekly product review',
                markers: [],
              }
          const markers = [...(match.markers ?? []), { seconds, label }].sort((a, b) => a.seconds - b.seconds)
          const updated = { ...match, markers }
          if (index >= 0) notes[index] = updated
          return updated
        }
        case 'update_note_marker': {
          const { id, index: markerIndex, label } = args as { id: string; index: number; label: string }
          const index = notes.findIndex(note => note.id === id)
          const match = index >= 0 ? notes[index] : notes[0]
          const updated = {
            ...match,
            markers: (match.markers ?? []).map((marker, index) => (
              index === markerIndex ? { ...marker, label } : marker
            )),
          }
          if (index >= 0) notes[index] = updated
          return updated
        }
        case 'delete_note_marker': {
          const { id, index: markerIndex } = args as { id: string; index: number }
          const index = notes.findIndex(note => note.id === id)
          const match = index >= 0 ? notes[index] : notes[0]
          const updated = {
            ...match,
            markers: (match.markers ?? []).filter((_, index) => index !== markerIndex),
          }
          if (index >= 0) notes[index] = updated
          return updated
        }
        case 'rename_speaker': {
          const { id, from, to } = args as { id: string; from: string; to: string }
          const meta = notes.find(note => note.id === id) ?? notes[0]
          const segments = noteWithTranscript(meta, transcriptOverrides.get(id)).transcript.segments.map(segment => (
              segment.speaker === from ? { ...segment, speaker: to } : segment
          ))
          transcriptOverrides.set(id, segments)
          return { segments }
        }
        case 'merge_speakers': {
          const { id, from, into } = args as { id: string; from: string; into: string }
          const noteIndex = notes.findIndex(note => note.id === id)
          const meta = noteIndex >= 0 ? notes[noteIndex] : notes[0]
          const current = noteWithTranscript(meta, transcriptOverrides.get(id)).transcript.segments
          const segmentIndices = current
            .map((segment, index) => segment.speaker === from ? index : -1)
            .filter(index => index >= 0)
          const segments = current.map((segment, index) => (
            segmentIndices.includes(index) ? { ...segment, speaker: into } : segment
          ))
          const updatedMeta = { ...meta, speakers: Math.max(1, meta.speakers - 1) }
          if (noteIndex >= 0) notes[noteIndex] = updatedMeta
          transcriptOverrides.set(id, segments)
          return {
            transcript: { segments },
            meta: updatedMeta,
            undo: { from, into, segmentIndices, checksum: 'screenshot-merge-checksum' },
          }
        }
        case 'undo_speaker_merge': {
          const { id, undo } = args as { id: string; undo: SpeakerMergeUndo }
          const noteIndex = notes.findIndex(note => note.id === id)
          const meta = noteIndex >= 0 ? notes[noteIndex] : notes[0]
          const current = noteWithTranscript(meta, transcriptOverrides.get(id)).transcript.segments
          const indices = new Set(undo.segmentIndices)
          const segments = current.map((segment, index) => (
            indices.has(index) ? { ...segment, speaker: undo.from } : segment
          ))
          const updatedMeta = { ...meta, speakers: meta.speakers + 1 }
          if (noteIndex >= 0) notes[noteIndex] = updatedMeta
          transcriptOverrides.set(id, segments)
          return { transcript: { segments }, meta: updatedMeta }
        }
        case 'delete_note': {
          const { id } = args as { id: string }
          const index = notes.findIndex(note => note.id === id)
          const [deleted] = index >= 0 ? notes.splice(index, 1) : [notes[0]]
          return { id, title: deleted.title, trashName: `${id}-demo`, checksum: 'demo-recovery' }
        }
        case 'delete_notes': {
          const { ids } = args as { ids: string[] }
          return ids.map(id => {
            const index = notes.findIndex(note => note.id === id)
            const [deleted] = index >= 0 ? notes.splice(index, 1) : [notes[0]]
            return { id, title: deleted.title, trashName: `${id}-demo`, checksum: 'demo-recovery' }
          })
        }
        case 'restore_note':
        case 'restore_notes':
          return []
        case 'export_notes':
          return '/Users/demo/Exports/minute-export'
        case 'export_diagnostics':
          return '/Users/demo/Diagnostics/minute-diagnostics.json'
        case 'note_storage_stats':
          return { totalBytes: 68_000_000, audioBytes: 64_000_000, documentBytes: 4_000_000 }
        case 'delete_note_audio': {
          const { id } = args as { id: string }
          const index = notes.findIndex(note => note.id === id)
          const updated = { ...(index >= 0 ? notes[index] : notes[0]), audioDeleted: true }
          if (index >= 0) notes[index] = updated
          return updated
        }
        case 'reveal_note':
          return null
        case 'storage_stats':
          return STORAGE
        case 'audio_input_status':
          return {
            devices: [
              { id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true },
              { id: 'studio', name: 'Studio Display Microphone', isDefault: false },
            ],
            defaultDeviceId: 'built-in',
            permission: 'authorized',
          }
        case 'request_microphone_permission':
          return 'authorized'
        case 'start_audio_input_preview':
        case 'stop_audio_input_preview':
          return null
        case 'start_recording':
          return 'note-recording-live'
        case 'pause_recording':
        case 'resume_recording':
          return null
        case 'stop_recording':
          if (params.get('processing')) return new Promise(() => {})
          return notes[0]
        case 'get_settings':
          return SETTINGS
        case 'set_settings':
          return SETTINGS
        case 'sys_audio_status':
        case 'request_sys_audio_permission':
          // Marketing screenshots don't exercise the Grant-permission flow —
          // reporting 'ready' here just shows the "Capture system audio"
          // toggle in its ordinary, enabled state, same as `SETTINGS`'
          // `captureSystemAudio: false` shows it off but interactive.
          return { availability: 'ready' }
        case 'summarize_note':
          return null
        case 'toggle_action_item': {
          const { id } = args as { id: string; index: number; done: boolean }
          const meta = notes.find(n => n.id === id) ?? notes[0]
          return noteWithTranscript(meta).summary
        }
        case 'ask_note':
          return null
        case 'popup_start':
        case 'popup_dismiss':
          // The `popup` marketing shot never clicks through (nothing to
          // navigate to in this dev-only harness) — mocked just so Pill's
          // click handlers don't throw if the capture script or a stray
          // interaction ever calls them.
          return null
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}
