import type { AppState } from '../state/useAppState'
import { noteMetaToListItem } from '../state/adapters'
import { MarkdownCard } from './MarkdownCard'
import { PlayerBar } from './PlayerBar'
import { TranscriptList } from './TranscriptList'

interface NoteViewProps {
  state: AppState
}

function EmptyNotesArea() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f7f6f4' }}>
      <div style={{ textAlign: 'center', maxWidth: 340 }}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>No notes yet</div>
        <div style={{ marginTop: 6, fontSize: 13, color: '#8d867f', lineHeight: 1.6 }}>
          Hit "New recording" in the title bar to capture your first meeting — transcription happens entirely on this
          Mac.
        </div>
      </div>
    </div>
  )
}

function AiPlaceholderPanel() {
  return (
    <div
      style={{
        width: 330,
        flex: 'none',
        borderLeft: '1px solid rgba(0,0,0,.07)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: '#f2f0ee',
      }}
    >
      <div style={{ padding: '16px 16px 12px', fontWeight: 700, fontSize: 14 }}>AI notes</div>
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#9a938c', marginBottom: 6 }}>SUMMARY</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#9a938c' }}>Summaries arrive in a later update.</div>
        </div>
      </div>
    </div>
  )
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'note'
}

export function NoteView({ state }: NoteViewProps) {
  if (state.notes.length === 0) {
    return <EmptyNotesArea />
  }

  const meta = state.notes[state.sel] ?? state.notes[0]
  const metaLine = noteMetaToListItem(meta, new Date()).meta
  const dateLabel = new Date(meta.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const noteMarkdown = `# ${meta.title}\n\nMarkdown export will include the full transcript once available.`

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, background: '#f7f6f4' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            padding: '22px 32px 16px',
            borderBottom: '1px solid rgba(0,0,0,.07)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontWeight: 700, fontSize: 21, letterSpacing: '-.02em' }}>{meta.title}</h1>
            <div style={{ marginTop: 4, fontSize: 12.5, color: '#8d867f' }}>
              {metaLine} · {dateLabel} · stored locally
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
            <div role="tablist" aria-label="Note content" style={{ display: 'flex', background: '#eceae7', borderRadius: 9, padding: 3 }}>
              <button
                role="tab"
                aria-selected={state.noteTab === 'transcript'}
                onClick={() => state.setNoteTab('transcript')}
                className={state.noteTab === 'transcript' ? undefined : 'seg-off'}
                style={{
                  padding: '5px 14px',
                  border: 'none',
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: state.noteTab === 'transcript' ? '#fff' : 'transparent',
                  color: state.noteTab === 'transcript' ? '#1c1a18' : '#6d675f',
                  boxShadow: state.noteTab === 'transcript' ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
                }}
              >
                Transcript
              </button>
              <button
                role="tab"
                aria-selected={state.noteTab === 'md'}
                onClick={() => state.setNoteTab('md')}
                className={state.noteTab === 'md' ? undefined : 'seg-off'}
                style={{
                  padding: '5px 14px',
                  border: 'none',
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: state.noteTab === 'md' ? '#fff' : 'transparent',
                  color: state.noteTab === 'md' ? '#1c1a18' : '#6d675f',
                  boxShadow: state.noteTab === 'md' ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
                }}
              >
                Markdown
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
              <button
                title="Rename"
                className="icon-btn"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: 8,
                  background: 'transparent',
                  color: '#6d675f',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                </svg>
              </button>
              <button
                title="Export"
                className="icon-btn"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: 8,
                  background: 'transparent',
                  color: '#6d675f',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
                  <polyline points="16 6 12 2 8 6"></polyline>
                  <line x1="12" x2="12" y1="2" y2="15"></line>
                </svg>
              </button>
              <button
                title="Delete"
                className="icon-btn-danger"
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: 8,
                  background: 'transparent',
                  color: '#6d675f',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18"></path>
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>
        {state.noteTab === 'transcript' && (
          <>
            {/* Real segments load via get_note in Task 10 — empty for now. */}
            <TranscriptList segments={[]} />
            <PlayerBar />
          </>
        )}
        {state.noteTab === 'md' && (
          <MarkdownCard filename={`${slugify(meta.title)}.md`} subtitle="saved locally" markdown={noteMarkdown} />
        )}
      </div>
      <AiPlaceholderPanel />
    </div>
  )
}
