import { demoNotes, demoTranscript } from '../data/demo'
import type { AppState } from '../state/useAppState'
import { AiNotesPanel } from './AiNotesPanel'
import { MarkdownCard } from './MarkdownCard'
import { PlayerBar } from './PlayerBar'
import { TranscriptList } from './TranscriptList'

interface NoteViewProps {
  state: AppState
}

export function NoteView({ state }: NoteViewProps) {
  const note = demoNotes[state.sel]

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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ margin: 0, fontWeight: 700, fontSize: 21, letterSpacing: '-.02em' }}>{note.title}</h1>
              {!state.summarizing && (
                <span style={{ padding: '3px 10px', borderRadius: 999, background: '#e9f5ec', color: '#1e7c34', fontSize: 11, fontWeight: 600 }}>
                  Summarized
                </span>
              )}
              {state.summarizing && (
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: '#fff4f1',
                    color: '#b3200c',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      border: '1.5px solid rgba(224,68,48,.3)',
                      borderTopColor: '#e04430',
                      animation: 'spin .8s linear infinite',
                    }}
                  />
                  Summarizing…
                </span>
              )}
            </div>
            <div style={{ marginTop: 4, fontSize: 12.5, color: '#8d867f' }}>{note.meta} · May 21, 2026 · stored locally</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
            <div style={{ display: 'flex', background: '#eceae7', borderRadius: 9, padding: 3 }}>
              <button
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
            <TranscriptList segments={demoTranscript} />
            <PlayerBar />
          </>
        )}
        {state.noteTab === 'md' && <MarkdownCard />}
      </div>
      <AiNotesPanel
        summarizing={state.summarizing}
        actions={state.actions}
        toggleAction={state.toggleAction}
        asked={state.asked}
        askText={state.askText}
        askDraft={state.askDraft}
        setAskDraft={state.setAskDraft}
        ask={state.ask}
      />
    </div>
  )
}
