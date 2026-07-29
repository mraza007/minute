import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'

export interface NoteContextMenuAction {
  label: string
  onAction: () => void
  /** Renders in the accent/destructive color — Delete. */
  destructive?: boolean
}

interface NoteContextMenuProps {
  /** Viewport coordinates of the invoking right-click. */
  x: number
  y: number
  /** Accessible name for the menu, e.g. `Actions for “Client call”`. */
  label: string
  actions: NoteContextMenuAction[]
  onClose: () => void
}

/**
 * The sidebar note row's right-click menu. A fixed-position ARIA menu at the
 * cursor: focus lands on the first item, ArrowUp/Down wrap through items,
 * Enter/Space activate, Escape or any click outside closes. Position is
 * clamped after first layout so the menu never renders past the viewport
 * edge when a note near the window's bottom is right-clicked.
 */
export function NoteContextMenu({ x, y, label, actions, onClose }: NoteContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const left = Math.min(x, Math.max(8, window.innerWidth - rect.width - 8))
    const top = Math.min(y, Math.max(8, window.innerHeight - rect.height - 8))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [x, y])

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
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

  return (
    <>
      {/* Click-away layer: any press outside the menu dismisses it — including
          another right-click, which the app-level contextmenu suppressor keeps
          from opening the webview's own menu. */}
      <div
        className="context-menu-backdrop"
        onMouseDown={onClose}
        onContextMenu={e => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="context-menu"
        role="menu"
        aria-label={label}
        style={{ left: x, top: y }}
        onKeyDown={handleKeyDown}
      >
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            data-destructive={action.destructive ? 'true' : undefined}
            onClick={() => {
              action.onAction()
              onClose()
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>
  )
}
