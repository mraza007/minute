import { memo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { splitAnswerCitations } from '../state/adapters'
import type { AskHistoryEntry, AskStatus } from '../state/useNoteDetail'
import type { SummaryDoc } from '../ipc/types'

// Revived for Stage 3 Task 5 — real `SummaryDoc`s instead of the Stage 1
// mock fixture. Ask-your-notes (the input + answer card that used to live
// at the bottom of this panel) was removed entirely at that point rather
// than kept dormant — Stage 4 Task 5 (this) adds it back for real, backed
// by `ask_note`/`ask-status`/`ask-answer` instead of the Stage 1 mock.

export interface AiNotesPanelProps {
  /** The selected note's persisted summary, or `null` if it hasn't been summarized (yet, or ever). */
  summary: SummaryDoc | null
  /** This note's summarization lifecycle — driven by `summary-status` events. `'idle'` covers both "never summarized" and "summarized in a past session, no event this session". */
  status: 'idle' | 'running' | 'error'
  /** The most recent summarization error for this note, if `status === 'error'`. */
  error?: string
  /** Display name of the currently selected summary model, for the "Summarizing on-device — {modelName}" banner. */
  modelName: string
  /** Whether the currently selected summary model is actually installed — gates the empty state's "Generate summary" button vs. a "download a model" prompt, and the ask section's own no-LLM placeholder (the same model backs both flows). */
  llmInstalled: boolean
  /** This note's ask-your-notes session history, newest first — session-only (see `AskHistoryEntry`'s docs), capped at `useNoteDetail`'s `ASK_HISTORY_CAP`. */
  askHistory: AskHistoryEntry[]
  /** This note's ask lifecycle — `'idle'` covers both "never asked" and "the last one finished", same collapsing rule as `status` above. */
  askStatus: AskStatus
  /** Whether *any* LLM generation is in flight app-wide (a summarize or an ask, for this note or any other) — disables the ask input even when it's `status`/`askStatus` for some *other* note that's actually running, since the backend would reject a submit either way (one generation at a time — see `llm::LlmBusy`'s docs). */
  llmBusy: boolean
  onToggleAction: (index: number, done: boolean) => void
  onRegenerate: () => void
  onCopy: () => void
  onExport: () => void
  onGoSettings: () => void
  /** Submits a new question (or a retry of a previous one — the panel just calls this again with the same text). */
  onAsk: (question: string) => void
  /** Citation click → seek target, in seconds — same `onSeek` signature `TranscriptList` uses, since `NoteView` hands both the same `seek`-then-`play` callback. */
  onSeekCitation: (seconds: number) => void
}

const panelStyle: CSSProperties = {
  width: 330,
  flex: 'none',
  borderLeft: '1px solid var(--border-soft)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--panel)',
}

const cardStyle: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border-soft)',
  borderRadius: 'var(--radius-md)',
  padding: '14px 16px',
  boxShadow: '0 1px 3px rgba(0,0,0,.04)',
}

// Eyebrow labels ("SUMMARY", "DECISIONS", "ACTION ITEMS") use the same
// muted-gray eyebrow color as everywhere else in the app — red is reserved
// for the "SUMMARY FAILED" error state, which uses errorLabelStyle instead.
const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.07em',
  color: 'var(--ink-faint)',
  marginBottom: 8,
}

const errorLabelStyle: CSSProperties = {
  ...labelStyle,
  color: 'var(--accent-text)',
}

const btnStyle: CSSProperties = {
  flex: 1,
  padding: '8px 0',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--card)',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink)',
  cursor: 'pointer',
}

function Spinner({ color }: { color: string }) {
  return (
    <span
      className="spin"
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
        background: 'var(--card)',
        border: '1px solid rgba(224,68,48,.3)',
        borderRadius: 'var(--radius-md)',
        padding: '12px 16px',
        boxShadow: '0 1px 3px rgba(0,0,0,.04)',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--accent-text)',
      }}
    >
      <Spinner color="var(--accent)" />
      Summarizing on-device — {modelName}
    </div>
  )
}

function ErrorCard({ error, onRegenerate }: { error?: string; onRegenerate: () => void }) {
  return (
    <div role="alert" style={{ ...cardStyle, border: '1px solid rgba(224,68,48,.3)', background: '#fff4f1' }}>
      <div style={errorLabelStyle}>SUMMARY FAILED</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: '#7a1c0e', marginBottom: 10 }}>
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
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-body)', textWrap: 'pretty' }}>{text}</div>
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
            color: 'var(--ink-body)',
            display: 'flex',
            gap: 8,
            marginBottom: i < decisions.length - 1 ? 7 : 0,
          }}
        >
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ink)', flex: 'none', marginTop: 7 }} />
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
            <span style={item.done ? { textDecoration: 'line-through', color: 'var(--ink-faint)' } : { color: 'var(--ink-body)' }}>{item.text}</span>
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
        borderRadius: 999,
        background: 'var(--accent-solid)',
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
    <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
      <div style={labelStyle}>SUMMARY</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-faint)', marginBottom: 10 }}>
        Summarize this note on-device once a summary model is installed.
      </div>
      <button
        onClick={onGoSettings}
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--accent-text)',
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        Download a summary model
      </button>
    </div>
  )
}

// --- Ask your notes ---------------------------------------------------------

const askInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 12px',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--card)',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--ink)',
  outline: 'none',
}

const citationButtonStyle: CSSProperties = {
  display: 'inline',
  border: 'none',
  background: 'none',
  padding: 0,
  margin: 0,
  fontFamily: 'inherit',
  fontSize: 'inherit',
  fontWeight: 700,
  color: 'var(--accent-text)',
  cursor: 'pointer',
  textDecoration: 'underline',
}

/**
 * Renders an ask answer's text with every inline `[mm:ss]` citation (see
 * `splitAnswerCitations`) as a clickable seek button — everything else
 * renders as plain text, no markdown parsing (per the plan: answers are
 * plain prose with inline citations, nothing fancier).
 */
function AnswerWithCitations({ text, onSeekCitation }: { text: string; onSeekCitation: (seconds: number) => void }) {
  const parts = splitAnswerCitations(text)
  return (
    <>
      {parts.map((part, i) =>
        part.citationSeconds === undefined ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button key={i} onClick={() => onSeekCitation(part.citationSeconds as number)} style={citationButtonStyle}>
            {part.text}
          </button>
        ),
      )}
    </>
  )
}

function AskEntryCard({
  entry,
  disabled,
  onSeekCitation,
  onRetry,
}: {
  entry: AskHistoryEntry
  disabled: boolean
  onSeekCitation: (seconds: number) => void
  onRetry: () => void
}) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>{entry.question}</div>
      {entry.error ? (
        <>
          <div role="alert" style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--accent-text)', marginBottom: 8 }}>
            {entry.error}
          </div>
          <button
            onClick={onRetry}
            disabled={disabled}
            className="btn-light"
            style={{ ...btnStyle, flex: 'none', padding: '6px 14px', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}
          >
            Retry
          </button>
        </>
      ) : (
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-body)' }}>
          <AnswerWithCitations text={entry.answer ?? ''} onSeekCitation={onSeekCitation} />
        </div>
      )}
    </div>
  )
}

function NoLlmAskPlaceholder({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <div style={{ border: '1px dashed rgba(0,0,0,.15)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
      <div style={labelStyle}>ASK YOUR NOTES</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-faint)', marginBottom: 10 }}>
        Ask questions about this meeting on-device once a summary model is installed.
      </div>
      <button
        onClick={onGoSettings}
        style={{
          border: 'none',
          background: 'none',
          padding: 0,
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--accent-text)',
          cursor: 'pointer',
          textDecoration: 'underline',
        }}
      >
        Download a summary model
      </button>
    </div>
  )
}

/**
 * The "Ask your notes" section: a submit-on-Enter input plus this note's
 * session history (newest first). Disabled — input and any per-entry Retry
 * button alike — while `askStatus === 'running'` (this note's own ask) OR
 * `llmBusy` (a summarize, or an ask for some *other* note, is currently
 * holding the one app-wide generation slot — see `llm::LlmBusy`'s docs):
 * either way a submit right now would just be rejected server-side, so
 * disabling here is honest, not overcautious. The hint text distinguishes
 * the two cases rather than showing one generic "busy" message for both.
 */
function AskSection({
  askHistory,
  askStatus,
  llmBusy,
  onAsk,
  onSeekCitation,
}: {
  askHistory: AskHistoryEntry[]
  askStatus: AskStatus
  llmBusy: boolean
  onAsk: (question: string) => void
  onSeekCitation: (seconds: number) => void
}) {
  const [draft, setDraft] = useState('')
  const running = askStatus === 'running'
  const disabled = running || llmBusy

  function submit() {
    const trimmed = draft.trim()
    if (!trimmed || disabled) return
    onAsk(trimmed)
    setDraft('')
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={labelStyle}>ASK YOUR NOTES</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this meeting…"
          aria-label="Ask about this meeting"
          disabled={disabled}
          className="input-focus"
          style={{ ...askInputStyle, flex: 1, opacity: disabled ? 0.6 : 1 }}
        />
        {running && <Spinner color="var(--accent)" />}
      </div>
      {!running && llmBusy && (
        <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>Waiting for the current generation…</div>
      )}
      {askHistory.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {askHistory.map((entry, i) => (
            <AskEntryCard
              key={i}
              entry={entry}
              disabled={disabled}
              onSeekCitation={onSeekCitation}
              onRetry={() => onAsk(entry.question)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Memoized — NoteView re-renders this panel's props unchanged whenever
// something outside the AI-notes slice changes (e.g. the transcript tab's
// own state); skip the re-render (and this component's own tokenization-ish
// work) when nothing it actually reads has moved.
export const AiNotesPanel = memo(function AiNotesPanel({
  summary,
  status,
  error,
  modelName,
  llmInstalled,
  askHistory,
  askStatus,
  llmBusy,
  onToggleAction,
  onRegenerate,
  onCopy,
  onExport,
  onGoSettings,
  onAsk,
  onSeekCitation,
}: AiNotesPanelProps) {
  const summarizing = status === 'running'
  const answering = askStatus === 'running'

  // Composes the one persistent status announcement below out of whichever
  // of the two flows is actually running right now — at most one of them
  // ever is (both share the backend's single `LlmBusy` slot), but the two
  // fields driving this are independent booleans, so the composition still
  // has to pick explicitly rather than assume mutual exclusion.
  const statusAnnouncement = summarizing ? 'Summarizing on-device…' : answering ? 'Answering…' : ''

  return (
    <div style={panelStyle}>
      <div style={{ padding: '16px 16px 12px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>AI notes</h2>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)' }}>generated locally</div>
      </div>
      {/* Persistent `role="status"` announcer — always mounted, text toggles
          between '', "Summarizing on-device…", and "Answering…" — the
          visible `SummarizingBanner`/ask spinner below stay purely visual
          (no role="status" of their own) so this is the only thing that
          ever announces either generation state; a role="status" node that
          instead mounts and unmounts with its text already inside is
          commonly missed by screen readers. One shared span for the whole
          panel (rather than one per section) is enough — at most one of the
          two flows is ever actually running at once. */}
      <span role="status" className="visually-hidden">
        {statusAnnouncement}
      </span>
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

        {llmInstalled ? (
          <AskSection askHistory={askHistory} askStatus={askStatus} llmBusy={llmBusy} onAsk={onAsk} onSeekCitation={onSeekCitation} />
        ) : (
          <NoLlmAskPlaceholder onGoSettings={onGoSettings} />
        )}
      </div>
    </div>
  )
})
