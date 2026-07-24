import { mockIPC } from '@tauri-apps/api/mocks'
import { beforeEach, describe, expect, it } from 'vitest'
import * as commands from './commands'
import type { Hardware, ModelStatus, NoteMeta, NoteWithTranscript, Recommendation, Settings, StorageStats } from './types'

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
      },
      transcript: {
        segments: [{ speaker: 'Speaker 1', start: 0, end: 3.2, text: 'Hello there.' }],
      },
      summary: null,
      markdown: '# Client call — Acme',
    }
    const calls = captureIPC(() => fixture)

    const result = await commands.getNote('20260722-120000')

    expect(calls[0].cmd).toBe('get_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000' })
    expect(result).toEqual(fixture)
  })

  it('renameNote invokes rename_note with { id, title }', async () => {
    const calls = captureIPC()

    await commands.renameNote('20260722-120000', 'Renamed title')

    expect(calls[0].cmd).toBe('rename_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000', title: 'Renamed title' })
  })

  it('deleteNote invokes delete_note with { id }', async () => {
    const calls = captureIPC()

    await commands.deleteNote('20260722-120000')

    expect(calls[0].cmd).toBe('delete_note')
    expect(calls[0].args).toEqual({ id: '20260722-120000' })
  })

  it('storageStats invokes storage_stats', async () => {
    const stats: StorageStats = { modelsBytes: 1000, audioBytes: 2000, notesBytes: 3000 }
    const calls = captureIPC(() => stats)

    const result = await commands.storageStats()

    expect(calls[0].cmd).toBe('storage_stats')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(stats)
  })

  it('startRecording invokes start_recording with { modelId } and resolves the new note id', async () => {
    const calls = captureIPC(() => '20260722-130000')

    const result = await commands.startRecording('whisper-small')

    expect(calls[0].cmd).toBe('start_recording')
    expect(calls[0].args).toEqual({ modelId: 'whisper-small' })
    expect(result).toBe('20260722-130000')
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
    }
    const calls = captureIPC(() => meta)

    const result = await commands.stopRecording()

    expect(calls[0].cmd).toBe('stop_recording')
    expect(calls[0].args).toEqual({})
    expect(result).toEqual(meta)
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
      encryptLibrary: false,
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
      encryptLibrary: false,
    }
    const calls = captureIPC(() => updated)

    const result = await commands.setSettings({ sttModel: 'whisper-medium' })

    expect(calls[0].cmd).toBe('set_settings')
    expect(calls[0].args).toEqual({ patch: { sttModel: 'whisper-medium' } })
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
