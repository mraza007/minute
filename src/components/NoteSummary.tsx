import { memo, useEffect, useState } from 'react'
import type { SummarizeNowOutcome, SummaryDoc } from '../ipc/types'
import type { SummaryStatus } from '../state/useAppState'
import { formatWait, SUMMARY_STYLE_NAMES, summaryCoverageNotice, summaryWaitReason, type SummaryWait } from '../state/adapters'

export interface NoteSummaryProps {
  /** The note's persisted summary, or `null` if it has none (yet, or ever). */
  summary: SummaryDoc | null
  /** This note's summarization lifecycle. `'idle'` covers "never summarized" and "summarized earlier". */
  status: SummaryStatus
  /** The latest summarization error, when `status === 'error'`. */
  error?: string
  /** Display name of the selected summary model, named while it runs. */
  modelName: string
  /** Whether the selected summary model is installed. */
  llmInstalled: boolean
  /** Starts (or restarts) summarization. */
  onGenerate: () => void
  /** Cancels a queued or running summarization (issue #30). */
  onCancel: () => void
  /** What the queued card says while `status === 'queued'` (issue #44). */
  wait: SummaryWait | null
  /** Starts a queued summary without waiting its turn. */
  onSummarizeNow: () => Promise<SummarizeNowOutcome | null>
  onToggleAction: (index: number, done: boolean) => void
  onGoSettings: () => void
}

/** Every summary is written on this Mac. Older ones did not record their length, so they name none. */
function styleLabel(summary: SummaryDoc): string {
  return summary.style ? `${SUMMARY_STYLE_NAMES[summary.style]} · made on this Mac` : 'Made on this Mac'
}

const MINUTE_MS = 60_000

/** The current time, refreshed as each whole minute since `since` passes, so a wait in minutes stays true. */
function useMinuteClock(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const elapsed = Math.max(0, Date.now() - since)
    const timer = window.setTimeout(() => setNow(Date.now()), MINUTE_MS - (elapsed % MINUTE_MS))
    return () => window.clearTimeout(timer)
  }, [since, now])
  return now
}

/**
 * A summary that waits in the queue (issue #44): how long it has waited,
 * why, and the two ways out. Keyed by `queuedAt` by its owner, so the clock
 * starts fresh when the wait does.
 */
function QueuedSummaryCard({
  wait,
  onCancel,
  onSummarizeNow,
}: {
  wait: SummaryWait | null
  onCancel: () => void
  onSummarizeNow: () => Promise<SummarizeNowOutcome | null>
}) {
  const queuedAt = wait?.queuedAt ?? null
  const now = useMinuteClock(queuedAt)
  const [starting, setStarting] = useState(false)
  const [startsNext, setStartsNext] = useState(false)

  function summarizeNow() {
    setStarting(true)
    void onSummarizeNow()
      .then(outcome => setStartsNext(outcome === 'next'))
      .finally(() => setStarting(false))
  }

  const reason = startsNext
    ? 'It starts next, when the summary that is running ends. Your recording and transcript are safe.'
    : wait ? summaryWaitReason(wait) : 'It has not started yet. Your recording and transcript are safe.'

  return (
    <div className="summary-wait">
      <div className="summary-wait-text">
        <p className="summary-wait-title">
          {queuedAt === null ? 'This summary is waiting' : `This summary has waited ${formatWait(queuedAt, now)}`}
        </p>
        <p className="summary-wait-reason">{reason}</p>
      </div>
      <span className="summary-wait-actions">
        <button type="button" className="summary-wait-btn" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="summary-wait-btn"
          data-variant="primary"
          disabled={starting || startsNext}
          onClick={summarizeNow}
        >
          {startsNext ? 'Starts next' : starting ? 'Starting…' : 'Summarize now'}
        </button>
      </span>
    </div>
  )
}

/**
 * Summary, topics, decisions, and action items, plus every state the
 * summary can be in: running, queued, failed (with whatever earlier summary
 * still exists shown underneath), cut short by the context window, and not
 * generated yet.
 */
export const NoteSummary = memo(function NoteSummary({
  summary,
  status,
  error,
  modelName,
  llmInstalled,
  onGenerate,
  onCancel,
  wait,
  onSummarizeNow,
  onToggleAction,
  onGoSettings,
}: NoteSummaryProps) {
  const running = status === 'running'
  const queued = status === 'queued'
  // Queued locks the same controls as running: a second Regenerate would
  // enqueue work that is already scheduled (issue #11).
  const pending = running || queued

  return (
    <>
      <section className="note-section" aria-labelledby="note-summary-heading">
        <div className="note-section-head">
          <h2 id="note-summary-heading" className="note-h">Summary</h2>
          <div className="note-section-aside">
            {running && (
              <>
                <span className="spin note-spinner" aria-hidden="true" />
                <span>Summarizing on this Mac · {modelName}</span>
              </>
            )}
            {!pending && summary && <span>{styleLabel(summary)}</span>}
            {running && <button type="button" className="note-link" onClick={onCancel}>Cancel</button>}
            {!pending && summary && status !== 'error' && (
              <button type="button" className="note-link" onClick={onGenerate}>Regenerate</button>
            )}
          </div>
        </div>

        {queued && (
          <QueuedSummaryCard key={wait?.queuedAt ?? 'unknown'} wait={wait} onCancel={onCancel} onSummarizeNow={onSummarizeNow} />
        )}

        {status === 'error' && (
          <div className="note-notice" data-tone="error" role="alert">
            <span>
              <strong>Summary unavailable.</strong>{' '}
              {error || 'Minute could not write the summary. The transcript and audio are still available.'}
            </span>
            <span className="note-notice-actions">
              <button type="button" className="btn-small" onClick={onGenerate}>Retry summary</button>
            </span>
          </div>
        )}

        {summary ? (
          <>
            <p className="note-body">{summary.summary}</p>
            {summaryCoverageNotice(summary) && <p className="note-muted">{summaryCoverageNotice(summary)}</p>}
          </>
        ) : status === 'error' || queued ? null : running ? (
          <p className="note-muted">The transcript stays available while Minute writes the summary.</p>
        ) : llmInstalled ? (
          <div className="note-empty-summary">
            <p className="note-muted">No summary yet. Minute can write one on this Mac, with the decisions and action items.</p>
            <button type="button" className="btn-small" data-variant="primary" onClick={onGenerate}>Generate summary</button>
          </div>
        ) : (
          <div className="note-empty-summary">
            <p className="note-muted">Install a summary model to get a summary, decisions, and action items for this note.</p>
            <button type="button" className="note-link" onClick={onGoSettings}>Download a summary model</button>
          </div>
        )}
      </section>

      {summary && summary.topics.length > 0 && (
        <section className="note-section" aria-labelledby="note-topics-heading">
          <h2 id="note-topics-heading" className="note-h">Topics</h2>
          <div className="note-topics">
            {summary.topics.map((topic, index) => (
              <div key={`${topic.title}-${index}`} className="note-topic">
                <h3>{topic.title}</h3>
                {topic.summary && <p className="note-body">{topic.summary}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {summary && (
        <div className="note-pair">
          <section className="note-section" aria-labelledby="note-decisions-heading">
            <h2 id="note-decisions-heading" className="note-h">Decisions</h2>
            {summary.decisions.length > 0 ? (
              <ol className="note-decisions">
                {summary.decisions.map((decision, index) => <li key={`${decision}-${index}`}><span>{decision}</span></li>)}
              </ol>
            ) : <p className="note-muted">No decisions were identified.</p>}
          </section>
          <section className="note-section" aria-labelledby="note-actions-heading">
            <h2 id="note-actions-heading" className="note-h">Action items</h2>
            {summary.actionItems.length > 0 ? (
              <ul className="note-checklist">
                {summary.actionItems.map((item, index) => (
                  <li key={`${item.text}-${index}`}>
                    <label aria-disabled={pending}>
                      <input
                        type="checkbox"
                        checked={item.done}
                        // A regenerate is about to replace the items, and a
                        // toggle that lands afterwards would patch the wrong
                        // item by index. The backend rejects it too.
                        disabled={pending}
                        onChange={event => onToggleAction(index, event.target.checked)}
                      />
                      <span>{item.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : <p className="note-muted">No action items were identified.</p>}
          </section>
        </div>
      )}
    </>
  )
})
