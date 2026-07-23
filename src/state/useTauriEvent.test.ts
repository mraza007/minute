import { renderHook } from '@testing-library/react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { describe, expect, it, vi } from 'vitest'
import { useTauriEvent } from './useTauriEvent'

describe('useTauriEvent', () => {
  it('invokes the callback with event payloads delivered to the subscribed listener', async () => {
    let deliver: ((payload: number) => void) | undefined
    const subscribe = vi.fn((cb: (payload: number) => void) => {
      deliver = cb
      return Promise.resolve(vi.fn())
    })
    const onEvent = vi.fn()

    renderHook(() => useTauriEvent(subscribe, onEvent, []))
    // flush the subscribe() promise
    await Promise.resolve()
    await Promise.resolve()

    expect(subscribe).toHaveBeenCalledTimes(1)
    deliver?.(42)
    expect(onEvent).toHaveBeenCalledWith(42)
  })

  it('unmounting before subscribe() resolves unlistens immediately once it does (no leaked listener)', async () => {
    const unlisten = vi.fn()
    let resolveSubscribe: (fn: UnlistenFn) => void = () => {}
    const subscribe = vi.fn(
      () =>
        new Promise<UnlistenFn>(resolve => {
          resolveSubscribe = resolve
        }),
    )

    const { unmount } = renderHook(() => useTauriEvent(subscribe, vi.fn(), []))
    unmount()

    // still pending — unmounting before resolution must not call unlisten
    // (it doesn't exist yet) or throw.
    expect(unlisten).not.toHaveBeenCalled()

    resolveSubscribe(unlisten)
    await Promise.resolve()
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('unmounting after subscribe() has resolved calls unlisten once', async () => {
    const unlisten = vi.fn()
    const subscribe = vi.fn(() => Promise.resolve(unlisten))

    const { unmount } = renderHook(() => useTauriEvent(subscribe, vi.fn(), []))
    await Promise.resolve()
    await Promise.resolve()

    expect(unlisten).not.toHaveBeenCalled()
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('re-subscribes when deps change', async () => {
    const unlistenA = vi.fn()
    const unlistenB = vi.fn()
    const subscribe = vi.fn().mockReturnValueOnce(Promise.resolve(unlistenA)).mockReturnValueOnce(Promise.resolve(unlistenB))

    const { rerender } = renderHook(({ dep }) => useTauriEvent(subscribe, vi.fn(), [dep]), {
      initialProps: { dep: 1 },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(subscribe).toHaveBeenCalledTimes(1)

    rerender({ dep: 2 })
    await Promise.resolve()
    await Promise.resolve()

    expect(unlistenA).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})
