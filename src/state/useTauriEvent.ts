import { useEffect, useRef, type DependencyList } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'

/**
 * Subscribes to a Tauri event for the lifetime of the calling component.
 *
 * `subscribe` is expected to be one of the `src/ipc/events.ts` helpers
 * (`onDownloadProgress`, `onRecordingState`, ...) — a function that takes a
 * callback and returns a `Promise<UnlistenFn>`. Handles the async-unlisten
 * race: if the component unmounts (or `deps` change) before that promise
 * resolves, the resulting unlisten function is invoked the instant it
 * *does* resolve rather than being silently dropped — otherwise the
 * backend listener would leak until the whole webview tears down.
 */
export function useTauriEvent<T>(
  subscribe: (cb: (payload: T) => void) => Promise<UnlistenFn>,
  onEvent: (payload: T) => void,
  deps: DependencyList = [],
) {
  // Ref so a fresh `onEvent` closure (e.g. from a re-render) doesn't force
  // an unsubscribe/resubscribe cycle — only `deps` controls that.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    let live = true
    let unlisten: UnlistenFn | undefined

    subscribe(payload => onEventRef.current(payload)).then(fn => {
      if (live) {
        unlisten = fn
      } else {
        // Cleanup already ran before the subscribe promise settled —
        // unlisten immediately instead of leaking the backend listener.
        fn()
      }
    })

    return () => {
      live = false
      unlisten?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
