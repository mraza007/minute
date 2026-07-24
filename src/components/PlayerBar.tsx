import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { formatMmSs } from '../state/adapters'

export interface PlayerBarProps {
  /** Absolute path to this note's `audio.wav`, or `null` if it doesn't exist on disk (never captured, or swept) — drives the whole bar's disabled "Audio removed" state rather than faking controls that don't work. */
  audioPath: string | null
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
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="5" y="3" width="5" height="18" rx="1"></rect>
        <rect x="14" y="3" width="5" height="18" rx="1"></rect>
      </svg>
    )
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 3 20 12 6 21 6 3"></polygon>
    </svg>
  )
}

export function PlayerBar({ audioPath, playing, currentTime, durationSec, rate, onToggle, onSkip, onSeek, onCycleRate }: PlayerBarProps) {
  const disabled = audioPath === null
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
    }
  }

  const iconBtnStyle = {
    width: 30,
    height: 30,
    border: 'none',
    borderRadius: '50%',
    background: 'transparent',
    color: 'var(--ink-muted)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
  } as const

  return (
    <div style={{ padding: '12px 32px 16px', flex: 'none' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'var(--card)',
          border: '1px solid rgba(0,0,0,.08)',
          borderRadius: 'var(--radius-md)',
          padding: '10px 16px',
          boxShadow: '0 1px 4px rgba(0,0,0,.06)',
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            width: 36,
            height: 36,
            border: 'none',
            borderRadius: '50%',
            background: 'var(--ink)',
            color: '#fff',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
            <path d="M21 3v5h-5"></path>
          </svg>
        </button>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Seek"
          aria-disabled={disabled}
          aria-valuemin={0}
          aria-valuemax={durationSec}
          aria-valuenow={currentTime}
          aria-valuetext={formatMmSs(currentTime)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            height: 5,
            borderRadius: 999,
            background: '#e8e5e1',
            position: 'relative',
            cursor: disabled ? 'default' : 'pointer',
            touchAction: 'none',
          }}
        >
          <div style={{ position: 'absolute', inset: `0 ${100 - progressPercent}% 0 0`, borderRadius: 999, background: 'var(--ink)' }} />
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: `${progressPercent}%`,
              top: -4,
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: 'var(--card)',
              border: '2.5px solid var(--accent)',
              boxShadow: '0 1px 3px rgba(0,0,0,.2)',
              transform: 'translateX(-50%)',
              opacity: disabled ? 0.5 : 1,
            }}
          />
        </div>
        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: disabled ? 'var(--ink-faint)' : 'var(--ink-muted)', flex: 'none' }}>
          {disabled ? 'Audio removed' : `${formatMmSs(currentTime)} / ${formatMmSs(durationSec)}`}
        </div>
        <button
          disabled={disabled}
          aria-disabled={disabled}
          aria-label="Playback speed"
          onClick={onCycleRate}
          className="btn-light"
          style={{
            padding: '6px 10px',
            border: '1px solid var(--border-strong)',
            borderRadius: 999,
            background: 'var(--card)',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--ink)',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            flex: 'none',
          }}
        >
          {rate}×
        </button>
      </div>
    </div>
  )
}
