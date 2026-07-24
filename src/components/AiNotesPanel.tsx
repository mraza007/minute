import type { CSSProperties } from 'react'
import type { SummaryDoc } from '../ipc/types'

// Revived for Stage 3 Task 5 — real `SummaryDoc`s instead of the Stage 1
// mock fixture. Ask-your-notes (the input + answer card that used to live
// at the bottom of this panel) is Stage 4 work and has been removed
// entirely rather than kept dormant.

export interface AiNotesPanelProps {
  /** The selected note's persisted summary, or `null` if it hasn't been summarized (yet, or ever). */
  summary: SummaryDoc | null
  /** This note's summarization lifecycle — driven by `summary-status` events. `'idle'` covers both "never summarized" and "summarized in a past session, no event this session". */
  status: 'idle' | 'running' | 'error'
  /** The most recent summarization error for this note, if `status === 'error'`. */
  error?: string
  /** Display name of the currently selected summary model, for the "Summarizing on-device — {modelName}" banner. */
  modelName: string
  /** Whether the currently selected summary model is actually installed — gates the empty state's "Generate summary" button vs. a "download a model" prompt. */
  llmInstalled: boolean
  onToggleAction: (index: number, done: boolean) => void
  onRegenerate: () => void
  onCopy: () => void
  onExport: () => void
  onGoSettings: () => void
}

const panelStyle: CSSProperties = {
  width: 330,
  flex: 'none',
  borderLeft: '1px solid rgba(0,0,0,.07)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: '#f2f0ee',
}

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid rgba(0,0,0,.07)',
  borderRadius: 12,
  padding: '14px 16px',
  boxShadow: '0 1px 3px rgba(0,0,0,.04)',
}

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.07em',
  color: '#b3200c',
  marginBottom: 8,
}

const btnStyle: CSSProperties = {
  flex: 1,
  padding: '8px 0',
  border: '1px solid rgba(0,0,0,.12)',
  borderRadius: 8,
  background: '#fff',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  color: '#1c1a18',
  cursor: 'pointer',
}

function Spinner({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: `2px solid ${color}40`,
        borderTopColor: color,
        animation: 'spin .8s linear infinite',
        flex: 'none',
      }}
    />
  )
}

function SummarizingBanner({ modelName }: { modelName: string }) {
  return (
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
      <Spinner color="#e04430" />
      Summarizing on-device — {modelName}
    </div>
  )
}

function ErrorCard({ error, onRegenerate }: { error?: string; onRegenerate: () => void }) {
  return (
    <div style={{ ...cardStyle, border: '1px solid rgba(224,68,48,.3)', background: '#fff4f1' }}>
      <div style={labelStyle}>SUMMARY FAILED</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#7a1c0e', marginBottom: 10 }}>
        {error || 'Something went wrong generating this summary.'}
      </div>
      <button onClick={onRegenerate} className="btn-light" style={{ ...btnStyle, flex: 'none', padding: '6px 14px' }}>
        Regenerate
      </button>
    </div>
  )
}

function SummaryCard({ text }: { text: string }) {
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>SUMMARY</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: '#33302c', textWrap: 'pretty' }}>{text}</div>
    </div>
  )
}

function DecisionsCard({ decisions }: { decisions: string[] }) {
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>DECISIONS</div>
      {decisions.map((d, i) => (
        <div
          key={i}
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: '#33302c',
            display: 'flex',
            gap: 8,
            marginBottom: i < decisions.length - 1 ? 7 : 0,
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1c1a18', flex: 'none', marginTop: 7 }} />
          {d}
        </div>
      ))}
    </div>
  )
}

function ActionItemsCard({
  items,
  onToggleAction,
  disabled,
}: {
  items: SummaryDoc['actionItems']
  onToggleAction: (index: number, done: boolean) => void
  // True while status === 'running' — a regenerate in flight over this same
  // note is about to overwrite `items` wholesale, and a toggle that lands on
  // the old (still-displayed) array after the worker's write patches the
  // wrong item by index against the new one. Disabling here is the cheap,
  // always-available half of the guard; `toggle_action_item` also rejects
  // server-side while `SummarizeBusy` is claimed as the authoritative check.
  disabled: boolean
}) {
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>ACTION ITEMS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {items.map((item, i) => (
          <label
            key={i}
            aria-disabled={disabled}
            style={{
              display: 'flex',
              gap: 9,
              alignItems: 'flex-start',
              fontSize: 13,
              lineHeight: 1.5,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={item.done}
              disabled={disabled}
              aria-disabled={disabled}
              onChange={e => onToggleAction(i, e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span style={item.done ? { textDecoration: 'line-through', color: '#9a938c' } : { color: '#33302c' }}>{item.text}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function GenerateSummaryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-rec"
      style={{
        padding: '10px 0',
        border: 'none',
        borderRadius: 10,
        background: '#e04430',
        color: '#fff',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      Generate summary
    </button>
  )
}

function NoLlmPlaceholder({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 12, padding: '14px 16px' }}>
      <div style={labelStyle}>SUMMARY</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#9a938c', marginBottom: 10 }}>
        Summarize this note on-device once a summary model is installed.
      </div>
      <button
        onClick={onGoSettings}
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          fontFamily: 'inherit',
          fontSize: 12.5,
          fontWeight: 700,
          color: '#b3200c',
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        Download a summary model
      </button>
    </div>
  )
}

export function AiNotesPanel({
  summary,
  status,
  error,
  modelName,
  llmInstalled,
  onToggleAction,
  onRegenerate,
  onCopy,
  onExport,
  onGoSettings,
}: AiNotesPanelProps) {
  const summarizing = status === 'running'

  return (
    <div style={panelStyle}>
      <div style={{ padding: '16px 16px 12px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>AI notes</div>
        <div style={{ fontSize: 11, color: '#9a938c' }}>generated locally</div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {summarizing && <SummarizingBanner modelName={modelName} />}
        {status === 'error' && <ErrorCard error={error} onRegenerate={onRegenerate} />}

        {summary ? (
          <>
            <SummaryCard text={summary.summary} />
            {summary.decisions.length > 0 && <DecisionsCard decisions={summary.decisions} />}
            {summary.actionItems.length > 0 && (
              <ActionItemsCard items={summary.actionItems} onToggleAction={onToggleAction} disabled={summarizing} />
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={onCopy} className="btn-light" style={btnStyle}>
                Copy
              </button>
              <button onClick={onExport} className="btn-light" style={btnStyle}>
                Export .md
              </button>
              <button
                onClick={onRegenerate}
                disabled={summarizing}
                className="btn-light"
                style={{ ...btnStyle, opacity: summarizing ? 0.5 : 1, cursor: summarizing ? 'default' : 'pointer' }}
              >
                Regenerate
              </button>
            </div>
          </>
        ) : (
          status === 'idle' &&
          (llmInstalled ? <GenerateSummaryButton onClick={onRegenerate} /> : <NoLlmPlaceholder onGoSettings={onGoSettings} />)
        )}
      </div>
    </div>
  )
}
