import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { splitAnswerCitations } from '../state/adapters'
import type { AskHistoryEntry, AskStatus } from '../state/useNoteDetail'

export interface AskPanelProps {
  /** Whether the selected summary model is installed. The same model answers questions, so without it the panel shows a download prompt instead of the input. */
  llmInstalled: boolean
  /** This note's session history, newest first (as `useNoteDetail` keeps it). */
  askHistory: AskHistoryEntry[]
  /** This note's own ask lifecycle. */
  askStatus: AskStatus
  /** Whether any generation (a summary or an ask, for any note) holds the one app-wide slot. A submit would be rejected, so the input is disabled. */
  llmBusy: boolean
  /** Whether this note's audio can be seeked into. False renders citations inert instead of as links that do nothing. */
  seekable: boolean
  onAsk: (question: string) => void
  /** Citation click: seek to `seconds` and play. */
  onSeekCitation: (seconds: number) => void
  onGoSettings: () => void
  onClose: () => void
}

/**
 * Renders an answer with every inline `[mm:ss]` citation as a seek button.
 * The label matches TranscriptList's timestamp buttons ("Play from mm:ss"),
 * so both seek entry points announce the same action.
 */
function AnswerWithCitations({ text, seekable, onSeekCitation }: { text: string; seekable: boolean; onSeekCitation: (seconds: number) => void }) {
  return (
    <>
      {splitAnswerCitations(text).map((part, i) =>
        part.citationSeconds === undefined ? (
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            className="ask-citation"
            onClick={() => seekable && onSeekCitation(part.citationSeconds as number)}
            disabled={!seekable}
            aria-disabled={!seekable}
            aria-label={`Play from ${part.text.slice(1, -1)}`}
          >
            {part.text.slice(1, -1)}
          </button>
        ),
      )}
    </>
  )
}

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
    <div className="ask-entry">
      <div className="ask-question">
        <span>{entry.question}</span>
      </div>
      {entry.error ? (
        <div className="ask-error">
          <span role="alert">{entry.error}</span>
          <button type="button" className="btn-small" onClick={onRetry} disabled={disabled}>
            Retry
          </button>
        </div>
      ) : (
        <p className="ask-answer">
          <AnswerWithCitations text={entry.answer ?? ''} seekable={seekable} onSeekCitation={onSeekCitation} />
        </p>
      )}
    </div>
  )
}

/**
 * The floating "Ask about this meeting" panel. A non-modal dialog: the note
 * stays readable and playable behind it, and a citation click seeks without
 * closing it. Escape or the close button dismisses it.
 */
export const AskPanel = memo(function AskPanel({
  llmInstalled,
  askHistory,
  askStatus,
  llmBusy,
  seekable,
  onAsk,
  onSeekCitation,
  onGoSettings,
  onClose,
}: AskPanelProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const running = askStatus === 'running'
  const disabled = running || llmBusy

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // The conversation reads top to bottom with the input underneath, so the
  // latest exchange has to stay in view as answers land.
  useEffect(() => {
    const history = historyRef.current
    if (history) history.scrollTop = history.scrollHeight
  }, [askHistory.length, running])

  function submit() {
    const trimmed = draft.trim()
    if (!trimmed || disabled) return
    onAsk(trimmed)
    setDraft('')
  }

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    // The Enter that confirms an IME composition finishes the text. It is
    // not a submit.
    if (e.nativeEvent.isComposing) return
    e.preventDefault()
    submit()
  }

  return (
    <div
      className="ask-panel"
      role="dialog"
      aria-label="Ask about this meeting"
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="ask-panel-head">
        <h2>Ask about this meeting</h2>
        <button type="button" className="icon-btn ask-panel-close" aria-label="Close Ask" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {llmInstalled ? (
        <>
          {(askHistory.length > 0 || running) && (
            <div ref={historyRef} className="ask-history">
              {askHistory.toReversed().map(entry => (
                <AskEntry
                  key={entry.id}
                  entry={entry}
                  disabled={disabled}
                  seekable={seekable}
                  onSeekCitation={onSeekCitation}
                  onRetry={() => onAsk(entry.question)}
                />
              ))}
              {running && (
                <div className="ask-pending">
                  <span className="spin ask-spinner" data-testid="ask-spinner" />
                  Answering on this Mac…
                </div>
              )}
            </div>
          )}
          <div className="ask-compose">
            <div className="ask-field" data-disabled={disabled ? 'true' : undefined}>
              <input
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Ask a question"
                aria-label="Ask a question"
                disabled={disabled}
              />
              <button type="button" className="ask-send" aria-label="Send question" disabled={disabled || !draft.trim()} onClick={submit}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              </button>
            </div>
            <p className="ask-hint">
              {!running && llmBusy
                ? 'Waiting for the current generation…'
                : 'Answers use only this transcript. Click a time to play it.'}
            </p>
          </div>
        </>
      ) : (
        <div className="ask-compose">
          <p className="ask-hint">Ask questions about this meeting on this Mac once a summary model is installed.</p>
          <button type="button" className="note-link" onClick={onGoSettings}>Download a summary model</button>
        </div>
      )}
    </div>
  )
})
