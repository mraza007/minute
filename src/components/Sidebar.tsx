import { memo, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NoteListItem, View } from '../types'
import { NoteContextMenu } from './NoteContextMenu'
import { LibraryFilterMenu } from './LibraryFilterMenu'
import { DEFAULT_FILTERS, isFiltering, type LibraryFilters } from './libraryFilters'

interface SidebarProps {
  notes: NoteListItem[]
  selectedNoteId: string | null
  onSelect: (id: string) => void
  view: View
  /** Returns to the notes view with no note open — what choosing "All notes" does from another screen. */
  onGoNotes: () => void
  onGoSettings: () => void
  statsLine: string
  /** Search field click — opens the ⌘K palette. */
  onOpenPalette: () => void
  onStartRecording: () => void
  isRecording: boolean
  recTime: string
  /** The red "Recording" row returns to the live recording view from any screen. */
  onReturnToRecording: () => void
  /** Per-note summary lifecycle: a running entry puts "Summarizing…" on that note's row, a queued one "Summary waiting". */
  summaryStatus: Readonly<Record<string, string>>
  onTogglePinned: (id: string, pinned: boolean) => void
  onOpenShortcuts: () => void
  onBulkExport: (ids: string[]) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRenameNote: (id: string, title: string) => void
  onRevealNote: (id: string) => void
  /** Hidden entirely while collapsed; the toolbar's "Notes" button brings it back (see `useSidebarCollapsed`). */
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
}

function applyFilters(notes: NoteListItem[], filters: LibraryFilters): NoteListItem[] {
  const now = Date.now()
  const filtered = notes.filter(note => {
    if (filters.status === 'pinned' && !note.pinned) return false
    if (filters.status === 'recording' && note.status !== 'recording') return false
    // "Summarized" / "Needs summary" test real summary presence, not
    // `note.status` (issue #18) — status and summary can disagree on
    // notes from older builds and on notes whose summarization never
    // completed. A still-recording note needs a transcript first, not a
    // summary, so it is neither.
    if (filters.status === 'ready' && !note.hasSummary) return false
    if (filters.status === 'transcribed' && (note.hasSummary || note.status === 'recording')) return false
    if (filters.source === 'system' && !note.sources?.includes('system')) return false
    if (filters.source === 'mic' && note.sources?.includes('system')) return false
    if (filters.date !== 'all') {
      const created = note.createdAt ? new Date(note.createdAt).getTime() : 0
      const age = now - created
      if (filters.date === 'today' && age > 86_400_000) return false
      if (filters.date === 'week' && age > 7 * 86_400_000) return false
    }
    return true
  })
  return filtered.toSorted((a, b) => {
    if (filters.sort === 'oldest') {
      return new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
    }
    if (filters.sort === 'duration') {
      return Number.parseFloat(b.meta) - Number.parseFloat(a.meta)
    }
    if (filters.sort === 'title') {
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }
    return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
  })
}

function RowStatus({ note, summaryState }: { note: NoteListItem; summaryState: string | undefined }) {
  if (note.status === 'recording') return <span className="side-row-status" data-tone="red">Recording…</span>
  if (summaryState === 'running') return <span className="side-row-status" data-tone="blue">Summarizing…</span>
  if (summaryState === 'queued') return <span className="side-row-status" data-tone="amber">Summary waiting</span>
  return <span className="side-row-meta">{note.meta}</span>
}

function Icon({ children, size = 14, strokeWidth = 2 }: { children: ReactNode; size?: number; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// Memoized — the recording view's 1Hz elapsed-time tick re-renders App,
// which would otherwise re-render Sidebar every second even though none of
// its props actually change during a recording. Only pays off once App
// stops handing it fresh object/array/lambda props each render — see
// useAppState's useCallback'd goNotes/goSettings and the memoized
// `sidebarNotes`/`statsLine`. While recording, `recTime` does change each
// second, which is the one re-render this row legitimately needs.
export const Sidebar = memo(function Sidebar({
  notes,
  selectedNoteId,
  onSelect,
  view,
  onGoNotes,
  onGoSettings,
  statsLine,
  onOpenPalette,
  onStartRecording,
  isRecording,
  recTime,
  onReturnToRecording,
  summaryStatus,
  onTogglePinned,
  onOpenShortcuts,
  onBulkExport,
  onBulkDelete,
  onRenameNote,
  onRevealNote,
  collapsed,
  onSetCollapsed,
}: SidebarProps) {
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_FILTERS)
  const [menuAnchor, setMenuAnchor] = useState<number | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkDeleteArmed, setBulkDeleteArmed] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)
  /** The row whose right-click menu is open, and where to place it. */
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  /** The row currently renaming inline (context menu's Rename). */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)

  /** Commits an inline rename the same way NoteView's title edit does: only a non-blank, actually-changed draft calls out. */
  function commitRename(note: NoteListItem, draft: string) {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== note.title) onRenameNote(note.id, trimmed)
    setRenamingId(null)
  }

  const filtering = isFiltering(filters)
  const visibleNotes = useMemo(() => applyFilters(notes, filters), [filters, notes])

  function setFilter<K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) {
    setFilters(current => ({ ...current, [key]: value }))
    // "All notes" is where the old footer item lived: from Settings or a
    // live recording it also brings the notes view back.
    if (key === 'status' && value === 'all' && view !== 'notes') onGoNotes()
  }

  function closeFilterMenu() {
    setMenuAnchor(null)
    requestAnimationFrame(() => filterButtonRef.current?.focus())
  }

  function leaveSelectionMode() {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setBulkDeleteArmed(false)
  }

  function toggleSelected(id: string) {
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setBulkDeleteArmed(false)
  }

  async function runBulk(action: (ids: string[]) => Promise<void>) {
    const ids = Array.from(selectedIds)
    if (ids.length === 0 || bulkPending) return
    setBulkPending(true)
    try {
      await action(ids)
      leaveSelectionMode()
    } finally {
      setBulkPending(false)
    }
  }

  const selectCount = selectedIds.size
  const showSelect = selectionMode

  return (
    <nav aria-label="Notes" className="library-sidebar" data-collapsed={collapsed ? 'true' : 'false'} hidden={collapsed}>
      {/* Clears the macOS traffic lights (the window uses an overlay title
          bar) and doubles as the window's drag handle. */}
      <div className="sidebar-top" data-tauri-drag-region="" />
      <div className="sidebar-orientation">
        <button
          type="button"
          className="icon-btn sidebar-collapse"
          aria-label="Collapse library sidebar"
          title="Collapse library sidebar"
          onClick={() => onSetCollapsed(true)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
            <path d="m16 9-3 3 3 3" />
          </svg>
        </button>
      </div>

      {showSelect ? (
        <div className="sidebar-select-head">
          <span role="status">{selectCount} selected</span>
          <button type="button" disabled={bulkPending} onClick={leaveSelectionMode}>Done</button>
        </div>
      ) : (
        <div className="sidebar-tools">
          {isRecording ? (
            <button type="button" className="sidebar-record" data-recording="true" aria-label="Return to recording" onClick={onReturnToRecording}>
              <span className="sidebar-record-lead">
                <span className="sidebar-record-dot blink-dot" />
                <span className="sidebar-nav-label">Recording</span>
              </span>
              <span className="sidebar-nav-label sidebar-record-time">{recTime}</span>
            </button>
          ) : (
            <button type="button" className="sidebar-record" aria-label="New recording" onClick={onStartRecording}>
              <span className="sidebar-record-dot" />
              <span className="sidebar-nav-label">New recording</span>
            </button>
          )}
          <div className="sidebar-search-row">
            <button
              type="button"
              className="sidebar-search-field"
              onClick={onOpenPalette}
              aria-label="Search notes"
              title="Search notes (⌘K)"
            >
              <Icon><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>
              <span className="sidebar-search-label">Search</span>
              <span className="sidebar-search-key">⌘K</span>
            </button>
            <button
              ref={filterButtonRef}
              type="button"
              className="sidebar-filter-btn"
              aria-label="Sort and filter notes"
              title="Sort and filter notes"
              aria-haspopup="menu"
              aria-expanded={menuAnchor !== null}
              data-active={filtering ? 'true' : 'false'}
              onClick={event => setMenuAnchor(event.currentTarget.getBoundingClientRect().bottom)}
            >
              <Icon><path d="M4 7h16M7 12h10M10 17h4" /></Icon>
            </button>
          </div>
        </div>
      )}

      {menuAnchor !== null && (
        <LibraryFilterMenu
          anchorBottom={menuAnchor}
          filters={filters}
          onChange={setFilter}
          onSelectNotes={() => setSelectionMode(true)}
          onClose={closeFilterMenu}
        />
      )}

      <div className="sidebar-list">
        {notes.length === 0 && <div className="sidebar-empty">Your notes appear here.</div>}
        {notes.length > 0 && filtering && visibleNotes.length === 0 && (
          <div className="sidebar-empty">
            <div>No notes match these filters.</div>
            <button type="button" className="empty-action" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</button>
          </div>
        )}
        {visibleNotes.map(note => (
          <div key={note.id}>
            {!filtering && note.group && <div className="side-group">{note.group}</div>}
            <div className="side-row-wrap">
              {showSelect ? (
                <label className="side-row side-row-selectable" data-selected={selectedIds.has(note.id) ? 'true' : 'false'}>
                  <input
                    type="checkbox"
                    className="side-row-check"
                    aria-label={`Select ${note.title}`}
                    checked={selectedIds.has(note.id)}
                    onChange={() => toggleSelected(note.id)}
                  />
                  <span className="side-row-text">
                    <span className="side-row-title">{note.title}</span>
                    <RowStatus note={note} summaryState={summaryStatus[note.id]} />
                  </span>
                </label>
              ) : renamingId === note.id ? (
                <input
                  className="side-row-rename"
                  defaultValue={note.title}
                  aria-label={`Rename ${note.title}`}
                  autoFocus
                  onFocus={e => e.currentTarget.select()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitRename(note, e.currentTarget.value)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onBlur={e => commitRename(note, e.currentTarget.value)}
                />
              ) : (
                <button
                  onClick={() => onSelect(note.id)}
                  onContextMenu={e => {
                    e.preventDefault()
                    setContextMenu({ id: note.id, x: e.clientX, y: e.clientY })
                  }}
                  className="side-row"
                  aria-current={note.id === selectedNoteId ? 'true' : undefined}
                  title={note.title}
                >
                  <span className="side-row-title">{note.title}</span>
                  <RowStatus note={note} summaryState={summaryStatus[note.id]} />
                </button>
              )}
              {!showSelect && (
                <button
                  type="button"
                  className="side-row-pin"
                  aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                  title={note.pinned ? 'Unpin note' : 'Pin note'}
                  data-active={note.pinned ? 'true' : 'false'}
                  onClick={() => onTogglePinned(note.id, !note.pinned)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill={note.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="m12 17-5 3 1.5-5.8L4 10.5l5.9-.4L12 4.5l2.1 5.6 5.9.4-4.5 3.7L17 20Z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {contextMenu && (() => {
        const menuNote = notes.find(n => n.id === contextMenu.id)
        if (!menuNote) return null
        return (
          <NoteContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            label={`Actions for “${menuNote.title}”`}
            onClose={() => setContextMenu(null)}
            actions={[
              {
                label: 'Rename',
                onAction: () => setRenamingId(menuNote.id),
              },
              { label: menuNote.pinned ? 'Unpin' : 'Pin', onAction: () => onTogglePinned(menuNote.id, !menuNote.pinned) },
              { label: 'Reveal in Finder', onAction: () => onRevealNote(menuNote.id) },
              { label: 'Export…', onAction: () => void onBulkExport([menuNote.id]) },
              { label: 'Delete', destructive: true, onAction: () => void onBulkDelete([menuNote.id]) },
            ]}
          />
        )
      })()}

      {showSelect ? (
        <div className="sidebar-bulk-footer">
          <button type="button" disabled={selectCount === 0 || bulkPending} onClick={() => void runBulk(onBulkExport)}>
            {selectCount > 0 ? `Export ${selectCount}` : 'Export'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={selectCount === 0 || bulkPending}
            onClick={() => {
              if (!bulkDeleteArmed) {
                setBulkDeleteArmed(true)
                return
              }
              void runBulk(onBulkDelete)
            }}
          >
            {bulkDeleteArmed ? `Confirm delete ${selectCount}` : selectCount > 0 ? `Delete ${selectCount}` : 'Delete'}
          </button>
        </div>
      ) : (
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-settings"
            onClick={onGoSettings}
            aria-label="Settings"
            aria-current={view === 'settings' ? 'page' : undefined}
          >
            <Icon size={15} strokeWidth={1.8}>
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
            </Icon>
            <span className="sidebar-nav-label">Settings</span>
          </button>
          <div className="sidebar-footer-end">
            <span className="sidebar-stats">{statsLine}</span>
            <button
              type="button"
              className="icon-btn sidebar-shortcuts"
              onClick={onOpenShortcuts}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (⌘/)"
            >
              <Icon size={15} strokeWidth={1.8}>
                <rect x="3" y="6" width="18" height="12" rx="2" />
                <path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" />
              </Icon>
            </button>
          </div>
        </div>
      )}
    </nav>
  )
})
