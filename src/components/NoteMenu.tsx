import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { handleMenuKeyDown } from './menuKeys'

/** How long a destructive item stays armed before it falls back to its first-click state. */
const CONFIRM_TIMEOUT_MS = 4000

export interface NoteMenuAction {
  id: string
  label: string
  /** Muted text at the row's right edge, e.g. the note's size. */
  detail?: string
  /** Starts a new group: a rule is drawn above this row. */
  startsGroup?: boolean
  destructive?: boolean
  disabled?: boolean
  /**
   * A two-step action. The first press swaps the label for `confirm.label`
   * and keeps the menu open; a second press within the timeout runs
   * `onSelect`. `confirm.note` says what the action does while it is armed.
   */
  confirm?: { label: string; note?: string }
  onSelect: () => void
}

interface NoteMenuProps {
  /** Accessible name for the menu. */
  label: string
  actions: NoteMenuAction[]
  onClose: () => void
}

/**
 * The note's "…" menu. Focus lands on the first item; arrows move, Escape,
 * Tab, or a press outside closes. Destructive items arm on the first press
 * rather than opening a dialog, so nothing is deleted by one stray click.
 */
export function NoteMenu({ label, actions, onClose }: NoteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [armedId, setArmedId] = useState<string | null>(null)
  const armTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [])

  useEffect(() => () => clearTimeout(armTimeout.current), [])

  function select(action: NoteMenuAction) {
    clearTimeout(armTimeout.current)
    if (action.confirm && armedId !== action.id) {
      setArmedId(action.id)
      armTimeout.current = setTimeout(() => setArmedId(null), CONFIRM_TIMEOUT_MS)
      return
    }
    setArmedId(null)
    action.onSelect()
    onClose()
  }

  const armed = actions.find(action => action.id === armedId)

  return (
    <>
      <div
        className="context-menu-backdrop"
        onMouseDown={onClose}
        onContextMenu={e => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="note-menu">
        <div ref={menuRef} role="menu" aria-label={label} onKeyDown={e => handleMenuKeyDown(e, onClose)}>
          {actions.map(action => {
            const isArmed = armedId === action.id
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="note-menu-item"
                data-group-start={action.startsGroup ? 'true' : undefined}
                data-destructive={action.destructive || isArmed ? 'true' : undefined}
                disabled={action.disabled}
                onClick={() => select(action)}
              >
                <span>{isArmed && action.confirm ? action.confirm.label : action.label}</span>
                {action.detail && <span className="note-menu-detail">{action.detail}</span>}
              </button>
            )
          })}
        </div>
        <div role="status" className={armed?.confirm?.note ? 'note-menu-note' : 'visually-hidden'}>
          {armed?.confirm ? (armed.confirm.note ?? 'Press again to confirm.') : ''}
        </div>
      </div>
    </>
  )
}
