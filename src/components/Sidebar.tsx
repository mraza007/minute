import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { NoteListItem, View } from '../types'

interface SidebarProps {
  notes: NoteListItem[]
  selectedNoteId: string | null
  onSelect: (id: string) => void
  view: View
  onGoNotes: () => void
  onGoSettings: () => void
  statsLine: string
  /** Sidebar filter input's current value — controlled, so clearing it (e.g. programmatically) is reflected here. */
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  /**
   * `null` when no filter is active — every note renders, grouped as normal
   * (Today/Yesterday/…). A `Set` of note ids once a debounced `search_notes`
   * call has resolved for the current (non-blank) `searchQuery` — only
   * matching notes render, as a flat list (no group headers: a filtered
   * result set is a different kind of view than browsing, and recomputing
   * "first of a consecutive run" against a filtered subsequence would
   * misattribute a header to a note that no longer actually sits next to
   * what it was grouped with).
   */
  matchedNoteIds: Set<string> | null
  /** ⌘K badge click — opens the search palette (same shortcut as ⌘K/⌘F). */
  onOpenPalette: () => void
  onStartRecording: () => void
  onTogglePinned: (id: string, pinned: boolean) => void
  onOpenShortcuts: () => void
  onBulkExport: (ids: string[]) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
}

const navBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  padding: '6px 0',
  border: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 500,
  color: 'var(--ink-muted)',
  cursor: 'pointer',
  textAlign: 'left',
}

const navCurrent: CSSProperties = { color: 'var(--ink)', fontWeight: 600 }

const emptyStyle: CSSProperties = {
  padding: '24px 18px',
  fontFamily: 'var(--serif)',
  fontSize: 13.5,
  color: 'var(--ink-muted)',
  lineHeight: 1.6,
}

// Memoized — the recording view's 1Hz elapsed-time tick re-renders App,
// which would otherwise re-render Sidebar every second even though none of
// its props actually change during a recording. Only pays off once App
// stops handing it fresh object/array/lambda props each render — see
// useAppState's useCallback'd goNotes/goSettings/setSidebarQuery and the
// memoized `sidebarNotes`/`statsLine`.
export const Sidebar = memo(function Sidebar({
  notes,
  selectedNoteId,
  onSelect,
  view,
  onGoNotes,
  onGoSettings,
  statsLine,
  searchQuery,
  onSearchQueryChange,
  matchedNoteIds,
  onOpenPalette,
  onStartRecording,
  onTogglePinned,
  onOpenShortcuts,
  onBulkExport,
  onBulkDelete,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 1280px)').matches : false,
  )
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState('all')
  const [sortOrder, setSortOrder] = useState('newest')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkDeleteArmed, setBulkDeleteArmed] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 1280px)')
    const sync = () => setCollapsed(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const structuredFiltering = statusFilter !== 'all' || sourceFilter !== 'all' || dateFilter !== 'all'
  const filtering = matchedNoteIds !== null || structuredFiltering || sortOrder !== 'newest'
  const visibleNotes = useMemo(() => {
    const now = Date.now()
    const filtered = notes.filter(note => {
      if (matchedNoteIds !== null && !matchedNoteIds.has(note.id)) return false
      if (statusFilter === 'pinned' && !note.pinned) return false
      if (statusFilter === 'recording' && note.status !== 'recording') return false
      if (statusFilter === 'ready' && note.status !== 'ready') return false
      if (statusFilter === 'transcribed' && note.status !== 'transcribed') return false
      if (sourceFilter === 'system' && !note.sources?.includes('system')) return false
      if (sourceFilter === 'mic' && note.sources?.includes('system')) return false
      if (dateFilter !== 'all') {
        const created = note.createdAt ? new Date(note.createdAt).getTime() : 0
        const age = now - created
        if (dateFilter === 'today' && age > 86_400_000) return false
        if (dateFilter === 'week' && age > 7 * 86_400_000) return false
      }
      return true
    })
    return filtered.toSorted((a, b) => {
      if (sortOrder === 'oldest') {
        return new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
      }
      if (sortOrder === 'duration') {
        return Number.parseFloat(b.meta) - Number.parseFloat(a.meta)
      }
      if (sortOrder === 'title') {
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      }
      return new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
    })
  }, [dateFilter, matchedNoteIds, notes, sortOrder, sourceFilter, statusFilter])

  function clearFilters() {
    setStatusFilter('all')
    setSourceFilter('all')
    setDateFilter('all')
    setSortOrder('newest')
    onSearchQueryChange('')
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

  return (
    <nav
      aria-label="Notes"
      className="library-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="sidebar-orientation">
        {!collapsed && <span className="mlab">Library</span>}
        <button
          type="button"
          className="icon-btn sidebar-collapse"
          aria-label={collapsed ? 'Expand library sidebar' : 'Collapse library sidebar'}
          title={collapsed ? 'Expand library sidebar' : 'Collapse library sidebar'}
          onClick={() => setCollapsed(value => !value)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
            <path d={collapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
          </svg>
        </button>
      </div>
      {/* Search as a ruled line, not a boxed field — the sidebar is an index
          page, and a raised input with its own border and shadow was the
          loudest thing on it. */}
      <div
        className="sidebar-search"
        style={{
          margin: '16px 18px 6px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <input
          placeholder="Search notes"
          aria-label="Search notes"
          className="input-ruled"
          value={searchQuery}
          onChange={e => onSearchQueryChange(e.target.value)}
          style={{ flex: 1, borderBottom: 'none' }}
        />
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Open search palette"
          title="Open search palette (⌘K)"
          style={{
            border: 'none',
            background: 'none',
            padding: '0 0 8px',
            fontFamily: 'inherit',
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: '.04em',
            color: 'var(--ink-faint)',
            cursor: 'pointer',
            flex: 'none',
          }}
        >
          ⌘K
        </button>
      </div>

      <div className="sidebar-filters" aria-label="Library filters">
        <select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          <option value="all">All status</option>
          <option value="pinned">Pinned</option>
          <option value="ready">Summarized</option>
          <option value="transcribed">Needs summary</option>
          <option value="recording">Recording</option>
        </select>
        <select aria-label="Filter by source" value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}>
          <option value="all">All sources</option>
          <option value="mic">Microphone</option>
          <option value="system">System audio</option>
        </select>
        <select aria-label="Filter by date" value={dateFilter} onChange={event => setDateFilter(event.target.value)}>
          <option value="all">Any date</option>
          <option value="today">Past 24 hours</option>
          <option value="week">Last 7 days</option>
        </select>
        <select aria-label="Sort notes" value={sortOrder} onChange={event => setSortOrder(event.target.value)}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="duration">Longest first</option>
          <option value="title">Title A–Z</option>
        </select>
      </div>

      {!collapsed && (
        <div className="sidebar-bulk-tools" aria-label="Library actions">
          {selectionMode ? (
            <>
              <span role="status">{selectedIds.size} selected</span>
              <button type="button" disabled={selectedIds.size === 0 || bulkPending} onClick={() => void runBulk(onBulkExport)}>
                Export
              </button>
              <button
                type="button"
                className="danger"
                disabled={selectedIds.size === 0 || bulkPending}
                onClick={() => {
                  if (!bulkDeleteArmed) {
                    setBulkDeleteArmed(true)
                    return
                  }
                  void runBulk(onBulkDelete)
                }}
              >
                {bulkDeleteArmed ? `Confirm delete ${selectedIds.size}` : 'Delete'}
              </button>
              <button type="button" disabled={bulkPending} onClick={leaveSelectionMode}>Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setSelectionMode(true)}>Select notes</button>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 0 0' }}>
        {notes.length === 0 && !collapsed && (
          <div style={emptyStyle}>
            <div>No notes yet.</div>
            <button type="button" className="empty-action" onClick={onStartRecording}>Start your first recording</button>
          </div>
        )}
        {notes.length > 0 && filtering && visibleNotes.length === 0 && (
          <div style={emptyStyle}>
            <div>{searchQuery.trim() ? `No matches for “${searchQuery.trim()}”` : 'No notes match these filters.'}</div>
            <button type="button" className="empty-action" onClick={clearFilters}>Clear filters</button>
          </div>
        )}
        {visibleNotes.map(note => (
          <div key={note.id}>
            {!filtering && note.group && (
              <div className="mlab" style={{ padding: '15px 18px 7px' }}>
                {note.group}
              </div>
            )}
            <div className="side-row-wrap">
              {selectionMode && !collapsed && (
                <input
                  type="checkbox"
                  className="side-row-select"
                  aria-label={`Select ${note.title}`}
                  checked={selectedIds.has(note.id)}
                  onChange={() => toggleSelected(note.id)}
                />
              )}
              <button
                onClick={() => onSelect(note.id)}
                className="side-row"
                aria-current={note.id === selectedNoteId ? 'true' : undefined}
                aria-label={collapsed ? `${note.title} ${note.meta}` : undefined}
                title={note.title}
              >
                {collapsed ? (
                  <span className="side-row-monogram" aria-hidden="true">
                    {note.title.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase()}
                  </span>
                ) : (
                  <>
                    <span className="side-row-title">{note.title}</span>
                    <span className="side-row-meta">{note.meta}</span>
                  </>
                )}
              </button>
              {!collapsed && (
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

      <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--rule)' }}>
        <button
          onClick={onGoNotes}
          aria-label="All notes"
          aria-current={view === 'notes' ? 'page' : undefined}
          style={{ ...navBase, ...(view === 'notes' ? navCurrent : null) }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"></path>
            <path d="M15 3v6h6"></path>
          </svg>
          <span className="sidebar-nav-label">All notes</span>
        </button>
        <button
          onClick={onGoSettings}
          aria-label="Settings"
          aria-current={view === 'settings' ? 'page' : undefined}
          style={{ ...navBase, ...(view === 'settings' ? navCurrent : null) }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"></path>
          </svg>
          <span className="sidebar-nav-label">Settings</span>
        </button>
        <button
          type="button"
          onClick={onOpenShortcuts}
          aria-label="Keyboard shortcuts"
          style={navBase}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="6" width="18" height="12" rx="2" />
            <path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" />
          </svg>
          <span className="sidebar-nav-label">Keyboard shortcuts</span>
        </button>
        {/* Sentence case, not the uppercase micro label: at .11em tracking
            this line runs past the 238px sidebar and orphans its last word
            onto a second row. It's a quiet footnote anyway, not a heading. */}
        <div className="sidebar-stats" style={{ marginTop: 11, fontSize: 10.5, lineHeight: 1.5, color: 'var(--ink-faint)' }}>{statsLine}</div>
      </div>
    </nav>
  )
})
