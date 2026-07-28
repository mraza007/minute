import { act, render, screen, waitFor } from '@testing-library/react'
import type { AudioInputLevelEvent } from '../ipc/types'
import {
  InputLevelMeter,
} from './InputLevelMeter'
import {
  meterLevelFromRms,
  nextInputDiagnostic,
} from './inputLevelDiagnostics'

const mocks = vi.hoisted(() => ({
  start: vi.fn((_deviceId: string, _sessionId: string) => Promise.resolve()),
  stop: vi.fn((_sessionId: string) => Promise.resolve()),
  levelCallback: null as ((event: AudioInputLevelEvent) => void) | null,
}))

vi.mock('../ipc/commands', () => ({
  startAudioInputPreview: mocks.start,
  stopAudioInputPreview: mocks.stop,
}))

vi.mock('../ipc/events', () => ({
  onAudioInputLevel: vi.fn((callback: (event: AudioInputLevelEvent) => void) => {
    mocks.levelCallback = callback
    return Promise.resolve(() => {})
  }),
}))

describe('InputLevelMeter', () => {
  beforeEach(() => {
    mocks.start.mockClear()
    mocks.stop.mockClear()
    mocks.levelCallback = null
  })

  it('maps RMS decibels into a bounded visual level', () => {
    expect(meterLevelFromRms(0)).toBe(0)
    expect(meterLevelFromRms(0.001)).toBeCloseTo(0)
    expect(meterLevelFromRms(0.1)).toBeCloseTo(2 / 3)
    expect(meterLevelFromRms(1)).toBe(1)
    expect(meterLevelFromRms(Number.NaN)).toBe(0)
  })

  it('waits for sustained silence and repeated clipping before warning', () => {
    const initial = { silenceSince: null, clippingEvents: 0 }
    const firstQuiet = nextInputDiagnostic(initial, 0, 0, 1_000)
    expect(firstQuiet.diagnostic).toBe('listening')
    expect(nextInputDiagnostic(firstQuiet.tracker, 0, 0, 2_999).diagnostic).toBe('listening')
    expect(nextInputDiagnostic(firstQuiet.tracker, 0, 0, 3_000).diagnostic).toBe('silent')

    const firstClip = nextInputDiagnostic(initial, 0.2, 0.99, 1_000)
    expect(firstClip.diagnostic).toBe('good')
    expect(nextInputDiagnostic(firstClip.tracker, 0.2, 0.99, 1_080).diagnostic).toBe('clipping')
  })

  it('starts a token-scoped preview, shows signal feedback, and stops on cleanup', async () => {
    const { unmount } = render(<InputLevelMeter deviceId="built-in" active={true} />)

    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))
    const sessionId = mocks.start.mock.calls[0][1]
    expect(screen.getByRole('meter', { name: 'Microphone input level' })).toHaveAttribute(
      'aria-valuetext',
      'Speak to check your level',
    )

    act(() => {
      mocks.levelCallback?.({ sessionId, rms: 0.1, peak: 0.4, error: null })
    })
    expect(screen.getByText('Input level looks good')).toBeInTheDocument()
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '30')

    unmount()
    expect(mocks.stop).toHaveBeenCalledWith(sessionId)
  })

  it('ignores stale sessions and surfaces a current preview failure inline', async () => {
    render(<InputLevelMeter deviceId="studio" active={true} />)
    await waitFor(() => expect(mocks.start).toHaveBeenCalled())
    const calls = mocks.start.mock.calls
    const sessionId = calls[calls.length - 1][1]

    act(() => {
      mocks.levelCallback?.({ sessionId: 'stale', rms: 0.5, peak: 0.7, error: null })
    })
    expect(screen.queryByText('Input level looks good')).not.toBeInTheDocument()

    act(() => {
      mocks.levelCallback?.({ sessionId, rms: 0, peak: 0, error: 'device disconnected' })
    })
    expect(screen.getByText('Input preview unavailable')).toBeInTheDocument()
  })

  it('token-scopes cleanup when the selected microphone changes', async () => {
    const { rerender } = render(<InputLevelMeter deviceId="built-in" active={true} />)
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))
    const firstSessionId = mocks.start.mock.calls[0][1]

    rerender(<InputLevelMeter deviceId="studio" active={true} />)

    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2))
    expect(mocks.stop).toHaveBeenCalledWith(firstSessionId)
    expect(mocks.start.mock.calls[1][0]).toBe('studio')
    expect(mocks.start.mock.calls[1][1]).not.toBe(firstSessionId)
  })
})
