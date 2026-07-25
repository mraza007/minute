import { mockIPC } from '@tauri-apps/api/mocks'
import { fireEvent, render, screen } from '@testing-library/react'
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
})
