import type { KeyboardEvent } from 'react'

/**
 * Keyboard behaviour shared by the app's ARIA menus: ArrowUp/Down wrap
 * through the items, Home/End jump to the ends, Escape or Tab closes.
 */
export function handleMenuKeyDown(e: KeyboardEvent<HTMLElement>, onClose: () => void): void {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'))
  if (items.length === 0) return
  const currentIndex = items.indexOf(document.activeElement as HTMLElement)
  const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus()
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      focusAt(currentIndex + 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      focusAt(currentIndex - 1)
      break
    case 'Home':
      e.preventDefault()
      focusAt(0)
      break
    case 'End':
      e.preventDefault()
      focusAt(items.length - 1)
      break
    case 'Escape':
    case 'Tab':
      e.preventDefault()
      onClose()
      break
  }
}
