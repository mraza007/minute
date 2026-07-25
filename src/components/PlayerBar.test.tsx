import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { PlayerBar, type PlayerBarProps } from './PlayerBar'

function makeProps(overrides: Partial<PlayerBarProps> = {}): PlayerBarProps {
  return {
    audioPath: '/notes/abc/audio.wav',
    failed: false,
    playing: false,
    currentTime: 0,
    durationSec: 48 * 60 + 22,
    rate: 1,
    onToggle: vi.fn(),
    onSkip: vi.fn(),
    onSeek: vi.fn(),
    onCycleRate: vi.fn(),
    ...overrides,
  }
}

describe('PlayerBar', () => {
  it('shows the current elapsed time against the total duration, mm:ss', () => {
    render(<PlayerBar {...makeProps({ currentTime: 0, durationSec: 48 * 60 + 22 })} />)
    expect(screen.getByText('00:00 / 48:22')).toBeInTheDocument()
  })

  it('formats a sub-minute duration correctly', () => {
    render(<PlayerBar {...makeProps({ currentTime: 5, durationSec: 42 })} />)
    expect(screen.getByText('00:05 / 00:42')).toBeInTheDocument()
  })

  it('shows the current playback rate on the speed chip', () => {
    render(<PlayerBar {...makeProps({ rate: 1.5 })} />)
    expect(screen.getByText('1.5×')).toBeInTheDocument()
  })

  it('clicking the speed chip calls onCycleRate', () => {
    const onCycleRate = vi.fn()
    render(<PlayerBar {...makeProps({ onCycleRate })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed' }))
    expect(onCycleRate).toHaveBeenCalledTimes(1)
  })

  it('renders the Play button when not playing, and calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<PlayerBar {...makeProps({ playing: false, onToggle })} />)
    const playButton = screen.getByRole('button', { name: 'Play' })
    expect(playButton).toBeInTheDocument()
    expect(playButton).not.toBeDisabled()
    fireEvent.click(playButton)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('renders a Pause button (with swapped aria-label) when playing', () => {
    render(<PlayerBar {...makeProps({ playing: true })} />)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument()
  })

  it('clicking Back 15s calls onSkip(-15)', () => {
    const onSkip = vi.fn()
    render(<PlayerBar {...makeProps({ onSkip })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back 15s' }))
    expect(onSkip).toHaveBeenCalledWith(-15)
  })

  it('clicking Forward 15s calls onSkip(15)', () => {
    const onSkip = vi.fn()
    render(<PlayerBar {...makeProps({ onSkip })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Forward 15s' }))
    expect(onSkip).toHaveBeenCalledWith(15)
  })

  describe('seek bar', () => {
    it('exposes slider semantics reflecting currentTime/durationSec', () => {
      render(<PlayerBar {...makeProps({ currentTime: 90, durationSec: 300 })} />)
      const slider = screen.getByRole('slider', { name: 'Seek' })
      expect(slider).toHaveAttribute('aria-valuemin', '0')
      expect(slider).toHaveAttribute('aria-valuemax', '300')
      expect(slider).toHaveAttribute('aria-valuenow', '90')
      expect(slider).toHaveAttribute('aria-valuetext', '01:30')
    })

    it('clicking the track seeks proportionally to the click position', () => {
      const onSeek = vi.fn()
      render(<PlayerBar {...makeProps({ durationSec: 200, onSeek })} />)
      const slider = screen.getByRole('slider', { name: 'Seek' })
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        width: 100,
        top: 0,
        bottom: 10,
        height: 10,
        x: 0,
        y: 0,
        toJSON() {},
      })
      fireEvent.pointerDown(slider, { clientX: 25 })
      expect(onSeek).toHaveBeenCalledWith(50) // 25% of 200s
    })

    it('ArrowRight seeks forward 5s, ArrowLeft seeks back 5s', () => {
      const onSeek = vi.fn()
      render(<PlayerBar {...makeProps({ currentTime: 30, onSeek })} />)
      const slider = screen.getByRole('slider', { name: 'Seek' })
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      expect(onSeek).toHaveBeenCalledWith(35)
      fireEvent.keyDown(slider, { key: 'ArrowLeft' })
      expect(onSeek).toHaveBeenCalledWith(25)
    })

    it('Home seeks to 0, End seeks to the full duration', () => {
      const onSeek = vi.fn()
      render(<PlayerBar {...makeProps({ currentTime: 30, durationSec: 200, onSeek })} />)
      const slider = screen.getByRole('slider', { name: 'Seek' })
      fireEvent.keyDown(slider, { key: 'Home' })
      expect(onSeek).toHaveBeenCalledWith(0)
      fireEvent.keyDown(slider, { key: 'End' })
      expect(onSeek).toHaveBeenCalledWith(200)
    })

    it('rounds aria-valuenow/aria-valuemax to whole seconds while aria-valuetext stays mm:ss', () => {
      render(<PlayerBar {...makeProps({ currentTime: 90.6, durationSec: 200.4 })} />)
      const slider = screen.getByRole('slider', { name: 'Seek' })
      expect(slider).toHaveAttribute('aria-valuenow', '91')
      expect(slider).toHaveAttribute('aria-valuemax', '200')
      expect(slider).toHaveAttribute('aria-valuetext', '01:30')
    })

    it('is not focusable and ignores interaction when disabled (no audio)', () => {
      const onSeek = vi.fn()
      render(<PlayerBar {...makeProps({ audioPath: null, onSeek })} />)
      const slider = screen.getByRole('slider', { name: 'Seek' })
      expect(slider).toHaveAttribute('tabindex', '-1')
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      expect(onSeek).not.toHaveBeenCalled()
    })
  })

  describe('no audio (audioPath is null)', () => {
    it('shows "Audio removed" instead of a time label', () => {
      render(<PlayerBar {...makeProps({ audioPath: null })} />)
      expect(screen.getByText('Audio removed')).toBeInTheDocument()
      expect(screen.queryByText(/\d\d:\d\d \/ \d\d:\d\d/)).not.toBeInTheDocument()
    })

    it('disables every control', () => {
      render(<PlayerBar {...makeProps({ audioPath: null })} />)
      expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Back 15s' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Forward 15s' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Playback speed' })).toBeDisabled()
    })

    it('clicking the disabled Play button does not call onToggle', () => {
      const onToggle = vi.fn()
      render(<PlayerBar {...makeProps({ audioPath: null, onToggle })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      expect(onToggle).not.toHaveBeenCalled()
    })
  })

  describe('failed to load (audioPath present, but the element fired an error)', () => {
    it('shows "Audio unavailable" instead of "Audio removed" or a time label', () => {
      render(<PlayerBar {...makeProps({ failed: true })} />)
      expect(screen.getByText('Audio unavailable')).toBeInTheDocument()
      expect(screen.queryByText('Audio removed')).not.toBeInTheDocument()
      expect(screen.queryByText(/\d\d:\d\d \/ \d\d:\d\d/)).not.toBeInTheDocument()
    })

    it('disables every control, same as no audio at all', () => {
      render(<PlayerBar {...makeProps({ failed: true })} />)
      expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Back 15s' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Forward 15s' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Playback speed' })).toBeDisabled()
    })

    it('clicking the disabled Play button does not call onToggle', () => {
      const onToggle = vi.fn()
      render(<PlayerBar {...makeProps({ failed: true, onToggle })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      expect(onToggle).not.toHaveBeenCalled()
    })
  })
})
