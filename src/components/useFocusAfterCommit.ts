import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * Moves focus to an element that only becomes focusable on the next render,
 * such as a button that mounts or re-enables after a state change. Call
 * `requestFocus` in the same handler as the state update. A timer can fire
 * before React commits that update, which leaves focus on `<body>`.
 */
export function useFocusAfterCommit(): (getTarget: () => HTMLElement | null) => void {
  const pending = useRef<(() => HTMLElement | null) | null>(null)

  useLayoutEffect(() => {
    const getTarget = pending.current
    if (!getTarget) return
    pending.current = null
    getTarget()?.focus()
  })

  return useCallback(getTarget => {
    pending.current = getTarget
  }, [])
}
