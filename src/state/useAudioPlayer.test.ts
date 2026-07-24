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
  duration = 0
  paused = true
  playbackRate = 1
  private listeners = new Map<string, Set<() => void>>()

  play() {
    this.paused = false
    this.dispatch('play')
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
