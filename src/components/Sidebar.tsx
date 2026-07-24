import { memo, type CSSProperties } from 'react'
import type { NoteListItem, View } from '../types'

interface SidebarProps {
  notes: NoteListItem[]
  sel: number
  onSelect: (i: number) => void
  view: View
  onGoNotes: () => void
  onGoSettings: () => void
  statsLine: string
}

const navBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink)',
  cursor: 'pointer',
  textAlign: 'left',
}

// Memoized — the recording view's 1Hz elapsed-time tick re-renders App,
// which would otherwise re-render Sidebar every second even though none of
// its props (notes/sel/view/statsLine/the three callbacks) actually change
// during a recording. Only pays off once App stops handing it fresh
// object/array/lambda props each render — see useAppState's useCallback'd
// goNotes/goSettings and the memoized `sidebarNotes`/`statsLine`.
export const Sidebar = memo(function Sidebar({ notes, sel, onSelect, view, onGoNotes, onGoSettings, statsLine }: SidebarProps) {
  return (
    <nav
      aria-label="Notes"
      style={{
        width: 250,
        flex: 'none',
        background: 'var(--panel-warm)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '12px 12px 4px', position: 'relative' }}>
        <input
          placeholder="Search notes…"
          aria-label="Search notes"
          className="input-focus"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 40px 8px 12px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--card)',
            fontFamily: 'inherit',
            fontSize: 13,
            color: 'var(--ink)',
            outline: 'none',
            boxShadow: '0 1px 2px rgba(0,0,0,.04)',
          }}
        />
        <span
          style={{
            position: 'absolute',
            right: 20,
            top: '50%',
            transform: 'translateY(-38%)',
            padding: '1px 6px',
            border: '1px solid var(--border-strong)',
            borderRadius: 5,
            background: 'var(--surface-softer)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--ink-faint)',
          }}
        >
          ⌘K
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {notes.length === 0 && (
          <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 13, color: 'var(--ink-muted)', lineHeight: 1.6 }}>
            No notes yet — hit "New recording"
          </div>
        )}
        {notes.map((note, i) => (
          <div key={i}>
            {note.group && (
              <div style={{ padding: '14px 10px 5px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: 'var(--ink-faint)' }}>
                {note.group}
              </div>
            )}
            <button
              onClick={() => onSelect(i)}
              className={i === sel ? undefined : 'hov-dark'}
              aria-current={i === sel ? 'true' : undefined}
              style={{
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                background: i === sel ? 'var(--card)' : 'transparent',
                boxShadow: i === sel ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
                fontFamily: 'inherit',
                textAlign: 'left',
                color: 'inherit',
              }}
            >
              <span style={{ display: 'block', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {note.title}
              </span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted)', marginTop: 1 }}>{note.meta}</span>
            </button>
          </div>
        ))}
      </div>
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          onClick={onGoNotes}
          className="hov-dark6"
          aria-current={view === 'notes' ? 'page' : undefined}
          style={{ ...navBase, background: view === 'notes' ? 'var(--border-soft)' : 'transparent' }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
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
          className="hov-dark6"
          aria-current={view === 'settings' ? 'page' : undefined}
          style={{ ...navBase, background: view === 'settings' ? 'var(--border-soft)' : 'transparent' }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"></path>
          </svg>
          Settings
        </button>
        <div style={{ padding: '8px 10px 2px', fontSize: 11, color: 'var(--ink-faint)' }}>{statsLine}</div>
      </div>
    </nav>
  )
})
