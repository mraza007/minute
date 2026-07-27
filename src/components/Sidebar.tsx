import { memo, type CSSProperties } from 'react'
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
}: SidebarProps) {
  const filtering = matchedNoteIds !== null
  const visibleNotes = filtering ? notes.filter(note => matchedNoteIds.has(note.id)) : notes

  return (
    <nav
      aria-label="Notes"
      style={{
        width: 238,
        flex: 'none',
        background: 'var(--panel-warm)',
        borderRight: '1px solid var(--rule)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Search as a ruled line, not a boxed field — the sidebar is an index
          page, and a raised input with its own border and shadow was the
          loudest thing on it. */}
      <div
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

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 0 0' }}>
        {notes.length === 0 && <div style={emptyStyle}>No notes yet — hit "New recording".</div>}
        {notes.length > 0 && filtering && visibleNotes.length === 0 && (
          <div style={emptyStyle}>No matches for “{searchQuery.trim()}”</div>
        )}
        {visibleNotes.map(note => (
          <div key={note.id}>
            {!filtering && note.group && (
              <div className="mlab" style={{ padding: '15px 18px 7px' }}>
                {note.group}
              </div>
            )}
            <button
              onClick={() => onSelect(note.id)}
              className="side-row"
              aria-current={note.id === selectedNoteId ? 'true' : undefined}
            >
              <span className="side-row-title">{note.title}</span>
              <span className="side-row-meta">{note.meta}</span>
            </button>
          </div>
        ))}
      </div>

      <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--rule)' }}>
        <button
          onClick={onGoNotes}
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
          All notes
        </button>
        <button
          onClick={onGoSettings}
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
          Settings
        </button>
        {/* Sentence case, not the uppercase micro label: at .11em tracking
            this line runs past the 238px sidebar and orphans its last word
            onto a second row. It's a quiet footnote anyway, not a heading. */}
        <div style={{ marginTop: 11, fontSize: 10.5, lineHeight: 1.5, color: 'var(--ink-faint)' }}>{statsLine}</div>
      </div>
    </nav>
  )
})
