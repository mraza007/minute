import { useCallback, useEffect, useState } from 'react'

// Only the manual choice is stored (issue #34). A narrow window collapses
// the sidebar regardless, and widening it again restores the stored choice.
const SIDEBAR_COLLAPSED_KEY = 'minute.sidebarCollapsed'
// Below 1112px the 272px sidebar and the note page (a 720px column plus
// 120px of padding) no longer fit side by side.
const NARROW_QUERY = '(max-width: 1111px)'

function storedCollapsed(): boolean {
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
}

function narrowQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null
}

/**
 * Whether the library sidebar is hidden. Owned above the sidebar because the
 * control that brings it back (the toolbar's "Notes" button) lives outside
 * it.
 */
export function useSidebarCollapsed(): { collapsed: boolean; setCollapsed: (collapsed: boolean) => void } {
  const [collapsed, setCollapsedState] = useState(() => (narrowQuery()?.matches ?? false) || storedCollapsed())

  useEffect(() => {
    const query = narrowQuery()
    if (!query) return
    const sync = () => setCollapsedState(query.matches || storedCollapsed())
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  // Last click wins, including one made while a narrow window has the
  // sidebar collapsed: "peeking" and "changing my mind" look the same, and
  // one more click always restores the other choice.
  const setCollapsed = useCallback((next: boolean) => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
    setCollapsedState(next)
  }, [])

  return { collapsed, setCollapsed }
}
