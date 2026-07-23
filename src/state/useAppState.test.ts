import { renderHook, act } from '@testing-library/react'
import { useAppState } from './useAppState'

describe('useAppState', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts on notes view with Acme call selected', () => {
    const { result } = renderHook(() => useAppState())
    expect(result.current.view).toBe('notes')
    expect(result.current.sel).toBe(2)
    expect(result.current.noteTab).toBe('transcript')
  })

  it('startRec switches to recording and ticks the timer', () => {
    const { result } = renderHook(() => useAppState())
    act(() => result.current.startRec())
    expect(result.current.view).toBe('recording')
    expect(result.current.recSeconds).toBe(872)
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current.recSeconds).toBe(875)
  })

  it('pause freezes the timer, resume continues', () => {
    const { result } = renderHook(() => useAppState())
    act(() => result.current.startRec())
    act(() => result.current.togglePause())
    act(() => vi.advanceTimersByTime(5000))
    expect(result.current.recSeconds).toBe(872)
    act(() => result.current.togglePause())
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current.recSeconds).toBe(874)
  })

  it('stopRec returns to notes, selects newest, shows summarizing for 3.2s', () => {
    const { result } = renderHook(() => useAppState())
    act(() => result.current.startRec())
    act(() => result.current.stopRec())
    expect(result.current.view).toBe('notes')
    expect(result.current.sel).toBe(0)
    expect(result.current.summarizing).toBe(true)
    act(() => vi.advanceTimersByTime(3200))
    expect(result.current.summarizing).toBe(false)
  })

  it('toggleAction flips done state', () => {
    const { result } = renderHook(() => useAppState())
    expect(result.current.actions[1].done).toBe(false)
    act(() => result.current.toggleAction(1))
    expect(result.current.actions[1].done).toBe(true)
  })

  it('ask captures the draft question', () => {
    const { result } = renderHook(() => useAppState())
    act(() => result.current.setAskDraft('what about pricing?'))
    act(() => result.current.ask())
    expect(result.current.asked).toBe(true)
    expect(result.current.askText).toBe('what about pricing?')
  })

  it('askText falls back to the default question', () => {
    const { result } = renderHook(() => useAppState())
    act(() => result.current.ask())
    expect(result.current.askText).toBe('What did we promise Acme?')
  })

  it('recTime formats mm:ss', () => {
    const { result } = renderHook(() => useAppState())
    expect(result.current.recTime).toBe('14:32')
  })
})
