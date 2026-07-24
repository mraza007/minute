import { useCallback, useEffect, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * The narrow surface `useAudioPlayer` actually needs from an `<audio>`
 * element — deliberately not `HTMLAudioElement` itself. jsdom's real
 * `HTMLMediaElement` has no working `play()` (it rejects with "not
 * implemented") and never fires `loadedmetadata`/`timeupdate` on its own, so
 * fighting it in tests buys nothing; this interface is what
 * `useAudioPlayer.test.ts` implements as a plain stub instead. The default
 * `createAudio` below (a real `new Audio()`) satisfies it structurally, no
 * adapter needed at runtime.
 */
export interface AudioElementLike {
  src: string
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  playbackRate: number
  play(): void | Promise<void>
  pause(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  /** Optional — only exercised on true unmount (see the effect below), to fully release the element rather than leaving it loaded/buffered with nothing left pointing at it. Real `HTMLAudioElement` always has both; the test stub opts in. */
  removeAttribute?(name: string): void
  load?(): void
}

/** Playback speeds `cycleRate` steps through, in order, wrapping back to the start. */
const RATE_CYCLE = [1, 1.25, 1.5, 2] as const
export type PlaybackRate = (typeof RATE_CYCLE)[number]

export interface AudioPlayerControls {
  playing: boolean
  currentTime: number
  /** The loaded audio's real duration (seconds) once `loadedmetadata` has fired; `0` before that (or with no `audioPath`). */
  duration: number
  rate: PlaybackRate
  play: () => void
  pause: () => void
  toggle: () => void
  /** Seeks to an absolute position, clamped to `[0, duration]`. A no-op with no audio loaded. */
  seek: (seconds: number) => void
  /** Seeks by a relative offset (negative to rewind), clamped to `[0, duration]`. */
  skip: (deltaSeconds: number) => void
  cycleRate: () => void
}

function defaultCreateAudio(): AudioElementLike {
  return new Audio()
}

/**
 * Owns a single `<audio>` element (created lazily — not until the first
 * `audioPath` is actually set, so a note with no audio never touches the
 * DOM) for the currently selected note's playback. Re-points it at a fresh
 * `src` (via `convertFileSrc`, over Tauri's asset protocol — the audio bytes
 * never cross the IPC boundary as a command payload) whenever `audioPath`
 * changes, resetting `currentTime`/`duration`/`playing` back to their
 * initial state each time — stale position/duration from a previously
 * viewed note must never leak into the next one. `audioPath: null` (no
 * `audio.wav` on disk — never captured, or swept) tears the element's `src`
 * down entirely rather than leaving it pointed at the last note's audio.
 *
 * `createAudio` is an injection seam for tests (see `AudioElementLike`'s
 * docs) — defaults to a real `new Audio()` at runtime.
 *
 * `play`/`pause`/`toggle`/`seek`/`skip`/`cycleRate` are all permanently
 * stable identities (`useCallback` with empty deps, or deps that are
 * themselves permanently stable) — they only ever reach into `audioRef`,
 * never close over `currentTime`/`duration`/`playing` state directly, so a
 * caller (`NoteView`) can hand them to memoized children without those
 * memos being defeated by every `timeupdate` tick.
 */
export function useAudioPlayer(audioPath: string | null, createAudio: () => AudioElementLike = defaultCreateAudio): AudioPlayerControls {
  const audioRef = useRef<AudioElementLike | null>(null)
  // Deliberately *not* reset per `audioPath` (unlike currentTime/duration/
  // playing, which are) — the chosen speed is a session-level preference,
  // not something tied to one note; switching notes mid-listen at 1.5x
  // should keep playing the next one at 1.5x too.
  const rateRef = useRef<PlaybackRate>(1)
  // A `seek`/`skip` requested before the element's metadata has loaded
  // (`audio.duration` is still `NaN`) — clamping against a not-yet-known
  // duration would silently floor it to 0 instead of honoring the request.
  // Recorded here and applied for real once `loadedmetadata` reports the
  // real duration; cleared whenever `audioPath` changes so a pending seek
  // for an abandoned note never lands on the next one.
  const pendingSeekRef = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState<PlaybackRate>(1)

  useEffect(() => {
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    pendingSeekRef.current = null

    if (!audioPath) {
      // No audio for this note — tear down any previously loaded element's
      // src so it can't keep playing (or be seeked into) in the background.
      if (audioRef.current) audioRef.current.src = ''
      return
    }

    if (!audioRef.current) audioRef.current = createAudio()
    const audio = audioRef.current
    audio.playbackRate = rateRef.current // carries the chosen rate over from the previous note — see `rateRef`'s docs.
    audio.src = convertFileSrc(audioPath)

    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onLoadedMetadata = () => {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0
      setDuration(dur)
      // A timestamp click (or skip) that arrived before metadata was ready
      // gets applied now, clamped against the duration we only just learned.
      if (pendingSeekRef.current !== null) {
        const clamped = Math.min(Math.max(pendingSeekRef.current, 0), dur)
        pendingSeekRef.current = null
        audio.currentTime = clamped
        setCurrentTime(clamped)
      }
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => setPlaying(false)

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)

    return () => {
      // Runs both when `audioPath` changes to a different note (about to
      // re-point `src` at fresh audio — the reset above already zeroes
      // `currentTime`/`duration`/`playing` for it) and on unmount. Either
      // way, whatever was loaded here must stop playing: per the HTML spec a
      // "potentially playing" media element is *not* garbage collected just
      // because every JS reference to it drops (NoteView, and this hook with
      // it, unmounts whenever the user navigates to Settings or starts a new
      // recording), so without this an orphaned element would keep playing
      // — audibly, with no UI left to stop it — until the whole webview
      // reloads.
      audio.pause()
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath])

  // Unmount-only teardown (empty deps — this cleanup never fires on a mere
  // `audioPath` change, only when the hook itself goes away): beyond pausing
  // (already handled above, for both cases), fully releases the element by
  // clearing its `src` and re-invoking `load()` — the standard way to tell
  // the browser "stop buffering/decoding this, I'm done" rather than leaving
  // it holding onto a loaded resource that nothing can reach anymore. Kept
  // as a second effect (rather than folded into the one above) so switching
  // between two notes' audio doesn't pay this heavier teardown on every
  // switch — only real unmounts do.
  useEffect(() => {
    return () => {
      const audio = audioRef.current
      if (!audio) return
      audio.pause()
      audio.removeAttribute?.('src')
      audio.load?.()
    }
  }, [])

  // play() returns a promise that real WebKit/Chromium reject with an
  // AbortError when something (a pause() call, a src change) interrupts
  // playback before it actually starts — routine now that unmount/note-
  // switch cleanup pauses on the way out (a quick "click a timestamp, then
  // immediately switch notes" is exactly that sequence). There's nothing
  // useful to do with that rejection here — swallow it rather than letting
  // it surface as an unhandled promise rejection.
  const play = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    // `Promise.resolve(...)` normalizes `play()`'s `void | Promise<void>`
    // return into something always safe to `.catch` — a no-op wrapper
    // around the `void` case, the real rejection-swallow for the `Promise`
    // case (see the docs above `play`/`toggle` for why that's expected).
    Promise.resolve(audio.play()).catch(() => {})
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) Promise.resolve(audio.play()).catch(() => {}) // see `play`'s docs above
    else audio.pause()
  }, [])

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    if (!Number.isFinite(audio.duration)) {
      // Metadata not loaded yet — the real duration to clamp against isn't
      // known. Queue it (lower-bounded) rather than clamping to 0, which
      // would silently strand the seek at the start; `onLoadedMetadata`
      // above applies it for real once the duration is known.
      pendingSeekRef.current = Math.max(seconds, 0)
      return
    }
    pendingSeekRef.current = null
    const clamped = Math.min(Math.max(seconds, 0), audio.duration)
    audio.currentTime = clamped
    setCurrentTime(clamped)
  }, [])

  const skip = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current
      if (!audio) return
      seek(audio.currentTime + deltaSeconds)
    },
    [seek],
  )

  const cycleRate = useCallback(() => {
    setRate(prev => {
      const next = RATE_CYCLE[(RATE_CYCLE.indexOf(prev) + 1) % RATE_CYCLE.length]
      rateRef.current = next
      if (audioRef.current) audioRef.current.playbackRate = next
      return next
    })
  }, [])

  return { playing, currentTime, duration, rate, play, pause, toggle, seek, skip, cycleRate }
}
