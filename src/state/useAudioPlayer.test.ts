/// <reference types="node" />
// Only this file needs Node's ambient `process` global (to assert no
// unhandled promise rejection below) — `@types/node` is already a
// devDependency, just not in tsconfig.app.json's `types` list (deliberately
// narrow, so browser/renderer code doesn't get Node globals in scope); a
// file-scoped triple-slash reference opts in here without widening that.
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAudioPlayer, type AudioElementLike } from './useAudioPlayer'

// A pure-JS stand-in for `<audio>` — jsdom's real HTMLMediaElement has no
// working `play()` and never fires `loadedmetadata`/`timeupdate` on its own,
// so this is what `createAudio` (the hook's injection seam) hands back in
// every test below instead. Deliberately minimal: only what `AudioElementLike`
// declares.
class FakeAudio implements AudioElementLike {
  src = ''
  currentTime = 0
  // Matches real `HTMLMediaElement`: `duration` is `NaN` until metadata has
  // loaded, not `0` — the CRITICAL bug this file pins (a seek before
  // metadata loads must queue, not clamp against a not-yet-known duration)
  // only reproduces with this starting value.
  duration = NaN
  paused = true
  playbackRate = 1
  /** Test hook: when set, the next `play()` call returns a rejected promise (e.g. simulating a real WebKit AbortError) instead of actually starting playback. */
  playRejection: unknown = null
  private listeners = new Map<string, Set<() => void>>()

  play(): Promise<void> {
    if (this.playRejection !== null) {
      return Promise.reject(this.playRejection)
    }
    this.paused = false
    this.dispatch('play')
    return Promise.resolve()
  }

  pause() {
    this.paused = true
    this.dispatch('pause')
  }

  addEventListener(type: string, listener: () => void) {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener)
  }

  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }

  load() {
    // no-op in the fake — a real element would (re)start buffering whatever `src` currently is.
  }

  /** Test helper: fires a native-style event, invoking every listener registered for `type`. */
  dispatch(type: string) {
    this.listeners.get(type)?.forEach(l => l())
  }

  /** Test helper: simulates the element having loaded metadata for a `durationSec`-long file. */
  loadMetadata(durationSec: number) {
    this.duration = durationSec
    this.dispatch('loadedmetadata')
  }

  /** Test helper: simulates a `timeupdate` tick at `seconds`. */
  tick(seconds: number) {
    this.currentTime = seconds
    this.dispatch('timeupdate')
  }

  /** Test helper: simulates the element firing a native `error` event — a real load failure (file deleted out from under the app, or the launch sweep racing the first `get_note`). */
  fail() {
    this.dispatch('error')
  }
}

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}))

function harness() {
  const created: FakeAudio[] = []
  const createAudio = vi.fn(() => {
    const audio = new FakeAudio()
    created.push(audio)
    return audio
  })
  return { created, createAudio }
}

describe('useAudioPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not create an audio element while audioPath is null', () => {
    const { created, createAudio } = harness()
    renderHook(() => useAudioPlayer(null, createAudio))
    expect(createAudio).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it('lazily creates one audio element and sets its src via convertFileSrc once audioPath is set', () => {
    const { created, createAudio } = harness()
    renderHook(() => useAudioPlayer('/notes/abc/audio.wav', createAudio))
    expect(createAudio).toHaveBeenCalledTimes(1)
    expect(created[0].src).toBe('asset://localhost//notes/abc/audio.wav')
  })

  it('reuses the same element across re-renders with the same audioPath', () => {
    const { createAudio } = harness()
    const { rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/notes/abc/audio.wav' },
    })
    rerender({ path: '/notes/abc/audio.wav' })
    expect(createAudio).toHaveBeenCalledTimes(1)
  })

  it('play() calls the underlying element play()', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))
    act(() => result.current.play())
    expect(created[0].paused).toBe(false)
  })

  it('pause() calls the underlying element pause()', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))
    act(() => result.current.play())
    act(() => result.current.pause())
    expect(created[0].paused).toBe(true)
  })

  it('toggle() plays when paused and pauses when playing', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    act(() => result.current.toggle())
    expect(created[0].paused).toBe(false)

    act(() => result.current.toggle())
    expect(created[0].paused).toBe(true)
  })

  it('playing follows the element play/pause events', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    expect(result.current.playing).toBe(false)
    act(() => created[0].dispatch('play'))
    expect(result.current.playing).toBe(true)
    act(() => created[0].dispatch('pause'))
    expect(result.current.playing).toBe(false)
  })

  it('ended resets playing to false', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    act(() => created[0].dispatch('play'))
    expect(result.current.playing).toBe(true)
    act(() => created[0].dispatch('ended'))
    expect(result.current.playing).toBe(false)
  })

  it('currentTime tracks timeupdate events', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    act(() => created[0].tick(12.5))
    expect(result.current.currentTime).toBe(12.5)
  })

  it('duration tracks loadedmetadata', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    expect(result.current.duration).toBe(0)
    act(() => created[0].loadMetadata(180))
    expect(result.current.duration).toBe(180)
  })

  it('failed starts false and flips true once the element fires a native error event', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    expect(result.current.failed).toBe(false)
    act(() => created[0].fail())
    expect(result.current.failed).toBe(true)
  })

  it('resets failed to false when audioPath changes to a different note', () => {
    const { created, createAudio } = harness()
    const { result, rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' },
    })
    act(() => created[0].fail())
    expect(result.current.failed).toBe(true)

    rerender({ path: '/b.wav' })

    expect(result.current.failed).toBe(false)
  })

  it('seek() clamps to [0, duration]', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))
    created[0].loadMetadata(100)

    act(() => result.current.seek(50))
    expect(created[0].currentTime).toBe(50)
    expect(result.current.currentTime).toBe(50)

    act(() => result.current.seek(-10))
    expect(created[0].currentTime).toBe(0)

    act(() => result.current.seek(999))
    expect(created[0].currentTime).toBe(100)
  })

  it('queues a seek requested before metadata has loaded, applying it (clamped) once loadedmetadata fires', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))
    expect(Number.isFinite(created[0].duration)).toBe(false) // metadata not loaded yet

    act(() => result.current.seek(94))
    // Not applied yet — nothing to clamp against.
    expect(created[0].currentTime).toBe(0)
    expect(result.current.currentTime).toBe(0)

    act(() => created[0].loadMetadata(200))

    expect(created[0].currentTime).toBe(94)
    expect(result.current.currentTime).toBe(94)
  })

  it('clamps a queued seek against the duration once it becomes known', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    act(() => result.current.seek(999))
    act(() => created[0].loadMetadata(100))

    expect(created[0].currentTime).toBe(100)
    expect(result.current.currentTime).toBe(100)
  })

  it('discards a queued seek when audioPath changes before metadata loads (does not leak onto the next note)', () => {
    const { created, createAudio } = harness()
    const { result, rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' },
    })

    act(() => result.current.seek(94)) // queued — /a.wav's metadata never loads

    rerender({ path: '/b.wav' })
    act(() => created[0].loadMetadata(200)) // /b.wav's metadata loads

    // The stale seek for /a.wav must not land on /b.wav.
    expect(created[0].currentTime).toBe(0)
    expect(result.current.currentTime).toBe(0)
  })

  it('skip() also queues before metadata loads, applying once it is known', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    act(() => result.current.skip(15)) // currentTime is 0 pre-metadata, so this queues seek(15)
    expect(created[0].currentTime).toBe(0)

    act(() => created[0].loadMetadata(200))

    expect(created[0].currentTime).toBe(15)
    expect(result.current.currentTime).toBe(15)
  })

  it('swallows a rejected play() promise (e.g. an interrupted-play AbortError) without an unhandled rejection', async () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))
    created[0].playRejection = new Error('AbortError: the play() request was interrupted')

    const onUnhandledRejection = vi.fn()
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      act(() => result.current.play())
      // Flush microtasks so the rejection (and our .catch) actually run.
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }

    expect(onUnhandledRejection).not.toHaveBeenCalled()
  })

  it('keeps the playback rate when switching to a different note (deliberate — a session preference, not per-note)', () => {
    const { created, createAudio } = harness()
    const { result, rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' },
    })

    act(() => result.current.cycleRate())
    expect(result.current.rate).toBe(1.25)

    rerender({ path: '/b.wav' })

    expect(result.current.rate).toBe(1.25)
    expect(created[0].playbackRate).toBe(1.25) // applied to the (reused) element for the new note too
  })

  it('skip() applies a relative delta clamped to [0, duration]', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))
    created[0].loadMetadata(100)
    created[0].tick(50)

    act(() => result.current.skip(15))
    expect(created[0].currentTime).toBe(65)

    act(() => result.current.skip(-1000))
    expect(created[0].currentTime).toBe(0)

    act(() => result.current.skip(1000))
    expect(created[0].currentTime).toBe(100)
  })

  it('cycleRate steps 1 -> 1.25 -> 1.5 -> 2 -> 1 and applies it to the element', () => {
    const { created, createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    expect(result.current.rate).toBe(1)
    act(() => result.current.cycleRate())
    expect(result.current.rate).toBe(1.25)
    expect(created[0].playbackRate).toBe(1.25)
    act(() => result.current.cycleRate())
    expect(result.current.rate).toBe(1.5)
    act(() => result.current.cycleRate())
    expect(result.current.rate).toBe(2)
    act(() => result.current.cycleRate())
    expect(result.current.rate).toBe(1)
    expect(created[0].playbackRate).toBe(1)
  })

  it('resets currentTime/duration/playing when audioPath changes to a different note', () => {
    const { created, createAudio } = harness()
    const { result, rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' },
    })
    act(() => created[0].loadMetadata(100))
    act(() => created[0].tick(50))
    act(() => created[0].dispatch('play'))
    expect(result.current.currentTime).toBe(50)
    expect(result.current.duration).toBe(100)
    expect(result.current.playing).toBe(true)

    rerender({ path: '/b.wav' })

    expect(result.current.currentTime).toBe(0)
    expect(result.current.duration).toBe(0)
    expect(result.current.playing).toBe(false)
    // A single element is reused across notes (re-pointed at a fresh src),
    // not recreated per note.
    expect(created).toHaveLength(1)
    expect(created[0].src).toBe('asset://localhost//b.wav')
  })

  it('resets to the idle state and tears down src when audioPath becomes null', () => {
    const { created, createAudio } = harness()
    const { result, rerender } = renderHook(({ path }: { path: string | null }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' as string | null },
    })
    act(() => created[0].loadMetadata(100))
    act(() => created[0].tick(50))

    rerender({ path: null })

    expect(result.current.currentTime).toBe(0)
    expect(result.current.duration).toBe(0)
    expect(result.current.playing).toBe(false)
    expect(created[0].src).toBe('')
  })

  it('seek()/skip()/play() are no-ops (no throw) when there is no audio loaded', () => {
    const { createAudio } = harness()
    const { result } = renderHook(() => useAudioPlayer(null, createAudio))

    expect(() => {
      act(() => {
        result.current.play()
        result.current.pause()
        result.current.toggle()
        result.current.seek(10)
        result.current.skip(5)
      })
    }).not.toThrow()
    expect(result.current.currentTime).toBe(0)
  })

  it('resets to paused when switching audioPath mid-playback (no orphaned playback on the previous note)', () => {
    const { created, createAudio } = harness()
    const { rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' },
    })
    // Block body — `created[0].play()` now returns a promise; a concise-body
    // arrow would hand that back to `act()` and switch it into async mode
    // without being awaited, which then throws off `rerender`'s own
    // (implicit, synchronous) `act()` flush below.
    act(() => {
      created[0].play()
    })
    expect(created[0].paused).toBe(false)

    rerender({ path: '/b.wav' })

    expect(created[0].paused).toBe(true)
  })

  it('pauses and releases the element on unmount so playback does not continue with no UI left to stop it', () => {
    const { created, createAudio } = harness()
    const { result, unmount } = renderHook(() => useAudioPlayer('/a.wav', createAudio))

    act(() => result.current.play())
    expect(created[0].paused).toBe(false)

    unmount()

    expect(created[0].paused).toBe(true)
    expect(created[0].src).toBe('')
  })

  it('keeps play/pause/toggle/seek/skip/cycleRate at stable identities across audioPath changes', () => {
    const { createAudio } = harness()
    const { result, rerender } = renderHook(({ path }) => useAudioPlayer(path, createAudio), {
      initialProps: { path: '/a.wav' },
    })
    const before = { ...result.current }
    rerender({ path: '/b.wav' })
    const after = result.current

    expect(after.play).toBe(before.play)
    expect(after.pause).toBe(before.pause)
    expect(after.toggle).toBe(before.toggle)
    expect(after.seek).toBe(before.seek)
    expect(after.skip).toBe(before.skip)
    expect(after.cycleRate).toBe(before.cycleRate)
  })
})
