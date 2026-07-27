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

/**
 * Playback transport, set flush into the bottom edge of the note pane —
 * a ruled strip continuous with the title bar and sidebar chrome, rather
 * than the floating rounded card it used to be. Nothing in this app is
 * meant to hover above the page ("paper, not glass"), and a raised card
 * pinned to the bottom of a document was the last thing that did.
 */
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

  const iconBtnStyle = {
    width: 28,
    height: 28,
    border: 'none',
    borderRadius: '50%',
    background: 'transparent',
    color: 'var(--ink-muted)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
  } as const

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flex: 'none',
        height: 58,
        padding: '0 34px',
        borderTop: '1px solid var(--rule)',
        background: 'var(--panel-warm)',
      }}
    >
      <button
        disabled={disabled}
        aria-disabled={disabled}
        aria-label="Back 15s"
        onClick={() => onSkip(-SKIP_SECONDS)}
        className="icon-btn"
        style={iconBtnStyle}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
          <path d="M3 3v5h5"></path>
        </svg>
      </button>
      <button
        disabled={disabled}
        aria-disabled={disabled}
        className="btn-dark"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={onToggle}
        style={{
          width: 32,
          height: 32,
          border: 'none',
          borderRadius: '50%',
          background: 'var(--btn-ink-bg)',
          color: 'var(--btn-ink-fg)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <PlayPauseIcon playing={playing} />
      </button>
      <button
        disabled={disabled}
        aria-disabled={disabled}
        aria-label="Forward 15s"
        onClick={() => onSkip(SKIP_SECONDS)}
        className="icon-btn"
        style={iconBtnStyle}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
          <path d="M21 3v5h-5"></path>
        </svg>
      </button>
      {/* A drawn rule, not a rounded pill: 2px, square ends, filled in the
          signal accent so elapsed position reads at a glance without the
          bar itself becoming a graphic element. */}
      <div
        ref={trackRef}
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
        style={{
          flex: 1,
          height: 2,
          background: 'var(--player-track)',
          position: 'relative',
          cursor: disabled ? 'default' : 'pointer',
          touchAction: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <div style={{ position: 'absolute', inset: `0 ${100 - progressPercent}% 0 0`, background: 'var(--accent)' }} />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${progressPercent}%`,
            top: '50%',
            width: 11,
            height: 11,
            marginTop: -5.5,
            borderRadius: '50%',
            background: 'var(--panel-warm)',
            border: '2px solid var(--accent)',
            transform: 'translateX(-50%)',
            opacity: disabled ? 0.5 : 1,
          }}
        />
      </div>
      <div
        style={{
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '.02em',
          color: disabled ? 'var(--ink-faint)' : 'var(--ink-muted)',
          flex: 'none',
        }}
      >
        {disabled ? (failed ? 'Audio unavailable' : 'Audio removed') : `${formatMmSs(currentTime)} / ${formatMmSs(durationSec)}`}
      </div>
      <button
        disabled={disabled}
        aria-disabled={disabled}
        aria-label="Playback speed"
        onClick={onCycleRate}
        className="btn-light"
        style={{
          padding: '3px 8px',
          border: '1px solid var(--rule-strong)',
          borderRadius: 'var(--radius-sm)',
          background: 'transparent',
          fontFamily: 'inherit',
          fontSize: 10.5,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--ink-muted)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          flex: 'none',
        }}
      >
        {rate}×
      </button>
    </div>
  )
}
