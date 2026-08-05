import { mockIPC } from '@tauri-apps/api/mocks'
import { beforeEach, describe, expect, it } from 'vitest'
import * as commands from './commands'
import type { AudioInputStatus, Hardware, ModelStatus, NoteMeta, NoteWithTranscript, Recommendation, SearchHit, Settings, StorageStats, SummaryDoc, SysAudioStatus } from './types'

/** Captures the last `(cmd, args)` pair the mocked IPC bridge saw. */
function captureIPC(response: (cmd: string, args: unknown) => unknown = () => null) {
  const calls: Array<{ cmd: string; args: unknown }> = []
  mockIPC((cmd, args) => {
    calls.push({ cmd, args })
    return response(cmd, args)
  })
  return calls
}

describe('ipc/commands', () => {
  beforeEach(() => {
    // clearMocks() also runs in the global afterEach (src/test/setup.ts);
    // nothing extra needed here.
  })

  it('hardwareInfo invokes hardware_info with no args', async () => {
    const hw: Hardware = { totalRamGb: 16, appleSilicon: true, cores: 8 }
    const calls = captureIPC(() => hw)

    const result = await commands.hardwareInfo()

    expect(calls).toHaveLength(1)
    expect(calls[0].cmd).toBe('hardware_info')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(hw)
  })

  it('listModels invokes list_models and passes through the fixture array', async () => {
    const fixture: ModelStatus[] = [
      {
        id: 'whisper-small',
        kind: 'stt',
        displayName: 'Whisper Small',
        desc: 'Fast, lightweight',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
        sha256: 'a'.repeat(64),
        sizeBytes: 488_000_000,
        minRamGb: 8,
        requiresAppleSilicon: false,
        state: 'installed',
      },
    ]
    const calls = captureIPC(() => fixture)

    const result = await commands.listModels()

    expect(calls[0].cmd).toBe('list_models')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(fixture)
  })

  it('recommendedModels invokes recommended_models', async () => {
    const rec: Recommendation = { stt: 'whisper-small', llm: 'qwen3.5-4b' }
    const calls = captureIPC(() => rec)

    const result = await commands.recommendedModels()

    expect(calls[0].cmd).toBe('recommended_models')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(rec)
  })

  it('downloadModel invokes download_model with { id }', async () => {
    const calls = captureIPC()

    await commands.downloadModel('whisper-medium')

    expect(calls[0].cmd).toBe('download_model')
    expect(calls[0].args).toEqual({ id: 'whisper-medium' })
  })

  it('cancelDownload invokes cancel_download with { id }', async () => {
    const calls = captureIPC()

    await commands.cancelDownload('whisper-medium')

    expect(calls[0].cmd).toBe('cancel_download')
    expect(calls[0].args).toEqual({ id: 'whisper-medium' })
  })

  it('deleteModel invokes delete_model with { id }', async () => {
    const calls = captureIPC()

    await commands.deleteModel('whisper-medium')

    expect(calls[0].cmd).toBe('delete_model')
    expect(calls[0].args).toEqual({ id: 'whisper-medium' })
  })

  it('listNotes invokes list_notes and passes through the fixture array', async () => {
    const fixture: NoteMeta[] = [
      {
        id: '20260722-120000',
        title: 'Client call — Acme',
        createdAt: '2026-07-22T12:00:00Z',
        durationSec: 1234.5,
        model: 'whisper-small',
        status: 'transcribed',
        speakers: 1,
        audioDeleted: false,
        sources: ['mic'],
      },
    ]
    const calls = captureIPC(() => fixture)

    const result = await commands.listNotes()

    expect(calls[0].cmd).toBe('list_notes')
    expect(result).toEqual(fixture)
  })

  it('getNote invokes get_note with { id } and passes through meta+transcript', async () => {
    const fixture: NoteWithTranscript = {
      meta: {
        id: '20260722-120000',
        title: 'Client call — Acme',
        createdAt: '2026-07-22T12:00:00Z',
        durationSec: 1234.5,
        model: 'whisper-small',
        status: 'transcribed',
        speakers: 1,
        audioDeleted: false,
        sources: ['mic'],
      },
      transcript: {
        segments: [{ speaker: 'Speaker 1', start: 0, end: 3.2, text: 'Hello there.' }],
      },
      summary: null,
      markdown: '# Client call — Acme',
      audioPath: '/notes/20260722-120000/audio.wav',
    }
    const calls = captureIPC(() => fixture)

    const result = await commands.getNote('20260722-120000')

    expect(calls[0].cmd).toBe('get_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000' })
    expect(result).toEqual(fixture)
  })

  it('searchNotes invokes search_notes with { query } and passes through the fixture hits', async () => {
    const fixture: SearchHit[] = [
      { noteId: '20260722-120000', title: 'Client call — Acme', snippet: 'Client call — Acme', segmentStart: null, kind: 'title' },
      { noteId: '20260722-120000', title: 'Client call — Acme', snippet: 'Let us discuss the roadmap next.', segmentStart: 12.5, kind: 'transcript' },
    ]
    const calls = captureIPC(() => fixture)

    const result = await commands.searchNotes('roadmap')

    expect(calls[0].cmd).toBe('search_notes')
    expect(calls[0].args).toEqual({ query: 'roadmap' })
    expect(result).toEqual(fixture)
  })

  it('renameNote invokes rename_note with { id, title }', async () => {
    const calls = captureIPC()

    await commands.renameNote('20260722-120000', 'Renamed title')

    expect(calls[0].cmd).toBe('rename_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000', title: 'Renamed title' })
  })

  it('setNotePinned invokes set_note_pinned with the requested state', async () => {
    const calls = captureIPC()

    await commands.setNotePinned('20260722-120000', true)

    expect(calls[0].cmd).toBe('set_note_pinned')
    expect(calls[0].args).toEqual({ id: '20260722-120000', pinned: true })
  })

  it('addNoteMarker invokes add_note_marker with timestamp and label', async () => {
    const calls = captureIPC()

    await commands.addNoteMarker('20260722-120000', 74.5, 'Pricing decision')

    expect(calls[0].cmd).toBe('add_note_marker')
    expect(calls[0].args).toEqual({
      id: '20260722-120000',
      seconds: 74.5,
      label: 'Pricing decision',
    })
  })

  it('updateNoteMarker invokes update_note_marker with index and label', async () => {
    const calls = captureIPC()

    await commands.updateNoteMarker('20260722-120000', 2, 'Updated decision')

    expect(calls[0].cmd).toBe('update_note_marker')
    expect(calls[0].args).toEqual({
      id: '20260722-120000',
      index: 2,
      label: 'Updated decision',
    })
  })

  it('deleteNoteMarker invokes delete_note_marker with the marker index', async () => {
    const calls = captureIPC()

    await commands.deleteNoteMarker('20260722-120000', 2)

    expect(calls[0].cmd).toBe('delete_note_marker')
    expect(calls[0].args).toEqual({ id: '20260722-120000', index: 2 })
  })

  it('renameSpeaker invokes rename_speaker with both speaker names', async () => {
    const calls = captureIPC()

    await commands.renameSpeaker('20260722-120000', 'Speaker 2', 'Sam')

    expect(calls[0].cmd).toBe('rename_speaker')
    expect(calls[0].args).toEqual({
      id: '20260722-120000',
      from: 'Speaker 2',
      to: 'Sam',
    })
  })

  it('mergeSpeakers invokes merge_speakers with source and destination', async () => {
    const calls = captureIPC()

    await commands.mergeSpeakers('20260722-120000', 'Speaker 2', 'Sam')

    expect(calls[0].cmd).toBe('merge_speakers')
    expect(calls[0].args).toEqual({
      id: '20260722-120000',
      from: 'Speaker 2',
      into: 'Sam',
    })
  })

  it('undoSpeakerMerge passes the exact backend-issued undo token', async () => {
    const calls = captureIPC()
    const undo = {
      from: 'Speaker 2',
      into: 'Sam',
      segmentIndices: [1, 4],
      checksum: 'merge-checksum',
    }

    await commands.undoSpeakerMerge('20260722-120000', undo)

    expect(calls[0].cmd).toBe('undo_speaker_merge')
    expect(calls[0].args).toEqual({ id: '20260722-120000', undo })
  })

  it('deleteNote invokes delete_note with { id }', async () => {
    const calls = captureIPC()

    await commands.deleteNote('20260722-120000')

    expect(calls[0].cmd).toBe('delete_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000' })
  })

  it('passes exact recovery, bulk, storage, and export command shapes', async () => {
    const calls = captureIPC()
    const undo = {
      id: '20260722-120000',
      title: 'Planning',
      trashName: '20260722-120000-1',
      checksum: 'recovery-checksum',
    }

    await commands.restoreNote(undo)
    await commands.deleteNotes(['note-a', 'note-b'])
    await commands.restoreNotes([undo])
    await commands.noteStorageStats('note-a')
    await commands.deleteNoteAudio('note-a')
    await commands.exportNotes(['note-a', 'note-b'])
    await commands.exportDiagnostics()

    expect(calls).toEqual([
      { cmd: 'restore_note', args: { undo } },
      { cmd: 'delete_notes', args: { ids: ['note-a', 'note-b'] } },
      { cmd: 'restore_notes', args: { undo: [undo] } },
      { cmd: 'note_storage_stats', args: { id: 'note-a' } },
      { cmd: 'delete_note_audio', args: { id: 'note-a' } },
      { cmd: 'export_notes', args: { ids: ['note-a', 'note-b'] } },
      { cmd: 'export_diagnostics', args: {} },
    ])
  })

  it('storageStats invokes storage_stats', async () => {
    const stats: StorageStats = { modelsBytes: 1000, audioBytes: 2000, notesBytes: 3000 }
    const calls = captureIPC(() => stats)

    const result = await commands.storageStats()

    expect(calls[0].cmd).toBe('storage_stats')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(stats)
  })

  it('audioInputStatus invokes audio_input_status and passes through selectable microphones', async () => {
    const status: AudioInputStatus = {
      devices: [{ id: 'studio', name: 'Studio Display Microphone', isDefault: true }],
      defaultDeviceId: 'studio',
      permission: 'authorized',
    }
    const calls = captureIPC(() => status)

    const result = await commands.audioInputStatus()

    expect(calls[0].cmd).toBe('audio_input_status')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(status)
  })

  it('requestMicrophonePermission invokes request_microphone_permission', async () => {
    const calls = captureIPC(() => 'authorized')

    const result = await commands.requestMicrophonePermission()

    expect(calls[0].cmd).toBe('request_microphone_permission')
    expect(calls[0].args).toEqual({})
    expect(result).toBe('authorized')
  })

  it('startRecording passes the explicit model and source choices', async () => {
    const calls = captureIPC(() => '20260722-130000')

    const result = await commands.startRecording('whisper-small', true, 'studio')

    expect(calls[0].cmd).toBe('start_recording')
    expect(calls[0].args).toEqual({
      modelId: 'whisper-small',
      includeSystemAudio: true,
      inputDeviceId: 'studio',
    })
    expect(result).toBe('20260722-130000')
  })

  it('starts and stops a token-scoped microphone preview', async () => {
    const calls = captureIPC()

    await commands.startAudioInputPreview('studio', 'preview-1')
    await commands.stopAudioInputPreview('preview-1')

    expect(calls).toEqual([
      {
        cmd: 'start_audio_input_preview',
        args: { inputDeviceId: 'studio', sessionId: 'preview-1' },
      },
      {
        cmd: 'stop_audio_input_preview',
        args: { sessionId: 'preview-1' },
      },
    ])
  })

  it('pauseRecording invokes pause_recording with no args', async () => {
    const calls = captureIPC()

    await commands.pauseRecording()

    expect(calls[0].cmd).toBe('pause_recording')
    expect(calls[0].args).toEqual({})
  })

  it('resumeRecording invokes resume_recording with no args', async () => {
    const calls = captureIPC()

    await commands.resumeRecording()

    expect(calls[0].cmd).toBe('resume_recording')
    expect(calls[0].args).toEqual({})
  })

  it('stopRecording invokes stop_recording and passes through the returned NoteMeta', async () => {
    const meta: NoteMeta = {
      id: '20260722-130000',
      title: 'New recording',
      createdAt: '2026-07-22T13:00:00Z',
      durationSec: 42,
      model: 'whisper-small',
      status: 'transcribed',
      speakers: 1,
      audioDeleted: false,
      sources: ['mic'],
    }
    const calls = captureIPC(() => meta)

    const result = await commands.stopRecording()

    expect(calls[0].cmd).toBe('stop_recording')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(meta)
  })

  it('popupStart invokes popup_start with no args', async () => {
    const calls = captureIPC()

    await commands.popupStart()

    expect(calls[0].cmd).toBe('popup_start')
    expect(calls[0].args).toEqual({})
  })

  it('popupDismiss invokes popup_dismiss with { timedOut }', async () => {
    const calls = captureIPC()

    await commands.popupDismiss(true)

    expect(calls[0].cmd).toBe('popup_dismiss')
    expect(calls[0].args).toEqual({ timedOut: true })
  })

  it('sysAudioStatus invokes sys_audio_status with no args and passes through the fixture', async () => {
    const status: SysAudioStatus = { availability: 'ready' }
    const calls = captureIPC(() => status)

    const result = await commands.sysAudioStatus()

    expect(calls[0].cmd).toBe('sys_audio_status')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(status)
  })

  it('requestSysAudioPermission invokes request_sys_audio_permission with no args and passes through the fixture', async () => {
    const status: SysAudioStatus = { availability: 'notGranted' }
    const calls = captureIPC(() => status)

    const result = await commands.requestSysAudioPermission()

    expect(calls[0].cmd).toBe('request_sys_audio_permission')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(status)
  })

  it('revealNote invokes reveal_note with { id }', async () => {
    const calls = captureIPC()

    await commands.revealNote('20260722-120000')

    expect(calls[0].cmd).toBe('reveal_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000' })
  })

  it('getSettings invokes get_settings with no args', async () => {
    const settings: Settings = {
      sttModel: 'whisper-small',
      llmModel: null,
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
    }
    const calls = captureIPC(() => settings)

    const result = await commands.getSettings()

    expect(calls[0].cmd).toBe('get_settings')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(settings)
  })

  it('setSettings invokes set_settings with { patch } and passes through the updated settings', async () => {
    const updated: Settings = {
      sttModel: 'whisper-medium',
      llmModel: null,
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
    }
    const calls = captureIPC(() => updated)

    const result = await commands.setSettings({ sttModel: 'whisper-medium' })

    expect(calls[0].cmd).toBe('set_settings')
    expect(calls[0].args).toEqual({ patch: { sttModel: 'whisper-medium' } })
    expect(result).toEqual(updated)
  })

  it('summarizeNote invokes summarize_note with { id }', async () => {
    const calls = captureIPC()

    await commands.summarizeNote('20260722-120000')

    expect(calls[0].cmd).toBe('summarize_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000' })
  })

  it('toggleActionItem invokes toggle_action_item with { id, index, done } and passes through the updated SummaryDoc', async () => {
    const updated: SummaryDoc = {
      summary: 'Discussed Q3 roadmap.',
      topics: [],
      decisions: ['Ship by Friday'],
      actionItems: [{ text: 'Write release notes', done: true }],
    }
    const calls = captureIPC(() => updated)

    const result = await commands.toggleActionItem('20260722-120000', 0, true)

    expect(calls[0].cmd).toBe('toggle_action_item')
    expect(calls[0].args).toEqual({ id: '20260722-120000', index: 0, done: true })
    expect(result).toEqual(updated)
  })

  it('normalizes a raw string rejection into an Error instance', async () => {
    mockIPC(() => {
      throw 'no active recording'
    })

    await expect(commands.pauseRecording()).rejects.toThrow(Error)
    await expect(commands.pauseRecording()).rejects.toThrow('no active recording')
  })
})
