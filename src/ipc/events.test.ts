import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { describe, expect, it, vi } from 'vitest'
import * as events from './events'
import type {
  ModelDownloadDoneEvent,
  ModelDownloadProgressEvent,
  RecordingStateEvent,
  SttStatusEvent,
  TranscriptSegmentEvent,
} from './types'

// `mockIPC(cb, { shouldMockEvents: true })` makes the real `listen`/`emit`
// from `@tauri-apps/api/event` route through an in-memory listener table
// (see node_modules/@tauri-apps/api/mocks.js) instead of a real backend —
// so subscribing under one event name and emitting under another produces
// zero callback invocations, which is what actually proves each helper
// wires up the correct event name (not just "some callback fires").
function enableMockEvents() {
  mockIPC(() => null, { shouldMockEvents: true })
}

describe('ipc/events', () => {
  it('onDownloadProgress subscribes to model-download-progress and delivers the payload', async () => {
    enableMockEvents()
    const cb = vi.fn()

    await events.onDownloadProgress(cb)
    const payload: ModelDownloadProgressEvent = { modelId: 'whisper-small', downloaded: 512, total: 1024 }
    await emit('model-download-progress', payload)

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(payload)
  })

  it('onDownloadProgress does not fire for a different event name', async () => {
    enableMockEvents()
    const cb = vi.fn()

    await events.onDownloadProgress(cb)
    await emit('model-download-done', { modelId: 'whisper-small', ok: true, cancelled: false, error: null })

    expect(cb).not.toHaveBeenCalled()
  })

  it('onDownloadDone subscribes to model-download-done and delivers the payload', async () => {
    enableMockEvents()
    const cb = vi.fn()

    await events.onDownloadDone(cb)
    const payload: ModelDownloadDoneEvent = { modelId: 'whisper-small', ok: true, cancelled: false, error: null }
    await emit('model-download-done', payload)

    expect(cb).toHaveBeenCalledWith(payload)
  })

  it('onRecordingState subscribes to recording-state and delivers the payload', async () => {
    enableMockEvents()
    const cb = vi.fn()

    await events.onRecordingState(cb)
    const payload: RecordingStateEvent = { noteId: '20260722-120000', state: 'recording', elapsed: 12.5 }
    await emit('recording-state', payload)

    expect(cb).toHaveBeenCalledWith(payload)
  })

  it('onTranscriptSegment subscribes to transcript-segment and delivers the payload', async () => {
    enableMockEvents()
    const cb = vi.fn()

    await events.onTranscriptSegment(cb)
    const payload: TranscriptSegmentEvent = {
      noteId: '20260722-120000',
      speaker: 'Speaker 1',
      start: 0,
      end: 3.4,
      text: 'Hello there.',
    }
    await emit('transcript-segment', payload)

    expect(cb).toHaveBeenCalledWith(payload)
  })

  it('onSttStatus subscribes to stt-status and delivers the payload', async () => {
    enableMockEvents()
    const cb = vi.fn()

    await events.onSttStatus(cb)
    const payload: SttStatusEvent = { noteId: '20260722-120000', state: 'ready', error: null }
    await emit('stt-status', payload)

    expect(cb).toHaveBeenCalledWith(payload)
  })

  it('the returned unlisten function stops further delivery', async () => {
    enableMockEvents()
    const cb = vi.fn()

    const unlisten = await events.onRecordingState(cb)
    unlisten()
    await emit('recording-state', { noteId: '20260722-120000', state: 'stopped', elapsed: 30 })

    expect(cb).not.toHaveBeenCalled()
  })
})
