import { useState, type CSSProperties } from 'react'
import type { SpeakerRosterEntry } from '../state/adapters'

export interface SpeakerPopoverProps {
  /** The speaker being edited: its label as the transcript shows it now, its turn count, and any unconfirmed voice-profile match. */
  entry: SpeakerRosterEntry
  /** Every other speaker in this note: the merge targets. */
  otherSpeakers: string[]
  /** `--speaker-color` for the dot. */
  colorStyle: CSSProperties
  /** Distance from the left edge of the chip row, so the popover opens under its chip. */
  offsetLeft: number
  onRename: (name: string) => void
  onDismissSuggestion: () => void
  /** Resolves once the merge is saved. A rejection keeps the popover open for a retry. */
  onMerge: (into: string) => Promise<void>
  /** Moves every turn of this speaker to Unknown. Same contract as `onMerge`. */
  onMarkUnknown: () => Promise<void>
  onClose: () => void
}

/**
 * Rename, merge, or mark unknown one speaker. Opens under the speaker's
 * chip. Escape, Cancel, or a press outside closes it without a change.
 */
export function SpeakerPopover({
  entry: { speaker, turns, suggestion },
  otherSpeakers,
  colorStyle,
  offsetLeft,
  onRename,
  onDismissSuggestion,
  onMerge,
  onMarkUnknown,
  onClose,
}: SpeakerPopoverProps) {
  const [draft, setDraft] = useState(speaker)
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [saving, setSaving] = useState<'merge' | 'unknown' | null>(null)
  const pending = saving !== null
  const trimmed = draft.trim()

  function submitRename() {
    if (trimmed && trimmed !== speaker) onRename(trimmed)
    onClose()
  }

  function save(kind: 'merge' | 'unknown', change: () => Promise<void>) {
    if (pending) return
    setSaving(kind)
    change()
      .then(onClose)
      .catch(() => {
        // The shared error banner owns the message. Keep the popover as it
        // was for a retry.
      })
      .finally(() => setSaving(null))
  }

  return (
    <>
      <div className="context-menu-backdrop" onMouseDown={pending ? undefined : onClose} />
      <div
        className="speaker-popover"
        role="dialog"
        aria-label={`Rename ${speaker}`}
        style={{ left: offsetLeft }}
        onKeyDown={event => {
          if (event.key === 'Escape' && !pending) {
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
              <span>{speaker} · {turns} {turns === 1 ? 'turn' : 'turns'}</span>
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
          <div className="speaker-popover-options">
            {otherSpeakers.length > 0 && (
              mergeTarget === null ? (
                <button type="button" className="speaker-popover-option" disabled={pending} onClick={() => setMergeTarget(otherSpeakers[0])}>
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
                      disabled={pending}
                      onChange={event => setMergeTarget(event.target.value)}
                    >
                      {otherSpeakers.map(other => <option key={other} value={other}>{other}</option>)}
                    </select>
                  </label>
                  <button type="button" className="btn-small" disabled={pending} onClick={() => save('merge', () => onMerge(mergeTarget))}>
                    {saving === 'merge' ? 'Merging…' : 'Merge'}
                  </button>
                </div>
              )
            )}
            <button type="button" className="speaker-popover-option" disabled={pending} onClick={() => save('unknown', onMarkUnknown)}>
              {saving === 'unknown' ? 'Marking as unknown…' : 'Mark these turns as unknown'}
            </button>
          </div>
          <div className="speaker-popover-foot">
            <button type="button" className="toolbar-btn" disabled={pending} onClick={onClose}>Cancel</button>
            <button type="submit" className="toolbar-btn" data-variant="primary" disabled={!trimmed || pending}>Rename</button>
          </div>
        </form>
      </div>
    </>
  )
}
