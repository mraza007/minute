import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AskAnswerEvent, AskStatusEvent, NoteWithTranscript } from '../ipc/types'
import type { AskHistoryEntry } from './useNoteDetail'
import { useNoteDetail } from './useNoteDetail'

function noteWithTranscriptFixture(overrides: Partial<NoteWithTranscript> = {}): NoteWithTranscript {
  return {
    meta: {
      id: 'note-a',
      title: 'Note A',
      createdAt: '2026-07-22T12:00:00.000Z',
      durationSec: 600,
      model: 'whisper-small',
      status: 'transcribed',
      speakers: 1,
      audioDeleted: false,
    },
    transcript: { segments: [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'hello' }] },
    summary: null,
    markdown: '# Note A',
    audioPath: null,
    ...overrides,
  }
}

interface SetupOpts {
  askNoteReject?: string
  onCmd?: (cmd: string, args: unknown) => void
}

function setupIPC(opts: SetupOpts = {}) {
  mockIPC(
    (cmd, args) => {
      opts.onCmd?.(cmd, args)
      switch (cmd) {
        case 'get_note':
          return noteWithTranscriptFixture()
        case 'ask_note':
          if (opts.askNoteReject) throw opts.askNoteReject
          return null
        case 'list_notes':
          return []
        default:
          return null
      }
    },
    { shouldMockEvents: true },
  )
}

function setup(selectedNoteId: string | null = 'note-a') {
  const reportError = vi.fn()
  const refreshNotes = vi.fn()
  const { result } = renderHook(() => useNoteDetail({ selectedNoteId, reportError, refreshNotes }))
  return { result, reportError, refreshNotes }
}

function askStatusEvent(overrides: Partial<AskStatusEvent> = {}): AskStatusEvent {
  return { noteId: 'note-a', state: 'running', error: null, ...overrides }
}

function askAnswerEvent(overrides: Partial<AskAnswerEvent> = {}): AskAnswerEvent {
  return { noteId: 'note-a', question: 'What did they discuss?', answer: 'Q3 roadmap.', ...overrides }
}

/** Strips the `id` field `AiNotesPanel`'s stable-key rendering needs (see `AskHistoryEntry.id`'s docs) so an assertion can compare the rest of an entry's shape without hardcoding the exact counter value it was assigned. */
function withoutIds(entries: AskHistoryEntry[]) {
  return entries.map(({ id: _id, ...rest }) => rest)
}

describe('useNoteDetail', () => {
  describe('askQuestion', () => {
    it('invokes ask_note with the trimmed id/question', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', '  What did they discuss?  '))

      await waitFor(() =>
        expect(calls.some(c => c.cmd === 'ask_note' && (c.args as { question: string }).question === 'What did they discuss?')).toBe(
          true,
        ),
      )
    })

    it('is a no-op for a blank/whitespace-only question — no ask_note call, no history entry', async () => {
      const calls: Array<{ cmd: string; args: unknown }> = []
      setupIPC({ onCmd: (cmd, args) => calls.push({ cmd, args }) })
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', '   '))

      expect(calls.some(c => c.cmd === 'ask_note')).toBe(false)
      expect(result.current.askHistory).toEqual([])
    })
  })

  describe('ask-status / ask-answer event flow', () => {
    it('running then done: askStatus goes running -> idle, with the answer recorded via ask-answer', async () => {
      setupIPC()
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', 'What did they discuss?'))

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'running' }))
      })
      expect(result.current.askStatus).toBe('running')
      expect(result.current.askHistory).toEqual([])

      await act(async () => {
        await emit('ask-answer', askAnswerEvent({ question: 'What did they discuss?', answer: 'Q3 roadmap.' }))
      })
      expect(withoutIds(result.current.askHistory)).toEqual([{ question: 'What did they discuss?', answer: 'Q3 roadmap.' }])

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'done' }))
      })
      expect(result.current.askStatus).toBe('idle')
      // The answer already landed via ask-answer — 'done' must not add a
      // second entry.
      expect(result.current.askHistory).toHaveLength(1)
    })

    it('error records a history entry using the question that was pending, and clears askStatus back through error', async () => {
      setupIPC()
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', 'What color is the sky?'))
      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'running' }))
      })

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'error', error: "The transcript doesn't cover that." }))
      })

      expect(result.current.askStatus).toBe('error')
      expect(withoutIds(result.current.askHistory)).toEqual([
        { question: 'What color is the sky?', error: "The transcript doesn't cover that." },
      ])
    })

    it('falls back to a generic error message when the event carries none', async () => {
      setupIPC()
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', 'What happened?'))
      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'error', error: null }))
      })

      expect(result.current.askHistory[0].error).toBe('Failed to answer.')
    })

    it('an ask-answer for a different note does not appear in the selected note\'s history', async () => {
      setupIPC()
      const { result } = setup('note-a')

      await act(async () => {
        await emit('ask-answer', askAnswerEvent({ noteId: 'note-b', question: 'unrelated', answer: 'unrelated answer' }))
      })

      expect(result.current.askHistory).toEqual([])
    })

    it('an ask-status for a different note does not affect the selected note\'s askStatus', async () => {
      setupIPC()
      const { result } = setup('note-a')

      await act(async () => {
        await emit('ask-status', askStatusEvent({ noteId: 'note-b', state: 'running' }))
      })

      expect(result.current.askStatus).toBe('idle')
    })

    it('history for a previously-selected note is still there once reselected (kept per-note, not just for the current selection)', async () => {
      setupIPC()
      const { result, rerender } = (() => {
        const reportError = vi.fn()
        const refreshNotes = vi.fn()
        const hook = renderHook(({ selectedNoteId }: { selectedNoteId: string | null }) => useNoteDetail({ selectedNoteId, reportError, refreshNotes }), {
          initialProps: { selectedNoteId: 'note-a' as string | null },
        })
        return hook
      })()

      await act(async () => {
        await emit('ask-answer', askAnswerEvent({ noteId: 'note-a', question: 'Q for A', answer: 'A for A' }))
      })
      expect(withoutIds(result.current.askHistory)).toEqual([{ question: 'Q for A', answer: 'A for A' }])

      rerender({ selectedNoteId: 'note-b' })
      expect(result.current.askHistory).toEqual([])

      rerender({ selectedNoteId: 'note-a' })
      expect(withoutIds(result.current.askHistory)).toEqual([{ question: 'Q for A', answer: 'A for A' }])
    })
  })

  describe('capped history', () => {
    it('keeps at most 20 entries per note, newest first, dropping the oldest', async () => {
      setupIPC()
      const { result } = setup()

      for (let i = 0; i < 21; i++) {
        await act(async () => {
          await emit('ask-answer', askAnswerEvent({ question: `Question ${i}`, answer: `Answer ${i}` }))
        })
      }

      expect(result.current.askHistory).toHaveLength(20)
      // Newest (Question 20) first, oldest (Question 0) evicted.
      expect(withoutIds([result.current.askHistory[0]])).toEqual([{ question: 'Question 20', answer: 'Answer 20' }])
      expect(result.current.askHistory.some(e => e.question === 'Question 0')).toBe(false)
      expect(result.current.askHistory.some(e => e.question === 'Question 1')).toBe(true)
    })

    it('assigns each entry a stable, monotonically increasing id that survives the cap and further prepends', async () => {
      setupIPC()
      const { result } = setup()

      for (let i = 0; i < 21; i++) {
        await act(async () => {
          await emit('ask-answer', askAnswerEvent({ question: `Question ${i}`, answer: `Answer ${i}` }))
        })
      }

      const ids = result.current.askHistory.map(e => e.id)
      // All 20 surviving entries have distinct ids...
      expect(new Set(ids).size).toBe(20)
      // ...strictly descending, since the list is newest-first and ids only
      // ever increase at insertion — the most recently prepended entry
      // (index 0) always has the highest id.
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeLessThan(ids[i - 1])
      }
    })
  })

  describe('synchronous ask_note rejection (busy / empty question / no model installed)', () => {
    it('records a history entry when ask_note rejects synchronously with no matching event (e.g. busy)', async () => {
      setupIPC({ askNoteReject: 'busy' })
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', 'What did they discuss?'))

      await waitFor(() => expect(result.current.askHistory).toHaveLength(1))
      expect(withoutIds(result.current.askHistory)).toEqual([{ question: 'What did they discuss?', error: 'busy' }])
    })

    it('does not double-record when both the promise rejects and a matching ask-status error event arrives', async () => {
      setupIPC({ askNoteReject: 'no summary model installed' })
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', 'What did they discuss?'))
      await waitFor(() => expect(result.current.askHistory).toHaveLength(1))

      // The backend also emits an ask-status error event for this exact
      // case — simulated here arriving after the promise rejection already
      // recorded the entry. Must be a no-op (idempotent via the pending-
      // question guard), not a second entry.
      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'error', error: 'no summary model installed' }))
      })

      expect(result.current.askHistory).toHaveLength(1)
    })
  })

  describe('llmBusy', () => {
    it('is true while this note\'s own ask is running', async () => {
      setupIPC()
      const { result } = setup()

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'running' }))
      })

      expect(result.current.llmBusy).toBe(true)
    })

    it('is true while a different note\'s summarization is running', async () => {
      setupIPC()
      const { result } = setup()

      await act(async () => {
        await emit('summary-status', { noteId: 'note-b', state: 'running', error: null })
      })

      expect(result.current.llmBusy).toBe(true)
    })

    it('is false once both flows have finished', async () => {
      setupIPC()
      const { result } = setup()

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'running' }))
      })
      expect(result.current.llmBusy).toBe(true)

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'done' }))
      })
      expect(result.current.llmBusy).toBe(false)
    })
  })

  describe('pruneNoteDetail', () => {
    it('removes the note from summaryStatus/summaryError/askHistory/askStatus (verified via the maps themselves, and by reselecting the pruned note) without touching another note, and leaves llmBusy unaffected', async () => {
      setupIPC()
      // note-a stays selected throughout, so `askHistory`/`askStatus`
      // (derived off the *selected* note) directly reflect whatever
      // `askHistoryMap`/`askStatusMap` hold for it, before and after the
      // prune — not just the note-agnostic `summaryStatus`/`summaryError`
      // records.
      const { result } = setup('note-a')

      await act(async () => {
        await emit('summary-status', { noteId: 'note-a', state: 'error', error: 'boom' })
      })
      await act(async () => {
        await emit('ask-answer', askAnswerEvent({ noteId: 'note-a', question: 'Q for A', answer: 'A for A' }))
      })
      await act(async () => {
        await emit('ask-status', askStatusEvent({ noteId: 'note-a', state: 'done' }))
      })
      // A different note's state must survive note-a's prune untouched.
      await act(async () => {
        await emit('summary-status', { noteId: 'note-b', state: 'running', error: null })
      })

      expect(result.current.summaryStatus['note-a']).toBe('error')
      expect(result.current.summaryError['note-a']).toBe('boom')
      expect(result.current.askHistory).toHaveLength(1)

      act(() => result.current.pruneNoteDetail('note-a'))

      expect(result.current.summaryStatus['note-a']).toBeUndefined()
      expect(result.current.summaryError['note-a']).toBeUndefined()
      expect(result.current.askHistory).toEqual([])
      expect(result.current.askStatus).toBe('idle')
      expect(result.current.summaryStatus['note-b']).toBe('running')
      // llmBusy is still driven by note-b's still-running summarization —
      // pruning note-a's (already-idle, already-errored) state must not
      // touch it.
      expect(result.current.llmBusy).toBe(true)
    })

    it('is a no-op for a note with no tracked state (nothing to prune)', async () => {
      setupIPC()
      const { result } = setup(null)

      expect(() => act(() => result.current.pruneNoteDetail('never-seen'))).not.toThrow()
    })

    it('drops a pending (in-flight) question for the pruned note so a late error event records nothing', async () => {
      setupIPC()
      const { result } = setup()

      act(() => result.current.askQuestion('note-a', 'What did they discuss?'))
      act(() => result.current.pruneNoteDetail('note-a'))

      await act(async () => {
        await emit('ask-status', askStatusEvent({ state: 'error', error: 'boom' }))
      })

      expect(result.current.askHistory).toEqual([])
    })
  })
})
