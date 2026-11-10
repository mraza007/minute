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
  SAM_NOTE_ID,
  SETTINGS,
  SETTINGS_SHOWCASE,
  STORAGE,
  VOICE_PROFILES,
} from './demoData'

export type ScreenshotState = 'note' | 'recording' | 'preflight' | 'messages' | 'palette' | 'settings' | 'onboarding' | 'popup' | 'empty'

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

function noteWithTranscript(meta: NoteMeta, transcriptOverride?: StoredSegment[], summarized = true): NoteWithTranscript {
  if (meta.id === AURORA_NOTE_ID) {
    return {
      meta,
      transcript: { segments: transcriptOverride ?? AURORA_TRANSCRIPT },
      summary: summarized ? AURORA_SUMMARY satisfies SummaryDoc : null,
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
  const notes = state === 'empty' ? [] : [...NOTES]
  const transcriptOverrides = new Map<string, StoredSegment[]>()
  // `?turns=<n>` swaps in a long synthetic Aurora transcript, to exercise the
  // virtualized transcript inside the note page's scroll container.
  const turns = Number(params.get('turns') ?? 0)
  if (turns > 0) {
    const speakers = ['You', 'Marcus Chen', 'Speaker 3']
    transcriptOverrides.set(
      AURORA_NOTE_ID,
      Array.from({ length: turns }, (_, index) => ({
        speaker: speakers[index % speakers.length],
        start: index * 4,
        end: index * 4 + 3,
        text: `Turn ${index + 1}. ${'A longer remark that wraps onto a second line when it has enough words in it. '.repeat(index % 3)}`.trim(),
      })),
    )
  }
  // `?summary=queued` leaves Aurora unsummarized, with the Detailed length
  // chosen, for the "This summary has waited" card.
  const summaryQueued = params.get('summary') === 'queued'
  // `?suggest=1` gives the unnamed Aurora speaker a voice-profile match, for
  // the speaker popover's "Sounds like" row.
  if (params.get('suggest') === '1') {
    const index = notes.findIndex(note => note.id === AURORA_NOTE_ID)
    if (index >= 0) {
      notes[index] = { ...notes[index], speakerSuggestions: { 'Speaker 3': { name: 'Priya Shah', similarity: 0.82 } } }
    }
  }

  mockIPC(
    (cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      switch (cmd) {
        case 'plugin:app|version':
          return '1.12.1'
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
          return noteWithTranscript(meta, transcriptOverrides.get(meta.id), !summaryQueued)
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
        case 'merge_speakers':
        case 'mark_speaker_unknown': {
          const { id, from, into, speaker } = args as { id: string; from?: string; into?: string; speaker?: string }
          const source = from ?? speaker ?? ''
          const target = into ?? null
          const noteIndex = notes.findIndex(note => note.id === id)
          const meta = noteIndex >= 0 ? notes[noteIndex] : notes[0]
          const current = noteWithTranscript(meta, transcriptOverrides.get(id)).transcript.segments
          const segmentIndices = current
            .map((segment, index) => segment.speaker === source ? index : -1)
            .filter(index => index >= 0)
          const segments = current.map((segment, index) => (
            segmentIndices.includes(index) ? { ...segment, speaker: target } : segment
          ))
          const updatedMeta = { ...meta, speakers: Math.max(1, meta.speakers - 1) }
          if (noteIndex >= 0) notes[noteIndex] = updatedMeta
          transcriptOverrides.set(id, segments)
          return {
            transcript: { segments },
            meta: updatedMeta,
            undo: {
              from: source,
              into: target,
              segmentIndices,
              summaryMentions: [],
              summaryFingerprint: null,
              checksum: 'screenshot-merge-checksum',
            },
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
        case 'save_note_to_obsidian': {
          const { id } = args as { id: string }
          return notes.find(note => note.id === id)?.obsidian ?? {}
        }
        case 'storage_stats':
          return STORAGE
        case 'library_info':
          return {
            path: '/Users/sam/Library/Application Support/dev.minute.app',
            displayPath: '~/Library/Application Support/dev.minute.app',
            isDefault: true,
          }
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
          // `processing=note` lands on a note with no summary yet, so its
          // page shows the steps still running. Any other value holds on Stop.
          if (params.get('processing') === 'note') return notes.find(note => note.id === SAM_NOTE_ID) ?? notes[0]
          if (params.get('processing')) return new Promise(() => {})
          return notes[0]
        case 'get_settings':
          if (summaryQueued) return { ...SETTINGS, summaryStyle: 'detailed' }
          return state === 'settings' ? SETTINGS_SHOWCASE : SETTINGS
        case 'set_settings':
          return state === 'settings' ? SETTINGS_SHOWCASE : SETTINGS
        case 'list_voice_profiles':
          return state === 'settings' ? VOICE_PROFILES : []
        case 'check_obsidian_vault':
          // `?vault=missing` shows how the Integrations section reports a vault that moved.
          if (params.get('vault') === 'missing') {
            // The backend rejects with a plain string, not an Error.
            throw 'The vault folder /Users/demo/Vault does not exist. Check the path in Settings.'
          }
          return null
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
        case 'popup_stop':
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
