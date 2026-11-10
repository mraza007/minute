import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { UNKNOWN_SPEAKER_LABEL, type SpeakerRosterEntry } from '../state/adapters'

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
  const nameInputRef = useRef<HTMLInputElement>(null)

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
    <PopoverFrame label={`Rename ${speaker}`} offsetLeft={offsetLeft} pending={pending} onSubmit={submitRename} onClose={onClose}>
          <div className="speaker-popover-body">
            <div className="speaker-popover-who">
              <span className="speaker-dot" style={colorStyle} aria-hidden="true" />
              <span>{speaker} · {turns} {turns === 1 ? 'turn' : 'turns'}</span>
            </div>
            <input
              ref={nameInputRef}
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
                  onClick={() => {
                    // The suggestion row unmounts once the dismissal saves.
                    // Focus moves off it first, and stays in the popover.
                    nameInputRef.current?.focus()
                    onDismissSuggestion()
                  }}
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
    </PopoverFrame>
  )
}

export interface UnknownSpeakerPopoverProps {
  /** How many turns have no speaker. */
  turns: number
  /** The note's named speakers: the turns can go to any of them. */
  speakers: string[]
  colorStyle: CSSProperties
  offsetLeft: number
  /** Resolves once the turns are saved under `to`. A rejection keeps the popover open for a retry. */
  onAssign: (to: string) => Promise<void>
  onClose: () => void
}

/** The select option for "a new name". A speaker label is never empty, so it cannot collide with one. */
const NEW_NAME = ''

/**
 * Gives a note's unknown turns to one of its speakers or to a new name.
 * Unknown is nobody, so it has no rename, merge, or mark-unknown rows.
 */
export function UnknownSpeakerPopover({ turns, speakers, colorStyle, offsetLeft, onAssign, onClose }: UnknownSpeakerPopoverProps) {
  const [existing, setExisting] = useState(speakers[0] ?? NEW_NAME)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const to = existing === NEW_NAME ? name.trim() : existing

  function assign() {
    if (pending || !to) return
    setPending(true)
    onAssign(to)
      .then(onClose)
      .catch(() => {
        // The shared error banner owns the message.
      })
      .finally(() => setPending(false))
  }

  return (
    <PopoverFrame label="Assign unknown turns" offsetLeft={offsetLeft} pending={pending} onSubmit={assign} onClose={onClose}>
      <div className="speaker-popover-body">
        <div className="speaker-popover-who">
          <span className="speaker-dot" style={colorStyle} aria-hidden="true" />
          <span>{UNKNOWN_SPEAKER_LABEL} · {turns} {turns === 1 ? 'turn' : 'turns'}</span>
        </div>
        {speakers.length > 0 && (
          <select
            autoFocus
            aria-label="Assign unknown turns to"
            value={existing}
            disabled={pending}
            onChange={event => setExisting(event.target.value)}
          >
            {speakers.map(speaker => <option key={speaker} value={speaker}>{speaker}</option>)}
            <option value={NEW_NAME}>A new name…</option>
          </select>
        )}
        {existing === NEW_NAME && (
          <input
            autoFocus
            className="speaker-popover-input"
            aria-label="New speaker name"
            placeholder="Name"
            value={name}
            disabled={pending}
            onChange={event => setName(event.target.value)}
          />
        )}
        <p>The name replaces {UNKNOWN_SPEAKER_LABEL} on these turns in the transcript.</p>
      </div>
      <div className="speaker-popover-foot">
        <button type="button" className="toolbar-btn" disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" className="toolbar-btn" data-variant="primary" disabled={!to || pending}>
          {pending ? 'Assigning…' : 'Assign'}
        </button>
      </div>
    </PopoverFrame>
  )
}

/** The shell both popovers share. Escape or a press outside closes it, unless a save is pending. */
function PopoverFrame({ label, offsetLeft, pending, onSubmit, onClose, children }: {
  label: string
  offsetLeft: number
  pending: boolean
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <>
      <div className="context-menu-backdrop" onMouseDown={pending ? undefined : onClose} />
      <div
        className="speaker-popover"
        role="dialog"
        aria-label={label}
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
            onSubmit()
          }}
        >
          {children}
        </form>
      </div>
    </>
  )
}
