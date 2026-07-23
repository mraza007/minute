import type { CSSProperties } from 'react'
import type { NoteListItem, View } from '../types'

interface SidebarProps {
  notes: NoteListItem[]
  sel: number
  onSelect: (i: number) => void
  view: View
  onGoNotes: () => void
  onGoSettings: () => void
}

const navBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  width: '100%',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  color: '#1c1a18',
  cursor: 'pointer',
  textAlign: 'left',
}

export function Sidebar({ notes, sel, onSelect, view, onGoNotes, onGoSettings }: SidebarProps) {
  return (
    <div
      style={{
        width: 250,
        flex: 'none',
        background: '#eceae7',
        borderRight: '1px solid rgba(0,0,0,.09)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '12px 12px 4px', position: 'relative' }}>
        <input
          placeholder="Search notes…"
          className="input-focus"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 40px 8px 12px',
            border: '1px solid rgba(0,0,0,.12)',
            borderRadius: 8,
            background: '#fff',
            fontFamily: 'inherit',
            fontSize: 13,
            color: '#1c1a18',
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
            border: '1px solid rgba(0,0,0,.12)',
            borderRadius: 5,
            background: '#faf9f7',
            fontSize: 10.5,
            fontWeight: 600,
            color: '#9a938c',
          }}
        >
          ⌘K
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {notes.map((note, i) => (
          <div key={i}>
            {note.group && (
              <div style={{ padding: '14px 10px 5px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#9a938c' }}>
                {note.group}
              </div>
            )}
            <button
              onClick={() => onSelect(i)}
              className={i === sel ? undefined : 'hov-dark'}
              style={{
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 8,
                background: i === sel ? '#fff' : 'transparent',
                boxShadow: i === sel ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
                fontFamily: 'inherit',
                textAlign: 'left',
                color: 'inherit',
              }}
            >
              <span style={{ display: 'block', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {note.title}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: '#8d867f', marginTop: 1 }}>{note.meta}</span>
            </button>
          </div>
        ))}
      </div>
      <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(0,0,0,.08)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button
          onClick={onGoNotes}
          className="hov-dark6"
          style={{ ...navBase, background: view === 'notes' ? 'rgba(0,0,0,.07)' : 'transparent' }}
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
          style={{ ...navBase, background: view === 'settings' ? 'rgba(0,0,0,.07)' : 'transparent' }}
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
        <div style={{ padding: '8px 10px 2px', fontSize: 11, color: '#9a938c' }}>14 notes · 3.2 GB local · nothing synced</div>
      </div>
    </div>
  )
}
