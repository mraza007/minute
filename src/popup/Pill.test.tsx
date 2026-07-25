import { emit } from '@tauri-apps/api/event'
import { mockIPC } from '@tauri-apps/api/mocks'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pill } from './Pill'

/** Same shape as ipc/commands.test.ts's `captureIPC`, plus `shouldMockEvents`
 * so Pill's `onMeetingPopupPayload` listener (registered on mount) also
 * routes through the in-memory mock instead of erroring on a missing
 * backend. */
function captureIPC(response: (cmd: string, args: unknown) => unknown = () => null) {
  const calls: Array<{ cmd: string; args: unknown }> = []
  mockIPC((cmd, args) => {
    calls.push({ cmd, args })
    return response(cmd, args)
  }, { shouldMockEvents: true })
  return calls
}

// A large-enough autoDismissMs that the countdown timer never fires during
// a normal (non-fake-timer) test — the timeout-specific tests below opt
// into fake timers and a short duration instead.
const NO_TIMEOUT_MS = 999_999

describe('popup/Pill', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the meeting-detected copy, a generic subtitle before any payload arrives, and both buttons', () => {
    captureIPC()
    render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    expect(screen.getByText('Meeting detected')).toBeInTheDocument()
    expect(screen.getByText('Another app is using the microphone')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start recording/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('sets the countdown bar\'s animation-duration from the autoDismissMs prop', () => {
    captureIPC()
    const { container } = render(<Pill autoDismissMs={5000} />)

    const bar = container.querySelector('.popup-countdown-bar')
    expect(bar).toBeInTheDocument()
    expect(bar).toHaveStyle({ animationDuration: '5000ms' })
  })

  it('the countdown bar carries the reduced-motion-overridable class (index.css disables its animation under prefers-reduced-motion)', () => {
    captureIPC()
    const { container } = render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    expect(container.querySelector('.popup-countdown-bar')).toHaveClass('popup-countdown-bar')
  })

  it('clicking "Start recording" invokes popup_start', () => {
    const calls = captureIPC()
    render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    fireEvent.click(screen.getByRole('button', { name: /start recording/i }))

    expect(calls.some(c => c.cmd === 'popup_start')).toBe(true)
  })

  it('clicking the dismiss × invokes popup_dismiss with { timedOut: false }', () => {
    const calls = captureIPC()
    render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(calls.find(c => c.cmd === 'popup_dismiss')?.args).toEqual({ timedOut: false })
  })

  it('pressing Enter invokes popup_start', () => {
    const calls = captureIPC()
    render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(calls.some(c => c.cmd === 'popup_start')).toBe(true)
  })

  it('pressing Escape invokes popup_dismiss with { timedOut: false }', () => {
    const calls = captureIPC()
    render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(calls.find(c => c.cmd === 'popup_dismiss')?.args).toEqual({ timedOut: false })
  })

  it('a key other than Enter/Escape resolves nothing', () => {
    const calls = captureIPC()
    render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

    fireEvent.keyDown(window, { key: 'Tab' })

    expect(calls).toHaveLength(0)
  })

  it('auto-dismisses with { timedOut: true } once autoDismissMs elapses with no interaction', () => {
    vi.useFakeTimers()
    const calls = captureIPC()
    render(<Pill autoDismissMs={100} />)

    vi.advanceTimersByTime(100)

    expect(calls.find(c => c.cmd === 'popup_dismiss')?.args).toEqual({ timedOut: true })
  })

  it('does not fire the auto-dismiss timeout before autoDismissMs has elapsed', () => {
    vi.useFakeTimers()
    const calls = captureIPC()
    render(<Pill autoDismissMs={1000} />)

    vi.advanceTimersByTime(999)

    expect(calls).toHaveLength(0)
  })

  it('only resolves once even if Start is clicked right as the auto-dismiss timer fires', () => {
    vi.useFakeTimers()
    const calls = captureIPC()
    render(<Pill autoDismissMs={100} />)

    fireEvent.click(screen.getByRole('button', { name: /start recording/i }))
    vi.advanceTimersByTime(100)

    const resolving = calls.filter(c => c.cmd === 'popup_start' || c.cmd === 'popup_dismiss')
    expect(resolving).toHaveLength(1)
    expect(resolving[0].cmd).toBe('popup_start')
  })

  // The popup window is created once and reused for the app's whole
  // session (see popup.rs's `ensure_window`) — this same rendered `<Pill>`
  // instance has to keep working across every later detection, not just
  // the first. Regression coverage for the bug where a second detection
  // showed a pill whose buttons quietly did nothing and whose countdown
  // never fired again.
  describe('re-arming across multiple detections (the window is reused, not remounted)', () => {
    it('buttons work again after a second payload following the first prompt being dismissed', async () => {
      const calls = captureIPC()
      render(<Pill autoDismissMs={NO_TIMEOUT_MS} />)

      // First detection, resolved via the dismiss ×.
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
      expect(calls.filter(c => c.cmd === 'popup_dismiss')).toHaveLength(1)
      expect(calls.filter(c => c.cmd === 'popup_start')).toHaveLength(0)

      // A second, independent detection arrives on the same still-mounted
      // instance — the pill must not be permanently dead.
      await act(async () => {
        await emit('meeting-popup-payload', { appName: 'Slack' })
      })
      expect(screen.getByText('Slack is using the microphone')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /start recording/i }))
      expect(calls.filter(c => c.cmd === 'popup_start')).toHaveLength(1)
      // The first prompt's dismiss must still be the only dismiss call —
      // this new click resolved the *second* prompt via Start, not another
      // dismiss.
      expect(calls.filter(c => c.cmd === 'popup_dismiss')).toHaveLength(1)
    })

    it('the auto-dismiss timer re-arms for a second payload after the first prompt was resolved via Start', async () => {
      vi.useFakeTimers()
      const calls = captureIPC()
      render(<Pill autoDismissMs={100} />)

      // First detection, resolved via Start — well before its own 100ms
      // countdown would have fired.
      fireEvent.click(screen.getByRole('button', { name: /start recording/i }))
      expect(calls.filter(c => c.cmd === 'popup_start')).toHaveLength(1)

      // Second detection arrives — left untouched this time.
      await act(async () => {
        await emit('meeting-popup-payload', { appName: 'Zoom' })
      })

      vi.advanceTimersByTime(100)

      expect(calls.filter(c => c.cmd === 'popup_dismiss')).toHaveLength(1)
      expect(calls.find(c => c.cmd === 'popup_dismiss')?.args).toEqual({ timedOut: true })
      // Still exactly one popup_start (the first prompt's) — the re-armed
      // timer resolved the *second* prompt, not a repeat of the first.
      expect(calls.filter(c => c.cmd === 'popup_start')).toHaveLength(1)
    })
  })
})
