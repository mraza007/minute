import { memo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
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
  status: 'idle' | 'queued' | 'running' | 'error'
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
  /** Whether this note's audio can actually be seeked into right now — `audioPath !== null && !failed`, the same computation NoteView feeds TranscriptList's own `seekable` prop. Gates every `[mm:ss]` citation button in ask history exactly like TranscriptList gates its timestamp buttons: `false` renders them aria-disabled, unclickable, and in muted styling instead of looking like a working link that silently does nothing. */
  seekable: boolean
  /** Whether *any* LLM generation is in flight app-wide (a summarize or an ask, for this note or any other) — disables the ask input even when it's `status`/`askStatus` for some *other* note that's actually running, since the backend would reject a submit either way (one generation at a time — see `llm::LlmBusy`'s docs). */
  llmBusy: boolean
  onToggleAction: (index: number, done: boolean) => void
  onRegenerate: () => void
  /** Cancels this note's queued/running summarization (issue #30) — the Cancel button on the running/queued banners. */
  onCancel: () => void
  onCopy: () => void
  onExport: () => void
  onGoSettings: () => void
  /** Submits a new question (or a retry of a previous one — the panel just calls this again with the same text). */
  onAsk: (question: string) => void
  /** Citation click → seek target, in seconds — same `onSeek` signature `TranscriptList` uses, since `NoteView` hands both the same `seek`-then-`play` callback. */
  onSeekCitation: (seconds: number) => void
  /** Overview already renders summary/decisions/actions in the main leaf. */
  overviewMode?: boolean
  /** Panel width in px — owned by NoteView's resize separator. Defaults to the classic 316. */
  width?: number
}

const panelStyle: CSSProperties = {
  width: 316,
  flex: 'none',
  borderLeft: '1px solid var(--rule)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--panel)',
}

/**
 * A ruled section on the facing leaf: a micro label with a hairline running
 * out to the column edge, then the content beneath it. This replaces the
 * bordered, shadowed card each of these blocks used to sit in — the rule
 * does all the dividing a card was doing, without introducing a raised
 * surface onto a page that is meant to read as paper.
 */
function Section({ label, children, tone }: { label: string; children: ReactNode; tone?: 'error' }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <div className="sec-head" style={{ marginBottom: 9 }}>
        <span className="mlab" style={tone === 'error' ? { color: 'var(--accent-text)' } : undefined}>
          {label}
        </span>
      </div>
      {children}
    </section>
  )
}

const smallBtnStyle: CSSProperties = {
  flex: 1,
  padding: '7px 0',
  fontSize: 11.5,
}

function Spinner() {
  return (
    <span
      className="spin"
      style={{
        width: 13,
        height: 13,
        borderRadius: '50%',
        border: '2px solid rgba(var(--accent-rgb), .25)',
        borderTopColor: 'var(--accent)',
        animation: 'spin .8s linear infinite',
        flex: 'none',
      }}
    />
  )
}

/**
 * The small Cancel affordance both progress banners share (issue #30) —
 * before it existed, the only way out of a stuck generation was
 * restarting the app.
 */
function CancelButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      type="button"
      onClick={onCancel}
      className="btn-outline"
      style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 11, flex: 'none' }}
    >
      Cancel
    </button>
  )
}

function SummarizingBanner({ modelName, onCancel }: { modelName: string; onCancel: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 20,
        paddingBottom: 16,
        borderBottom: '1px solid var(--rule)',
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--accent-text)',
      }}
    >
      <Spinner />
      Summarizing on-device — {modelName}
      <CancelButton onCancel={onCancel} />
    </div>
  )
}

/**
 * Issue #11: this note is in the summarize queue, waiting for whatever is
 * generating right now. No spinner — nothing is happening for *this* note
 * yet, and a spinner would claim otherwise. Since issue #35 the wait can
 * also be for a live recording to finish (summaries defer rather than
 * contend with it for the GPU), hence the deliberately unspecific
 * "engine is free" copy.
 */
function QueuedBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 20,
        paddingBottom: 16,
        borderBottom: '1px solid var(--rule)',
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--ink-muted)',
      }}
    >
      Queued — starts on its own when the engine is free
      <CancelButton onCancel={onCancel} />
    </div>
  )
}

function ErrorCard({ error, onRegenerate }: { error?: string; onRegenerate: () => void }) {
  return (
    <div role="alert">
      <Section label="Summary failed" tone="error">
        <p className="leaf-body" style={{ color: 'var(--error-text-strong)', marginBottom: 11 }}>
          {error || 'Something went wrong generating this summary.'}
        </p>
        <button onClick={onRegenerate} className="btn-outline" style={{ padding: '7px 14px', fontSize: 11.5 }}>
          Regenerate
        </button>
      </Section>
    </div>
  )
}

function GenerateSummaryButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="btn-solid" style={{ width: '100%', justifyContent: 'center', marginBottom: 22 }}>
      Generate summary
    </button>
  )
}

function DownloadModelLink({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <button
      onClick={onGoSettings}
      style={{
        border: 'none',
        background: 'none',
        padding: 0,
        fontFamily: 'var(--sans)',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--accent-text)',
        cursor: 'pointer',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
      }}
    >
      Download a summary model
    </button>
  )
}

function NoLlmPlaceholder({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <Section label="Summary">
      <p className="leaf-body" style={{ color: 'var(--ink-muted)', marginBottom: 10 }}>
        Summarize this note on-device once a summary model is installed.
      </p>
      <DownloadModelLink onGoSettings={onGoSettings} />
    </Section>
  )
}

// --- Ask your notes ---------------------------------------------------------

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
  textUnderlineOffset: 2,
}

/**
 * Renders an ask answer's text with every inline `[mm:ss]` citation (see
 * `splitAnswerCitations`) as a clickable seek button — everything else
 * renders as plain text, no markdown parsing (per the plan: answers are
 * plain prose with inline citations, nothing fancier). Each citation button
 * gets an `aria-label` of `"Play from {mm:ss}"` — the exact same convention
 * `TranscriptList`'s own segment-timestamp seek buttons use — so a screen
 * reader announces the same, unambiguous action regardless of which of the
 * two seek entry points the user is on.
 *
 * `seekable` mirrors `TranscriptList`'s own timestamp-button treatment
 * exactly (see `Segment` there): `disabled` + `aria-disabled`, no pointer
 * cursor, and the click guarded to a no-op, so a swept (or failed-to-load)
 * note's citations go visibly inert instead of looking like working links
 * that silently do nothing. The underline + accent color that make these
 * read as links in the first place are dropped too when not seekable —
 * muted to `--ink-faint`, the same "off" ink token used everywhere else in
 * the app for a disabled affordance — precisely because looking clickable
 * is the failure mode this is closing.
 */
function AnswerWithCitations({ text, seekable, onSeekCitation }: { text: string; seekable: boolean; onSeekCitation: (seconds: number) => void }) {
  const parts = splitAnswerCitations(text)
  return (
    <>
      {parts.map((part, i) =>
        part.citationSeconds === undefined ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={i}
            onClick={() => seekable && onSeekCitation(part.citationSeconds as number)}
            disabled={!seekable}
            aria-disabled={!seekable}
            aria-label={`Play from ${part.text.slice(1, -1)}`}
            style={{
              ...citationButtonStyle,
              color: seekable ? citationButtonStyle.color : 'var(--ink-faint)',
              cursor: seekable ? 'pointer' : 'default',
              textDecoration: seekable ? 'underline' : 'none',
            }}
          >
            {part.text}
          </button>
        ),
      )}
    </>
  )
}

/**
 * One question-and-answer exchange. The question is set in sans (it's the
 * user's own input — chrome, not document), the answer in serif (it's
 * generated prose about the document), with a hairline separating exchanges
 * instead of each sitting in its own card.
 */
function AskEntry({
  entry,
  disabled,
  seekable,
  onSeekCitation,
  onRetry,
}: {
  entry: AskHistoryEntry
  disabled: boolean
  seekable: boolean
  onSeekCitation: (seconds: number) => void
  onRetry: () => void
}) {
  return (
    <div style={{ paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
      <div style={{ fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
        {entry.question}
      </div>
      {entry.error ? (
        <>
          <div role="alert" style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--accent-text)', marginBottom: 9 }}>
            {entry.error}
          </div>
          <button
            onClick={onRetry}
            disabled={disabled}
            className="btn-outline"
            style={{ padding: '6px 13px', fontSize: 11.5 }}
          >
            Retry
          </button>
        </>
      ) : (
        <p className="leaf-body">
          <AnswerWithCitations text={entry.answer ?? ''} seekable={seekable} onSeekCitation={onSeekCitation} />
        </p>
      )}
    </div>
  )
}

function NoLlmAskPlaceholder({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <Section label="Ask your notes">
      <p className="leaf-body" style={{ color: 'var(--ink-muted)', marginBottom: 10 }}>
        Ask questions about this meeting on-device once a summary model is installed.
      </p>
      <DownloadModelLink onGoSettings={onGoSettings} />
    </Section>
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
  seekable,
  onAsk,
  onSeekCitation,
}: {
  askHistory: AskHistoryEntry[]
  askStatus: AskStatus
  llmBusy: boolean
  seekable: boolean
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
    if (e.key !== 'Enter') return
    // Ignore the Enter that confirms a CJK/IME composition (e.g. picking a
    // kanji candidate) — that Enter is finishing the *text*, not asking to
    // submit the question. `nativeEvent.isComposing` is what actually
    // distinguishes the two; `e.key === 'Enter'` alone can't.
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  return (
    <Section label="Ask your notes">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this meeting…"
          aria-label="Ask about this meeting"
          disabled={disabled}
          className="input-ruled"
          style={{ flex: 1, opacity: disabled ? 0.6 : 1 }}
        />
        {running && <Spinner />}
      </div>
      {!running && llmBusy && (
        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginBottom: 10 }}>Waiting for the current generation…</div>
      )}
      {askHistory.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {askHistory.map(entry => (
            <AskEntry
              key={entry.id}
              entry={entry}
              disabled={disabled}
              seekable={seekable}
              onSeekCitation={onSeekCitation}
              onRetry={() => onAsk(entry.question)}
            />
          ))}
        </div>
      )}
    </Section>
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
  seekable,
  onToggleAction,
  onRegenerate,
  onCancel,
  onCopy,
  onExport,
  onGoSettings,
  onAsk,
  onSeekCitation,
  overviewMode = false,
  width,
}: AiNotesPanelProps) {
  const summarizing = status === 'running'
  const queued = status === 'queued'
  // Both states must lock the same controls: a Regenerate click while
  // queued would re-enqueue work that is already scheduled.
  const pending = summarizing || queued
  const answering = askStatus === 'running'

  // Composes the one persistent status announcement below out of whichever
  // of the two flows is actually running right now — at most one of them
  // ever is (both share the backend's single `LlmBusy` slot), but the two
  // fields driving this are independent booleans, so the composition still
  // has to pick explicitly rather than assume mutual exclusion.
  const statusAnnouncement = summarizing
    ? 'Summarizing on-device…'
    : queued
      ? 'Summary queued'
      : answering
        ? 'Answering…'
        : ''

  return (
    <div style={width !== undefined ? { ...panelStyle, width } : panelStyle}>
      <div style={{ padding: '24px 26px 20px', display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <h2 style={{ margin: 0, fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 17, letterSpacing: '-.005em' }}>
          {overviewMode ? 'Ask & export' : 'AI notes'}
        </h2>
        <div style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>generated locally</div>
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
      <div style={{ flex: 1, overflow: 'auto', padding: '0 26px 24px' }}>
        {!overviewMode && summarizing && <SummarizingBanner modelName={modelName} onCancel={onCancel} />}
        {!overviewMode && queued && <QueuedBanner onCancel={onCancel} />}
        {/* Overview mode leaves the error surface to NoteView's own
            error-with-retry block — showing this card there too renders
            the same message twice. */}
        {!overviewMode && status === 'error' && <ErrorCard error={error} onRegenerate={onRegenerate} />}

        {!overviewMode && summary ? (
          <>
            <Section label="Summary">
              <p className="leaf-body">{summary.summary}</p>
            </Section>
            {/* Issue #14's topic breakdown, between the overview and the
                decisions — only ever populated under the Detailed summary
                style, so for everyone else this section simply isn't
                there. */}
            {summary.topics.length > 0 && (
              <Section label="Topics">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {summary.topics.map((topic, i) => (
                    <div key={`${topic.title}-${i}`}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{topic.title}</div>
                      {topic.summary && <p className="leaf-body">{topic.summary}</p>}
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {summary.decisions.length > 0 && (
              <Section label="Decisions">
                <ul className="sec-list">
                  {summary.decisions.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </Section>
            )}
            {summary.actionItems.length > 0 && (
              <Section label="Action items">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {summary.actionItems.map((item, i) => (
                    <label
                      key={i}
                      className="todo-row"
                      aria-disabled={pending}
                      style={{ cursor: pending ? 'default' : 'pointer', opacity: pending ? 0.5 : 1 }}
                    >
                      <input
                        type="checkbox"
                        checked={item.done}
                        // True while status === 'running' — a regenerate in
                        // flight over this same note is about to overwrite
                        // `items` wholesale, and a toggle that lands on the
                        // old (still-displayed) array after the worker's
                        // write patches the wrong item by index against the
                        // new one. Disabling here is the cheap,
                        // always-available half of the guard;
                        // `toggle_action_item` also rejects server-side
                        // while `LlmBusy` is claimed as the authoritative
                        // check.
                        disabled={pending}
                        aria-disabled={pending}
                        onChange={e => onToggleAction(i, e.target.checked)}
                      />
                      <span style={item.done ? { textDecoration: 'line-through', color: 'var(--ink-faint)' } : undefined}>
                        {item.text}
                      </span>
                    </label>
                  ))}
                </div>
              </Section>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
              <button onClick={onCopy} className="btn-outline" style={{ ...smallBtnStyle, justifyContent: 'center' }}>
                Copy
              </button>
              <button onClick={onExport} className="btn-outline" style={{ ...smallBtnStyle, justifyContent: 'center' }}>
                Export .md
              </button>
              <button
                onClick={onRegenerate}
                disabled={pending}
                className="btn-outline"
                style={{ ...smallBtnStyle, justifyContent: 'center' }}
              >
                Regenerate
              </button>
            </div>
          </>
        ) : !overviewMode ? (
          status === 'idle' &&
          (llmInstalled ? <GenerateSummaryButton onClick={onRegenerate} /> : <NoLlmPlaceholder onGoSettings={onGoSettings} />)
        ) : summary ? (
          <div className="overview-export-actions">
            <button onClick={onCopy} className="btn-outline">Copy summary</button>
            <button onClick={onExport} className="btn-outline">Export .md</button>
            {/* Issue #19: the Overview tab's one entry point to re-run
                summarization. Disabled while one runs or waits (issue
                #11) — offering it again is how a note gets summarized
                twice in a row. */}
            <button onClick={onRegenerate} disabled={pending} className="btn-outline">
              Regenerate
            </button>
          </div>
        ) : null}

        {llmInstalled ? (
          <AskSection
            askHistory={askHistory}
            askStatus={askStatus}
            llmBusy={llmBusy}
            seekable={seekable}
            onAsk={onAsk}
            onSeekCitation={onSeekCitation}
          />
        ) : (
          <NoLlmAskPlaceholder onGoSettings={onGoSettings} />
        )}
      </div>
    </div>
  )
})
