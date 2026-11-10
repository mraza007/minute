import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LiveTranscriptGroup } from '../state/adapters'
import type { ProcessingFailure } from '../state/useAppState'
import { formatMmSs } from '../state/adapters'
import type { NoteMarker, RecordingOrigin, SummaryStyle } from '../ipc/types'
import type { RecordingProcessingStage, SttStatus } from '../types'
import { AppToolbar } from './AppToolbar'
import { LevelIndicator, type LevelIndicatorState } from './LevelIndicator'
import { liveTimeline, type LiveTimelineItem } from './liveTimeline'
import { ProcessingStepList } from './ProcessingStepList'
import { processingSteps } from './processingSteps'
import { transcriptPace, type CaptureHealth } from './recordingDiagnostics'
import { messageCopy, recordingHealthLine, recordingMessage, type RecordingMessage } from './recordingStatus'
import { assignSpeakerColors, speakerColorStyle, type SpeakerColors } from './speakerColors'
import { MODE_LABEL, transcriptionModeOf } from './transcriptionModes'

/** Within this many px of the bottom still counts as "stuck". It absorbs sub-pixel scrollHeight rounding. */
const STICK_THRESHOLD_PX = 48

/**
 * The live view renders at most this many of the most recent turns, so a
 * long meeting does not grow the DOM without bound. The view is read at its
 * tail, so keeping the last N is enough. Nothing is lost: every segment is
 * written to `transcript.json` as it arrives and the stopped note shows all
 * of it.
 */
const LIVE_RENDER_CAP = 200

interface RecordingViewProps {
  liveSegments: LiveTranscriptGroup[]
  paused: boolean
  togglePause: () => void
  stopRec: () => void
  stopping: boolean
  processingStage: RecordingProcessingStage
  sttStatus: SttStatus
  sttError: string | null
  modelName: string
  /** Whether this recording is mixing in system audio right now, as the backend reports it. Sources cannot change once a recording starts. */
  systemAudioActive: boolean
  /** cpal-reported name of the microphone opened for this session. */
  microphoneName: string
  captureHealth: CaptureHealth
  elapsed: number
  title: string
  renameTitle: (title: string) => Promise<void>
  markers: NoteMarker[]
  addMarker: (label: string) => Promise<void>
  processingFailure: ProcessingFailure | null
  onRetryProcessing: () => void
  onDismissProcessingFailure: () => void
  /** Auto-stop countdown (issue #9): seconds until the backend stops this silent recording on its own; `null` = no countdown pending. */
  autoStopSeconds: number | null
  /** Suppresses auto-stop for the rest of this recording. */
  onKeepRecording: () => void
  /** Issue #42: seconds of the current quiet run. */
  quietSecs: number
  /** Whether system audio capture is possible on this machine (macOS 13+, Screen Recording granted). */
  canRestartWithSystemAudio: boolean
  /**
   * Issue #26: sources are fixed at start, so enabling system audio
   * mid-recording means stop-and-restart. This finalizes the current
   * recording as its own note and starts a new one with system audio on.
   * Only called after the confirm step spells that out.
   */
  onRestartWithSystemAudio: () => void
  /** Issue #46: why this recording started. */
  origin: RecordingOrigin
  onOpenSettings: () => void
  /** Whether speaker detection runs after this recording stops. */
  speakersExpected: boolean
  /** Whether a summary is written after this recording stops. */
  summaryExpected: boolean
  summaryStyle: SummaryStyle
  /** Toolbar controls shown while the sidebar is hidden (see `SidebarReopen`). */
  toolbarLead?: ReactNode
}

/** What the row after the last turn says. */
type TranscriptTail = { kind: 'none' } | { kind: 'listening' } | { kind: 'paused' } | { kind: 'loading'; modelName: string }

function tailText(tail: TranscriptTail): string {
  switch (tail.kind) {
    case 'listening':
      return 'Listening…'
    case 'paused':
      return 'Paused'
    case 'loading':
      return `Loading ${tail.modelName}…`
    case 'none':
      return ''
  }
}

// Memoized so the 1Hz `recording-state` tick, which changes only the
// elapsed time, does not re-render every turn.
const LiveTranscriptBody = memo(function LiveTranscriptBody({
  items,
  capped,
  speakerColors,
  tail,
}: {
  items: LiveTimelineItem[]
  capped: boolean
  speakerColors: SpeakerColors
  tail: TranscriptTail
}) {
  return (
    <>
      {capped && (
        <p className="live-cap-note">Showing the latest {LIVE_RENDER_CAP} entries. The full transcript is saved.</p>
      )}
      {items.map(item =>
        item.kind === 'marker' ? (
          <div key={`marker-${item.index}`} className="live-marker">
            <span className="turn-time">{formatMmSs(item.marker.seconds)}</span>
            <span className="live-marker-label">
              <span className="live-marker-dot" aria-hidden="true" />
              Marker · {item.marker.label}
            </span>
          </div>
        ) : (
          // Keyed on the turn's own identity, never its position: once the
          // list is capped it is a rotating window, and an index key would
          // rewrite the text of a row the user has scrolled up to read.
          <div key={`${item.group.speaker}-${item.group.start}`} className="turn live-turn">
            <span className="turn-time">{formatMmSs(item.group.start)}</span>
            <div className="turn-body">
              <div className="turn-who" style={speakerColorStyle(speakerColors, item.group.speaker)}>{item.group.speaker}</div>
              <p className="turn-said">{item.group.text}</p>
            </div>
          </div>
        ),
      )}
      {/* Always mounted, with only its text changing: a live region that
          mounts with its text already inside is commonly not announced. */}
      <div className="live-tail" role="status">{tailText(tail)}</div>
    </>
  )
})

/**
 * The live transcript's scroll container. It stays pinned to the newest
 * line while the user is within `STICK_THRESHOLD_PX` of the bottom, pinning
 * before paint so new text never shows below the fold. Scrolling up breaks
 * the pin and offers "Jump to latest".
 */
const LiveTranscriptScroller = memo(function LiveTranscriptScroller({
  liveSegments,
  markers,
  tail,
  heading,
}: {
  liveSegments: LiveTranscriptGroup[]
  markers: NoteMarker[]
  tail: TranscriptTail
  /** Shown above the turns once the recording has stopped. */
  heading: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(true)

  // Colours come from every speaker so far, not only the rendered window,
  // so a speaker keeps a colour for the whole recording.
  const speakerColors = useMemo(() => assignSpeakerColors(liveSegments.map(group => group.speaker)), [liveSegments])
  const capped = liveSegments.length > LIVE_RENDER_CAP
  const items = useMemo(() => {
    if (liveSegments.length <= LIVE_RENDER_CAP) return liveTimeline(liveSegments, markers)
    const visible = liveSegments.slice(-LIVE_RENDER_CAP)
    return liveTimeline(visible, markers.filter(marker => marker.seconds >= visible[0].start))
  }, [liveSegments, markers])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX)
  }

  useLayoutEffect(() => {
    if (!stuck) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [items, tail, stuck])

  return (
    <div className="live-frame">
      {/* Outside the scroller, which stays pinned to the newest line. */}
      {heading && <h2 className="note-h live-heading">Transcript</h2>}
      <div ref={scrollRef} onScroll={handleScroll} data-testid="live-transcript-scroll" className="live-scroll">
        <div className="live-column">
          <LiveTranscriptBody items={items} capped={capped} speakerColors={speakerColors} tail={tail} />
        </div>
      </div>
      {!stuck && (
        <button
          type="button"
          onClick={() => {
            setStuck(true)
            const el = scrollRef.current
            if (el) el.scrollTop = el.scrollHeight
          }}
          className="jump-latest"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14"></path>
            <path d="m19 12-7 7-7-7"></path>
          </svg>
          Jump to latest
        </button>
      )}
    </div>
  )
})

function RecordingTitle({
  title,
  disabled,
  onRename,
}: {
  title: string
  disabled: boolean
  onRename: (title: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [saving, setSaving] = useState(false)
  const committed = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(title)
  }, [editing, title])

  function startEditing() {
    if (disabled || saving) return
    committed.current = false
    setDraft(title)
    setEditing(true)
  }

  function cancel() {
    committed.current = true
    setDraft(title)
    setEditing(false)
  }

  async function commit() {
    if (committed.current) return
    committed.current = true
    const next = draft.trim()
    setEditing(false)
    if (!next || next === title) {
      setDraft(title)
      return
    }
    setSaving(true)
    try {
      await onRename(next)
    } catch {
      setDraft(title)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="note-title-row">
        <input
          autoFocus
          aria-label="Recording title"
          className="note-title note-title-input"
          value={draft}
          maxLength={120}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
          onBlur={() => void commit()}
        />
      </div>
    )
  }

  return (
    <div className="note-title-row">
      <h1 className="note-title" title={title} onDoubleClick={startEditing}>{title}</h1>
      <button
        type="button"
        className="icon-btn note-title-edit"
        aria-label="Edit recording title"
        title="Edit recording title"
        disabled={disabled || saving}
        onClick={startEditing}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
      {saving && <span className="recording-title-saving" role="status">Saving…</span>}
    </div>
  )
}

interface MessageActions {
  onKeepRecording: () => void
  onStop: () => void
  onRetrySave: () => void
  onDismissSaveFailure: () => void
  onRestartWithSystemAudio: () => void
}

/**
 * The restart offer and its confirm step (issue #26). The restart splits
 * the meeting into two notes, so one stray click must not trigger it. The
 * armed state lives here so it resets whenever another message takes over.
 */
function MicOnlyMessage({ onRestart }: { onRestart: () => void }) {
  const [armed, setArmed] = useState(false)
  // "Go back" returns focus here. Backing out unmounts the focused button,
  // which would otherwise drop focus on the body.
  const offerRef = useRef<HTMLButtonElement>(null)
  const copy = messageCopy({ kind: 'micOnly' })

  if (!armed) {
    return (
      <div className="recording-message" data-tone={copy.tone}>
        <div className="recording-message-copy">
          <strong>{copy.title}</strong>
          <span>{copy.detail}</span>
        </div>
        <button type="button" ref={offerRef} className="message-action" onClick={() => setArmed(true)}>
          Restart with system audio
        </button>
      </div>
    )
  }

  // An inline confirm, not a modal: no dialog role, since nothing traps focus.
  return (
    <div className="recording-message" data-tone={copy.tone} role="group" aria-label="Confirm restart with system audio">
      <div className="recording-message-copy">
        <strong>Save this note and start a new one?</strong>
        <span>
          Minute saves the recording so far as its own note, then starts a new one with system audio on. The meeting
          becomes two notes.
        </span>
      </div>
      <button
        type="button"
        // Arming unmounts the focused offer, so focus moves to the primary action.
        autoFocus
        className="message-action"
        onClick={() => {
          setArmed(false)
          onRestart()
        }}
      >
        Save &amp; restart
      </button>
      <button
        type="button"
        className="message-action"
        data-tone="muted"
        onClick={() => {
          setArmed(false)
          requestAnimationFrame(() => offerRef.current?.focus())
        }}
      >
        Go back
      </button>
    </div>
  )
}

export function StatusMessage({ message, actions }: { message: RecordingMessage; actions: MessageActions }) {
  if (message.kind === 'micOnly') return <MicOnlyMessage onRestart={actions.onRestartWithSystemAudio} />

  const copy = messageCopy(message)
  return (
    <div className="recording-message" data-tone={copy.tone}>
      <div className="recording-message-copy">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>
      {message.kind === 'autoStop' && (
        <button type="button" className="message-action" onClick={actions.onKeepRecording}>Keep recording</button>
      )}
      {(message.kind === 'disconnected' || message.kind === 'transcriptFailed') && (
        <button type="button" className="message-action" onClick={actions.onStop}>Stop and save</button>
      )}
      {message.kind === 'saveFailed' && (
        <>
          <button type="button" className="message-action" onClick={actions.onRetrySave}>Retry finish</button>
          <button type="button" className="message-action" data-tone="muted" onClick={actions.onDismissSaveFailure}>
            Continue recording
          </button>
        </>
      )}
    </div>
  )
}

function levelState(captureHealth: CaptureHealth): LevelIndicatorState {
  if (captureHealth === 'paused') return 'paused'
  return captureHealth === 'healthy' || captureHealth === 'clipping' ? 'live' : 'idle'
}

export const RecordingView = memo(function RecordingView({
  liveSegments,
  paused,
  togglePause,
  stopRec,
  stopping,
  processingStage,
  sttStatus,
  sttError,
  modelName,
  systemAudioActive,
  microphoneName,
  captureHealth,
  elapsed,
  title,
  renameTitle,
  markers,
  addMarker,
  processingFailure,
  onRetryProcessing,
  onDismissProcessingFailure,
  autoStopSeconds,
  onKeepRecording,
  quietSecs,
  canRestartWithSystemAudio,
  onRestartWithSystemAudio,
  origin,
  onOpenSettings,
  speakersExpected,
  summaryExpected,
  summaryStyle,
  toolbarLead,
}: RecordingViewProps) {
  const latestSegmentEnd = liveSegments.length > 0 ? liveSegments[liveSegments.length - 1].end : null
  const pace = transcriptPace(elapsed, latestSegmentEnd, sttStatus, paused)
  const processing = stopping && processingStage !== 'idle'
  const [markerOpen, setMarkerOpen] = useState(false)
  const [markerLabel, setMarkerLabel] = useState('')
  const [markerSaving, setMarkerSaving] = useState(false)

  const message = processing
    ? null
    : recordingMessage({
        saveFailure: processingFailure?.stage === 'saving' ? processingFailure.message : null,
        autoStopSeconds,
        quietSecs,
        paused,
        captureHealth,
        pace,
        sttError,
        microphoneName,
        systemAudioActive,
        canRestartWithSystemAudio,
      })
  const messageText = message ? messageCopy(message) : null
  const health = recordingHealthLine(captureHealth, pace)

  const sources = `${microphoneName}${systemAudioActive ? ' + system audio' : ' only'}`
  const tail = useMemo<TranscriptTail>(() => {
    if (processing || sttStatus === 'error') return { kind: 'none' }
    if (paused) return { kind: 'paused' }
    if (liveSegments.length === 0 && sttStatus === 'loading') return { kind: 'loading', modelName }
    return { kind: 'listening' }
  }, [processing, sttStatus, paused, liveSegments.length, modelName])

  async function saveMarker() {
    const label = markerLabel.trim()
    if (!label || markerSaving) return
    setMarkerSaving(true)
    try {
      await addMarker(label)
      setMarkerLabel('')
      setMarkerOpen(false)
    } catch {
      // useAppState already reports the failed write. The draft stays so
      // the user can retry without retyping it.
    } finally {
      setMarkerSaving(false)
    }
  }

  useEffect(() => {
    if (processing || stopping) return
    function handleShortcut(event: KeyboardEvent) {
      if (event.repeat) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, button, [contenteditable="true"]')) {
        return
      }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setMarkerOpen(true)
      } else if (event.metaKey && event.key === 'Enter') {
        event.preventDefault()
        stopRec()
      } else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'Space') {
        event.preventDefault()
        togglePause()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [processing, stopping, stopRec, togglePause])

  const stopLabel = summaryExpected ? 'Stop and summarize' : 'Stop and transcribe'

  return (
    <main className="recording-view" data-processing={processing ? 'true' : undefined}>
      <AppToolbar lead={toolbarLead}>
        {!processing && (
          <button
            type="button"
            className="toolbar-btn"
            aria-keyshortcuts="Meta+Shift+M"
            title="Add a timestamped marker (⌘⇧M)"
            aria-expanded={markerOpen}
            onClick={() => setMarkerOpen(open => !open)}
          >
            Add marker
            <kbd className="kbd-hint" aria-hidden="true">⌘⇧M</kbd>
          </button>
        )}
      </AppToolbar>

      <div className="recording-head">
        <header className="note-head-title">
          <RecordingTitle title={title} disabled={processing || stopping} onRename={renameTitle} />
          <div className="note-meta">
            {processing ? `${formatMmSs(elapsed)} · ` : ''}
            {sources} · {MODE_LABEL[transcriptionModeOf(modelName)]} transcription · {modelName}
          </div>
        </header>

        {!processing && origin.kind === 'automatic' && (
          <div className="recording-notice">
            <span>Started automatically when {origin.appName} began a call.</span>
            <button type="button" className="message-action" onClick={onOpenSettings}>Change</button>
          </div>
        )}

        {message && (
          <StatusMessage
            key={message.kind}
            message={message}
            actions={{
              onKeepRecording,
              onStop: stopRec,
              onRetrySave: onRetryProcessing,
              onDismissSaveFailure: onDismissProcessingFailure,
              onRestartWithSystemAudio,
            }}
          />
        )}
        {/* Always mounted, with only its text changing, so a new message is announced. */}
        <span role="status" aria-label="Recording status" className="visually-hidden">
          {messageText ? `${messageText.title}. ${messageText.detail}` : ''}
        </span>

        {processing && (
          <ProcessingStepList
            steps={processingSteps({
              capture: processingStage === 'preparing' ? 'saved' : processingStage === 'finalizing' ? 'finalizing' : 'saving',
              speakers: speakersExpected ? 'expected' : 'none',
              summary: summaryExpected ? 'expected' : 'none',
              summaryStyle,
            })}
          />
        )}
      </div>

      <LiveTranscriptScroller liveSegments={liveSegments} markers={markers} tail={tail} heading={processing} />

      {markerOpen && !processing && (
        <form
          className="inline-form recording-marker-compose"
          onSubmit={event => {
            event.preventDefault()
            void saveMarker()
          }}
        >
          <span className="inline-form-time">{formatMmSs(elapsed)}</span>
          <input
            autoFocus
            aria-label="Marker label"
            value={markerLabel}
            maxLength={100}
            placeholder="What should you remember?"
            onChange={event => setMarkerLabel(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setMarkerOpen(false)
                setMarkerLabel('')
              }
            }}
          />
          <button type="submit" className="btn-small" data-variant="primary" disabled={!markerLabel.trim() || markerSaving}>
            {markerSaving ? 'Saving…' : 'Save marker'}
          </button>
        </form>
      )}

      {processing ? (
        <div className="recording-bar" data-processing="true">
          <span className="spin note-spinner" aria-hidden="true" />
          Keep Minute open while this finishes.
        </div>
      ) : (
        <div className="recording-bar">
          <button
            type="button"
            onClick={stopRec}
            disabled={stopping}
            className="recording-stop"
            aria-keyshortcuts="Meta+Enter"
            title={`${stopLabel} (⌘↵)`}
          >
            <span className="recording-stop-mark" aria-hidden="true" />
            {stopLabel}
            <kbd className="kbd-hint" aria-hidden="true">⌘↵</kbd>
          </button>
          <button
            type="button"
            onClick={togglePause}
            disabled={stopping}
            className="recording-pause"
            aria-keyshortcuts="Space"
            title={`${paused ? 'Resume' : 'Pause'} recording (Space)`}
          >
            {paused ? 'Resume' : 'Pause'}
            <kbd className="kbd-hint" aria-hidden="true">Space</kbd>
          </button>
          <div className="recording-health" data-tone={health.tone}>
            <LevelIndicator state={levelState(captureHealth)} />
            <span className="recording-health-dot" aria-hidden="true" />
            <span aria-hidden="true">{health.text}</span>
            <span role="status" aria-label="Recording health updates" aria-atomic="true" className="visually-hidden">
              {health.announcement}
            </span>
          </div>
        </div>
      )}
    </main>
  )
})
