import { useEffect, useRef } from 'react'

interface ShortcutReferenceProps {
  onClose: () => void
}

const SHORTCUT_GROUPS = [
  {
    title: 'Navigate',
    shortcuts: [
      ['⌘ K or ⌘ F', 'Search notes'],
      ['⌘ /', 'Show this reference'],
      ['← →', 'Move between note tabs'],
      ['↑ ↓', 'Move between transcript turns'],
      ['Esc', 'Close the current sheet'],
    ],
  },
  {
    title: 'Record',
    shortcuts: [
      ['⌘ ⇧ Space', 'Pause or resume'],
      ['⌘ ⇧ M', 'Add a marker'],
      ['⌘ ⇧ Return', 'Stop and transcribe'],
    ],
  },
] as const

export function ShortcutReference({ onClose }: ShortcutReferenceProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [],
      ).filter(element => !element.hasAttribute('disabled'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="shortcut-scrim" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={dialogRef}
        className="shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-reference-title"
      >
        <div className="shortcut-sheet-head">
          <div>
            <span className="mlab">Reference</span>
            <h2 id="shortcut-reference-title">Keyboard shortcuts</h2>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" aria-label="Close keyboard shortcuts" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <p className="shortcut-sheet-intro">
          Every core action remains available without a pointer. Shortcuts pause while a text field is active.
        </p>
        <div className="shortcut-groups">
          {SHORTCUT_GROUPS.map(group => (
            <section key={group.title}>
              <h3 className="mlab">{group.title}</h3>
              <dl>
                {group.shortcuts.map(([keys, label]) => (
                  <div key={keys}>
                    <dt>{label}</dt>
                    <dd><kbd>{keys}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
