import { act, renderHook } from '@testing-library/react'
import { useSidebarCollapsed } from './useSidebarCollapsed'

/** Installs a `matchMedia` whose narrow-window query can be flipped by the returned setter. */
function mockNarrow(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return matches
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }))
  return (next: boolean) => {
    matches = next
    listeners.forEach(listener => listener())
  }
}

describe('useSidebarCollapsed', () => {
  beforeEach(() => window.localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('starts expanded when nothing is stored', () => {
    const { result } = renderHook(() => useSidebarCollapsed())
    expect(result.current.collapsed).toBe(false)
  })

  // Issue #34: the manual collapse choice survives a restart.
  it('starts collapsed when the stored preference says so', () => {
    window.localStorage.setItem('minute.sidebarCollapsed', 'true')
    const { result } = renderHook(() => useSidebarCollapsed())
    expect(result.current.collapsed).toBe(true)
  })

  it('stores the manual choice', () => {
    const { result } = renderHook(() => useSidebarCollapsed())
    act(() => result.current.setCollapsed(true))
    expect(result.current.collapsed).toBe(true)
    expect(window.localStorage.getItem('minute.sidebarCollapsed')).toBe('true')
    act(() => result.current.setCollapsed(false))
    expect(window.localStorage.getItem('minute.sidebarCollapsed')).toBe('false')
  })

  it('collapses in a narrow window and restores the stored choice when it widens', () => {
    const setNarrow = mockNarrow(true)
    const { result } = renderHook(() => useSidebarCollapsed())
    expect(result.current.collapsed).toBe(true)
    act(() => setNarrow(false))
    expect(result.current.collapsed).toBe(false)
    act(() => setNarrow(true))
    expect(result.current.collapsed).toBe(true)
  })

  it('lets the sidebar be reopened while the window is still narrow', () => {
    mockNarrow(true)
    const { result } = renderHook(() => useSidebarCollapsed())
    act(() => result.current.setCollapsed(false))
    expect(result.current.collapsed).toBe(false)
  })
})
