import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { formatMmSs } from '../state/adapters'

export interface PlayerBarProps {
  /** Absolute path to this note's `audio.wav`, or `null` if it doesn't exist on disk (never captured, or swept) — drives the whole bar's disabled "Audio removed" state rather than faking controls that don't work. */
  audioPath: string | null
  /** `true` once the audio element has fired a load `error` for `audioPath` — the file was known to exist (`audioPath` non-null) but failed to actually load (deleted out from under the app, or raced by the launch sweep). Disables every control exactly like `audioPath === null` does, but with honest "Audio unavailable" copy instead of "Audio removed" — the file wasn't necessarily removed, the load just failed. */
  failed: boolean
  playing: boolean
  currentTime: number
  /** The live audio element's real duration once loaded, falling back to the note's persisted duration before then — see NoteView's wiring. */
  durationSec: number
  rate: number
  onToggle: () => void
  onSkip: (deltaSeconds: number) => void
  onSeek: (seconds: number) => void
  onCycleRate: () => void
}

const SKIP_SECONDS = 15
const ARROW_KEY_SEEK_SECONDS = 5

function PlayPauseIcon({ playing }: { playing: boolean }) {
  if (playing) {
    return (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="5" y="3" width="5" height="18" rx="1"></rect>
        <rect x="14" y="3" width="5" height="18" rx="1"></rect>
      </svg>
    )
  }
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 3 20 12 6 21 6 3"></polygon>
    </svg>
  )
}

/** Playback transport, pinned to the bottom edge of the note. */
export function PlayerBar({ audioPath, failed, playing, currentTime, durationSec, rate, onToggle, onSkip, onSeek, onCycleRate }: PlayerBarProps) {
  const disabled = audioPath === null || failed
  const trackRef = useRef<HTMLDivElement>(null)
  const progressPercent = durationSec > 0 ? Math.min(100, Math.max(0, (currentTime / durationSec) * 100)) : 0

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || durationSec <= 0) return
      const rect = track.getBoundingClientRect()
      const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0
      onSeek(fraction * durationSec)
    },
    [durationSec, onSeek],
  )

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return
    // Not implemented in jsdom (undefined there, hence the optional call) —
    // real WebKit/Chromium always has it, and it's what keeps the drag
    // tracking the thumb even if the pointer strays outside the track.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    seekFromClientX(e.clientX)
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.buttons === 0) return
    seekFromClientX(e.clientX)
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onSeek(currentTime - ARROW_KEY_SEEK_SECONDS)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onSeek(currentTime + ARROW_KEY_SEEK_SECONDS)
    } else if (e.key === 'Home') {
      e.preventDefault()
      onSeek(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      onSeek(durationSec)
    }
  }

  const skipBack = (
    <button disabled={disabled} aria-disabled={disabled} aria-label="Back 15s" title="Back 15 seconds" onClick={() => onSkip(-SKIP_SECONDS)} className="icon-btn player-skip">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
        <path d="M3 3v5h5"></path>
      </svg>
    </button>
  )
  const skipForward = (
    <button disabled={disabled} aria-disabled={disabled} aria-label="Forward 15s" title="Forward 15 seconds" onClick={() => onSkip(SKIP_SECONDS)} className="icon-btn player-skip">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
        <path d="M21 3v5h-5"></path>
      </svg>
    </button>
  )

  return (
    <div className="player-bar" data-disabled={disabled ? 'true' : undefined}>
      <button disabled={disabled} aria-disabled={disabled} className="player-play" aria-label={playing ? 'Pause' : 'Play'} onClick={onToggle}>
        <PlayPauseIcon playing={playing} />
      </button>
      {disabled ? (
        <span className="player-time player-time-off">{failed ? 'Audio unavailable' : 'Audio removed'}</span>
      ) : (
        <span className="player-time">{formatMmSs(currentTime)}</span>
      )}
      <div
        ref={trackRef}
        className="player-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Seek"
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={formatMmSs(currentTime)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onKeyDown={handleKeyDown}
      >
        <div className="player-track-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      {!disabled && <span className="player-time player-time-total">{formatMmSs(durationSec)}</span>}
      {skipBack}
      {skipForward}
      <button disabled={disabled} aria-disabled={disabled} aria-label="Playback speed" onClick={onCycleRate} className="player-rate">
        {rate}×
      </button>
    </div>
  )
}
