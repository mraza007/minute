import { useLayoutEffect, useRef } from 'react'
import { handleMenuKeyDown } from './menuKeys'
import { FILTER_SECTIONS, type FilterSection, type LibraryFilters } from './libraryFilters'

interface LibraryFilterMenuProps {
  /** Bottom edge of the invoking button, in viewport coordinates. */
  anchorBottom: number
  filters: LibraryFilters
  onChange: <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) => void
  onSelectNotes: () => void
  onClose: () => void
}

function MenuSection<K extends keyof LibraryFilters>({
  section,
  filters,
  onChange,
}: {
  section: FilterSection<K>
  filters: LibraryFilters
  onChange: LibraryFilterMenuProps['onChange']
}) {
  return (
    <div role="group" aria-label={section.label} className="filter-menu-section">
      <div className="filter-menu-label" aria-hidden="true">{section.label}</div>
      {section.options.map(option => {
        const checked = filters[section.key] === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            tabIndex={-1}
            className="filter-menu-item"
            onClick={() => onChange(section.key, option.value)}
          >
            <span>{option.label}</span>
            {checked && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The sidebar's single sort / filter / select menu. Radio items keep the menu
 * open so several choices can be made in one visit; Escape, Tab or a click
 * outside closes it.
 */
export function LibraryFilterMenu({ anchorBottom, filters, onChange, onSelectNotes, onClose }: LibraryFilterMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }, [])

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
      <div
        ref={menuRef}
        className="filter-menu"
        role="menu"
        aria-label="Sort and filter notes"
        style={{ top: anchorBottom + 6, maxHeight: `calc(100vh - ${anchorBottom + 18}px)` }}
        onKeyDown={e => handleMenuKeyDown(e, onClose)}
      >
        {FILTER_SECTIONS.map(section => (
          <MenuSection key={section.key} section={section} filters={filters} onChange={onChange} />
        ))}
        <div className="filter-menu-section">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="filter-menu-item"
            onClick={() => {
              onClose()
              onSelectNotes()
            }}
          >
            Select notes…
          </button>
        </div>
      </div>
    </>
  )
}
