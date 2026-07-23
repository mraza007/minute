import type { ActionItem } from '../types'

interface AiNotesPanelProps {
  summarizing: boolean
  actions: ActionItem[]
  toggleAction: (i: number) => void
  asked: boolean
  askText: string
  askDraft: string
  setAskDraft: (v: string) => void
  ask: () => void
}

export function AiNotesPanel({ summarizing, actions, toggleAction, asked, askText, askDraft, setAskDraft, ask }: AiNotesPanelProps) {
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
      <div style={{ padding: '16px 16px 12px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>AI notes</div>
        <div style={{ fontSize: 11, color: '#9a938c' }}>generated locally · 4 s</div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {summarizing && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: '#fff',
              border: '1px solid rgba(224,68,48,.3)',
              borderRadius: 12,
              padding: '12px 16px',
              boxShadow: '0 1px 3px rgba(0,0,0,.04)',
              fontSize: 12.5,
              fontWeight: 600,
              color: '#b3200c',
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: '2px solid rgba(224,68,48,.25)',
                borderTopColor: '#e04430',
                animation: 'spin .8s linear infinite',
                flex: 'none',
              }}
            />
            Summarizing on-device — Qwen3.5-4B
          </div>
        )}
        <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,.07)', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#b3200c', marginBottom: 6 }}>SUMMARY</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: '#33302c', textWrap: 'pretty' }}>
            Acme is ready to expand the pilot from 20 to 200 seats in Q3, contingent on security review of the on-device architecture. Their pilot
            group also needs summary exports in their Monday digest format before Friday.
          </div>
        </div>
        <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,.07)', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#b3200c', marginBottom: 8 }}>DECISIONS</div>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: '#33302c', display: 'flex', gap: 8, marginBottom: 7 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1c1a18', flex: 'none', marginTop: 7 }} />
            Pilot expands to 200 seats in Q3 if security review passes.
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.55, color: '#33302c', display: 'flex', gap: 8 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1c1a18', flex: 'none', marginTop: 7 }} />
            Exports will match Acme's Monday digest template.
          </div>
        </div>
        <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,.07)', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#b3200c', marginBottom: 8 }}>ACTION ITEMS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {actions.map((act, i) => (
              <label key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={act.done} onChange={() => toggleAction(i)} style={{ marginTop: 3 }} />
                <span style={act.done ? { textDecoration: 'line-through', color: '#9a938c' } : { color: '#33302c' }}>{act.text}</span>
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn-light"
            style={{ flex: 1, padding: '8px 0', border: '1px solid rgba(0,0,0,.12)', borderRadius: 8, background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: '#1c1a18', cursor: 'pointer' }}
          >
            Copy
          </button>
          <button
            className="btn-light"
            style={{ flex: 1, padding: '8px 0', border: '1px solid rgba(0,0,0,.12)', borderRadius: 8, background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: '#1c1a18', cursor: 'pointer' }}
          >
            Export .md
          </button>
          <button
            className="btn-light"
            style={{ flex: 1, padding: '8px 0', border: '1px solid rgba(0,0,0,.12)', borderRadius: 8, background: '#fff', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: '#1c1a18', cursor: 'pointer' }}
          >
            Regenerate
          </button>
        </div>
      </div>
      <div style={{ borderTop: '1px solid rgba(0,0,0,.08)', padding: '14px 16px', flex: 'none' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.07em', color: '#6d675f', marginBottom: 8 }}>ASK YOUR NOTES</div>
        {asked && (
          <div
            style={{
              background: '#fff',
              border: '1px solid rgba(0,0,0,.08)',
              borderRadius: 12,
              padding: '12px 14px',
              marginBottom: 10,
              fontSize: 12.5,
              lineHeight: 1.6,
              boxShadow: '0 1px 3px rgba(0,0,0,.05)',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>“{askText}”</div>
            The pilot moves to 200 seats in Q3, pending Acme's security review — Tom Reyes confirmed at <b>01:34</b> in this call. Procurement
            starts once documentation is sent.
            <div style={{ marginTop: 8, fontSize: 11, color: '#9a938c' }}>Answered from 2 notes · on-device</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={askDraft}
            onChange={e => setAskDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') ask()
            }}
            placeholder="e.g. what did we promise Acme?"
            className="input-focus"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '9px 12px',
              border: '1px solid rgba(0,0,0,.12)',
              borderRadius: 999,
              background: '#fff',
              fontFamily: 'inherit',
              fontSize: 12.5,
              color: '#1c1a18',
              outline: 'none',
            }}
          />
          <button
            onClick={ask}
            className="btn-dark-accent"
            style={{
              width: 36,
              height: 36,
              flex: 'none',
              border: 'none',
              borderRadius: '50%',
              background: '#1c1a18',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12 7-7 7 7"></path>
              <path d="M12 19V5"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
