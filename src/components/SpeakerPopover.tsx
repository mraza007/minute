import { useState, type CSSProperties } from 'react'
import type { SpeakerSuggestion } from '../ipc/types'

export interface SpeakerPopoverProps {
  /** The speaker label being edited, as it appears in the transcript now. */
  speaker: string
  turnCount: number
  /** Every other speaker in this note: the merge targets. */
  otherSpeakers: string[]
  /** A voice-profile match for this speaker that has not been confirmed. */
  suggestion?: SpeakerSuggestion
  /** `--speaker-color` for the dot. */
  colorStyle: CSSProperties
  /** Distance from the left edge of the chip row, so the popover opens under its chip. */
  offsetLeft: number
  onRename: (name: string) => void
  onDismissSuggestion: () => void
  /** Resolves once the merge is saved. A rejection keeps the popover open for a retry. */
  onMerge: (into: string) => Promise<void>
  onClose: () => void
}

/**
 * Rename or merge one speaker. Opens under the speaker's chip. Escape,
 * Cancel, or a press outside closes it without a change.
 */
export function SpeakerPopover({
  speaker,
  turnCount,
  otherSpeakers,
  suggestion,
  colorStyle,
  offsetLeft,
  onRename,
  onDismissSuggestion,
  onMerge,
  onClose,
}: SpeakerPopoverProps) {
  const [draft, setDraft] = useState(speaker)
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [mergePending, setMergePending] = useState(false)
  const trimmed = draft.trim()

  function submitRename() {
    if (trimmed && trimmed !== speaker) onRename(trimmed)
    onClose()
  }

  function submitMerge() {
    if (!mergeTarget || mergePending) return
    setMergePending(true)
    onMerge(mergeTarget)
      .then(onClose)
      .catch(() => {
        // The shared error banner owns the message. Keep both speakers
        // selected for a retry.
      })
      .finally(() => setMergePending(false))
  }

  return (
    <>
      <div className="context-menu-backdrop" onMouseDown={mergePending ? undefined : onClose} />
      <div
        className="speaker-popover"
        role="dialog"
        aria-label={`Rename ${speaker}`}
        style={{ left: offsetLeft }}
        onKeyDown={event => {
          if (event.key === 'Escape' && !mergePending) {
            event.preventDefault()
            onClose()
          }
        }}
      >
        <form
          onSubmit={event => {
            event.preventDefault()
            submitRename()
          }}
        >
          <div className="speaker-popover-body">
            <div className="speaker-popover-who">
              <span className="speaker-dot" style={colorStyle} aria-hidden="true" />
              <span>{speaker} · {turnCount} {turnCount === 1 ? 'turn' : 'turns'}</span>
            </div>
            <input
              autoFocus
              className="speaker-popover-input"
              aria-label="Speaker name"
              value={draft}
              onFocus={event => event.currentTarget.select()}
              onChange={event => setDraft(event.target.value)}
            />
            <p>The new name replaces {speaker} in the transcript and in the notes.</p>
          </div>
          {suggestion && (
            <div className="speaker-popover-suggestion">
              <span>Sounds like {suggestion.name}</span>
              <span className="speaker-popover-suggestion-actions">
                <button
                  type="button"
                  className="note-link"
                  onClick={() => {
                    onRename(suggestion.name)
                    onClose()
                  }}
                >
                  Use this name
                </button>
                <button
                  type="button"
                  className="icon-btn speaker-popover-dismiss"
                  aria-label="Dismiss suggestion"
                  title="Dismiss suggestion"
                  onClick={onDismissSuggestion}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </span>
            </div>
          )}
          {otherSpeakers.length > 0 && (
            <div className="speaker-popover-options">
              {mergeTarget === null ? (
                <button type="button" className="speaker-popover-option" onClick={() => setMergeTarget(otherSpeakers[0])}>
                  Merge with another speaker…
                </button>
              ) : (
                <div className="speaker-popover-merge">
                  <label>
                    <span>Merge {speaker} into</span>
                    <select
                      autoFocus
                      aria-label="Merge into speaker"
                      value={mergeTarget}
                      disabled={mergePending}
                      onChange={event => setMergeTarget(event.target.value)}
                    >
                      {otherSpeakers.map(other => <option key={other} value={other}>{other}</option>)}
                    </select>
                  </label>
                  <button type="button" className="btn-small" disabled={mergePending} onClick={submitMerge}>
                    {mergePending ? 'Merging…' : 'Merge'}
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="speaker-popover-foot">
            <button type="button" className="toolbar-btn" disabled={mergePending} onClick={onClose}>Cancel</button>
            <button type="submit" className="toolbar-btn" data-variant="primary" disabled={!trimmed || mergePending}>Rename</button>
          </div>
        </form>
      </div>
    </>
  )
}
