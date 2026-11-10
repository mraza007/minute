import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useToday } from './useToday'

describe('useToday', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps the same Date while the local day has not changed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 13, 9, 0))
    const { result } = renderHook(() => useToday())
    const first = result.current

    act(() => {
      vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    })

    expect(result.current).toBe(first)
  })

  it('moves to the new day within a minute of local midnight', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 13, 23, 59, 30))
    const { result } = renderHook(() => useToday())
    expect(result.current.getDate()).toBe(13)

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(result.current.getDate()).toBe(14)
  })

  it('moves to the new day when the window regains focus after a sleep', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 7, 13, 18, 0))
    const { result } = renderHook(() => useToday())

    vi.setSystemTime(new Date(2026, 7, 14, 8, 40))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(result.current.getDate()).toBe(14)
  })
})
