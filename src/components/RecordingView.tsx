import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LiveTranscriptGroup } from '../state/adapters'
import type { ProcessingFailure } from '../state/useAppState'
import { formatMmSs } from '../state/adapters'
import type { NoteMarker } from '../ipc/types'
import type { RecordingProcessingStage, SttStatus } from '../types'
import {
  transcriptPace,
  type CaptureHealth,
  type TranscriptPaceResult,
} from './recordingDiagnostics'
import { Waveform } from './Waveform'

/** Within this many px of the bottom still counts as "stuck" — accounts for sub-pixel scrollHeight rounding, not just an exact 0. */
const STICK_THRESHOLD_PX = 48

/**
 * Live view renders at most this many of the most recent grouped rows —
 * unbounded DOM growth over a long meeting (hundreds of groups, each with
 * its own speaker/timestamp row and text block) is the live-recording
 * counterpart to `TranscriptList`'s stored-note virtualization (Task 7).
 * Simpler than virtualizing here: the live list only ever grows and is only
 * ever viewed at its tail (stick-to-bottom is the default — see
 * `LiveTranscriptScroller`), so a plain "keep the last N" cap is enough —
 * no windowing machinery needed for content the user has already scrolled
 * past. The full transcript is never lost: everything is still persisted to
 * `transcript.json` as it arrives and is available in full once the note is
 * stopped (via `TranscriptList`) — capping only what's rendered *live*.
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
  /**
   * Stage 5 Task 5: whether this recording is actually mixing in system
   * audio right now — the real, backend-confirmed state from
   * `recording-state`'s `systemAudioActive` field, not merely what the
   * Settings toggle happens to be set to (those can disagree: e.g.
   * permission denied after the setting was turned on). Display-only here —
   * a recording's audio source can't change once it's started, so the
   * segmented control below reflects this but never lets it be clicked;
   * see `SettingsView`'s "Capture system audio" toggle for where that
   * setting is actually changed, ahead of the *next* recording.
   */
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
  /** "Keep recording" on the auto-stop banner — suppresses auto-stop for the rest of this recording. */
  onKeepRecording: () => void
  /** Whether system audio capture is even possible on this machine (macOS 13+, Screen Recording granted) — gates the restart offer below. */
  canRestartWithSystemAudio: boolean
  /**
   * Issue #26: sources are fixed at start, so enabling system audio
   * mid-recording means stop-and-restart — this finalizes the current
   * recording as its own note and starts a new one with system audio on.
   * Only called after the inline confirm step spells that out.
   */
  onRestartWithSystemAudio: () => void
}

// Persistent `role="status"` container — always mounted for the whole
// recording view (LiveTranscriptBody renders it unconditionally below), with
// only its `active` prop toggling the visible dot+text in and out. A
// role="status" node that gets conditionally mounted/unmounted with its
// announcement text already inside is commonly missed by screen readers, so
// this stays in the tree the entire time and only its content changes.
//
// Sits in the transcript's text column (offset past the timestamp gutter) so
// the caret lands exactly where the next transcribed line will appear.
function TranscribingIndicator({ active }: { active: boolean }) {
  return (
    <div
      role="status"
      style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--accent-text)', fontSize: 12, fontWeight: 600 }}
    >
      {active && (
        <>
          <span
            className="blink-dot"
            style={{ width: 7, height: 15, background: 'var(--accent)', display: 'inline-block', animation: 'blink 1s step-end infinite' }}
          />
          transcribing…
        </>
      )}
    </div>
  )
}

function SttErrorRow({ sttError }: { sttError: string | null }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        borderLeft: '2px solid var(--accent)',
        background: 'var(--accent-tint)',
        padding: '10px 14px',
        color: 'var(--accent-text)',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>Recording continues — transcript unavailable</div>
      {sttError && <div style={{ fontSize: 11.5 }}>{sttError}</div>}
    </div>
  )
}

// Memoized (same precedent as Waveform) so a parent re-render that doesn't
// actually change these props — e.g. the 1Hz `recording-state` tick, which
// only touches `recElapsed` up in TitleBar, not anything passed here —
// doesn't force the whole segment list to re-render every second.
const LiveTranscriptBody = memo(function LiveTranscriptBody({
  liveSegments,
  sttStatus,
  sttError,
  modelName,
}: {
  liveSegments: LiveTranscriptGroup[]
  sttStatus: SttStatus
  sttError: string | null
  modelName: string
}) {
  // "Loading {model}…" only ever applies to the empty-list case; the error
  // row (its own role="alert", unaffected by this rework) takes over from
  // the transcribing indicator either way once sttStatus is 'error'.
  const showLoadingHint = liveSegments.length === 0 && sttStatus === 'loading'
  const showError = sttStatus === 'error'
  const showTranscribing = !showLoadingHint && !showError

  // Cap rendered rows at LIVE_RENDER_CAP — see that constant's docs. Always
  // the *most recent* groups (a `slice(-N)`, not the earliest) since the
  // live view is stick-to-bottom by default; the full list is still what's
  // persisted, only rendering is capped.
  const capped = liveSegments.length > LIVE_RENDER_CAP
  const visibleGroups = capped ? liveSegments.slice(-LIVE_RENDER_CAP) : liveSegments

  return (
    <>
      {capped && (
        <div className="script-line">
          <span />
          <div className="mlab">Showing the latest {LIVE_RENDER_CAP} entries — the full transcript is saved.</div>
        </div>
      )}
      {visibleGroups.map(group => (
        // Keyed on the group's own identity (`speaker`+`start`), never a
        // positional index: `visibleGroups` is a *rotating* window
        // (`slice(-LIVE_RENDER_CAP)`) once capped — every new arrival drops
        // the oldest group and shifts everyone else's array index down by
        // one, even though nothing about those groups themselves changed.
        // An index key would make React read that as "the row at this
        // position now has different content" and rewrite each visible
        // row's text in place — silently changing what a user scrolled up
        // to read out from under them, without moving their scroll
        // position at all. Keying on identity instead means a group
        // already in the window keeps its own DOM node (and thus its own
        // text) untouched; only the dropped group's node is removed and
        // the new group's node appended. `start` is unique per group here
        // — `groupLiveSegments` (adapters.ts) only ever starts a *new*
        // group on a speaker change, and stream time only moves forward —
        // but `speaker` is included too as a defensive tiebreaker rather
        // than relying on that alone.
        //
        // Uses the same `.script-line` manuscript grid the stored
        // transcript does, so a live line lands in exactly the position it
        // will occupy once the note is stopped — nothing reflows when
        // recording ends.
        <div key={`${group.speaker}-${group.start}`} className="script-line live-script-line">
          <div className="script-ts" style={{ padding: '3px 0 0' }}>
            {formatMmSs(group.start)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="script-who">{group.speaker}</div>
            <p className="script-said">{group.text}</p>
          </div>
        </div>
      ))}
      {showLoadingHint && (
        <div className="script-line">
          <span />
          <div style={{ fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-muted)' }}>Loading {modelName}…</div>
        </div>
      )}
      {showError && (
        <div className="script-line">
          <span />
          <SttErrorRow sttError={sttError} />
        </div>
      )}
      <div className="script-line">
        <span />
        <TranscribingIndicator active={showTranscribing} />
      </div>
    </>
  )
})

/**
 * Stick-to-bottom scroll container for the live transcript (H6 — previously
 * new segments just appended below the fold with no way back to them short
 * of manually scrolling). Tracks whether the user is within
 * `STICK_THRESHOLD_PX` of the bottom via `onScroll`; while stuck, a
 * `useLayoutEffect` keyed on the content itself (`liveSegments`/`sttStatus`/
 * `sttError` — whatever `LiveTranscriptBody` actually renders off) pins
 * `scrollTop` to the bottom *before paint* so new text never visibly
 * flashes below the fold. Scrolling up breaks the stick and surfaces a
 * floating "Jump to latest" pill; clicking it (or `stuck` flipping back to
 * `true`) re-pins on the next layout pass.
 */
function LiveTranscriptScroller({
  liveSegments,
  sttStatus,
  sttError,
  modelName,
}: {
  liveSegments: LiveTranscriptGroup[]
  sttStatus: SttStatus
  sttError: string | null
  modelName: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(true)

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setStuck(distanceFromBottom <= STICK_THRESHOLD_PX)
  }

  useLayoutEffect(() => {
    if (!stuck) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [liveSegments, sttStatus, sttError, stuck])

  return (
    <div className="live-transcript-frame">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="live-transcript-scroll"
        className="script"
        style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 21 }}
      >
        <div className="script-line">
          <span />
          <div className="mlab">Live transcript — audio never leaves this machine</div>
        </div>
        <LiveTranscriptBody liveSegments={liveSegments} sttStatus={sttStatus} sttError={sttError} modelName={modelName} />
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
}

function MicrophoneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
      <path d="M12 19v3"></path>
    </svg>
  )
}

function SystemAudioIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2"></rect>
      <path d="M8 21h8M12 17v4"></path>
    </svg>
  )
}

function SourceDetailRow({
  icon,
  label,
  value,
  state,
  active,
}: {
  icon: React.ReactNode
  label: string
  value: string
  state: string
  active: boolean
}) {
  return (
    <div className="source-detail-row" data-active={active ? 'true' : 'false'}>
      <div className="source-detail-icon">{icon}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="source-detail-label">{label}</div>
        <div className="source-detail-value" title={value}>{value}</div>
      </div>
      <div className="source-detail-state">
        <span className="source-state-dot" />
        {state}
      </div>
    </div>
  )
}

const CAPTURE_HEALTH_COPY: Record<CaptureHealth, { label: string; detail: string; tone: string }> = {
  checking: {
    label: 'Checking microphone',
    detail: 'Waiting for the first input sample.',
    tone: 'neutral',
  },
  healthy: {
    label: 'Input healthy',
    detail: 'Minute is receiving audio from this microphone.',
    tone: 'positive',
  },
  paused: {
    label: 'Input paused',
    detail: 'Resume when you are ready to continue capturing.',
    tone: 'neutral',
  },
  silent: {
    label: 'No input detected',
    detail: 'Check that the microphone is not muted or covered.',
    tone: 'warning',
  },
  clipping: {
    label: 'Input is clipping',
    detail: 'Lower the microphone input level to keep speech clear.',
    tone: 'warning',
  },
  disconnected: {
    label: 'Microphone stopped responding',
    detail: 'Reconnect it or stop to safely finish what has already been captured.',
    tone: 'danger',
  },
}

function transcriptPaceCopy(result: TranscriptPaceResult): { label: string; detail: string; tone: string } {
  const lag = Math.max(1, Math.round(result.lagSeconds))
  switch (result.pace) {
    case 'current':
      return {
        label: 'Transcript caught up',
        detail: 'On-device transcription is keeping pace.',
        tone: 'positive',
      }
    case 'behind':
      return {
        label: `Transcript about ${lag}s behind`,
        detail: 'Audio capture is safe while the transcript catches up.',
        tone: 'neutral',
      }
    case 'delayed':
      return {
        label: `Transcript delayed by about ${lag}s`,
        detail: 'Recording continues; keep Minute open while transcription catches up.',
        tone: 'warning',
      }
    case 'paused':
      return {
        label: 'Transcript paused',
        detail: 'It will continue when recording resumes.',
        tone: 'neutral',
      }
    case 'unavailable':
      return {
        label: 'Transcript unavailable',
        detail: 'Audio is still being saved and can be transcribed later.',
        tone: 'danger',
      }
    case 'finalizing':
      return {
        label: 'Finalizing transcript',
        detail: 'Processing the final captured audio.',
        tone: 'neutral',
      }
    default:
      return {
        label: 'Listening for speech',
        detail: 'The first transcript line will appear here.',
        tone: 'neutral',
      }
  }
}

function transcriptPaceAnnouncement(result: TranscriptPaceResult): string {
  switch (result.pace) {
    case 'current':
      return 'Transcript caught up. On-device transcription is keeping pace.'
    case 'behind':
      return 'Transcript is behind. Audio capture is safe while the transcript catches up.'
    case 'delayed':
      return 'Transcript is delayed. Recording continues; keep Minute open while transcription catches up.'
    case 'paused':
      return 'Transcript paused. It will continue when recording resumes.'
    case 'unavailable':
      return 'Transcript unavailable. Audio is still being saved and can be transcribed later.'
    case 'finalizing':
      return 'Finalizing transcript. Processing the final captured audio.'
    default:
      return 'Listening for speech. The first transcript line will appear here.'
  }
}

function RecordingHealthBar({
  captureHealth,
  transcript,
}: {
  captureHealth: CaptureHealth
  transcript: TranscriptPaceResult
}) {
  const capture = CAPTURE_HEALTH_COPY[captureHealth]
  const pace = transcriptPaceCopy(transcript)
  const announcement = `${capture.label}. ${capture.detail} ${transcriptPaceAnnouncement(transcript)}`
  return (
    <>
      <div className="recording-health-bar">
        <div className="recording-health-item" data-tone={capture.tone}>
          <span className="recording-health-dot" aria-hidden="true" />
          <span>
            <strong>{capture.label}</strong>
            <span>{capture.detail}</span>
          </span>
        </div>
        <div className="recording-health-divider" aria-hidden="true" />
        <div className="recording-health-item" data-tone={pace.tone}>
          <span className="recording-health-dot" aria-hidden="true" />
          <span>
            <strong>{pace.label}</strong>
            <span>{pace.detail}</span>
          </span>
        </div>
      </div>
      <span
        role="status"
        aria-label="Recording health updates"
        aria-atomic="true"
        className="visually-hidden"
      >
        {announcement}
      </span>
    </>
  )
}

const PROCESSING_STEPS: Array<{
  id: Exclude<RecordingProcessingStage, 'idle'>
  label: string
  detail: string
}> = [
  { id: 'saving', label: 'Saving audio', detail: 'Closing the local recording file safely.' },
  { id: 'finalizing', label: 'Finalizing transcript', detail: 'Processing the last spoken moments.' },
  { id: 'preparing', label: 'Preparing notes', detail: 'Opening the completed meeting record.' },
]

function ProcessingHandoff({
  stage,
  elapsed,
  microphoneName,
  captureSummary,
}: {
  stage: Exclude<RecordingProcessingStage, 'idle'>
  elapsed: number
  microphoneName: string
  captureSummary: string
}) {
  const activeIndex = PROCESSING_STEPS.findIndex(step => step.id === stage)
  return (
    <section className="processing-handoff" aria-labelledby="processing-title">
      <div className="processing-copy">
        <div className="mlab">Recording complete</div>
        <h2 id="processing-title">Turning your recording into notes</h2>
        <p>Audio is already on this Mac. Minute is finishing the transcript before opening the note.</p>
      </div>
      <ol className="processing-steps" aria-live="polite">
        {PROCESSING_STEPS.map((step, index) => {
          const state = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'waiting'
          return (
            <li key={step.id} data-state={state}>
              <span className="processing-step-mark" aria-hidden="true">
                {state === 'complete' ? '✓' : index + 1}
              </span>
              <span>
                <strong>{step.label}</strong>
                <span>{state === 'active' ? step.detail : state === 'complete' ? 'Complete' : 'Waiting'}</span>
              </span>
            </li>
          )
        })}
      </ol>
      <dl className="processing-meta">
        <div>
          <dt>Duration</dt>
          <dd>{formatMmSs(elapsed)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd title={microphoneName}>{microphoneName}</dd>
        </div>
        <div>
          <dt>Capture</dt>
          <dd>{captureSummary}</dd>
        </div>
      </dl>
    </section>
  )
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d={open ? 'm12 9-3 3 3 3' : 'm9 9 3 3-3 3'} />
    </svg>
  )
}

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
      <input
        autoFocus
        aria-label="Recording title"
        className="recording-title-input"
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
    )
  }

  return (
    <div className="recording-title-value">
      <h1 title={title}>{title}</h1>
      <button
        type="button"
        className="icon-btn recording-title-edit"
        aria-label="Edit recording title"
        title="Edit recording title"
        disabled={disabled || saving}
        onClick={() => {
          committed.current = false
          setDraft(title)
          setEditing(true)
        }}
      >
        <PencilIcon />
      </button>
      {saving && <span className="recording-title-saving" role="status">Saving…</span>}
    </div>
  )
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
  canRestartWithSystemAudio,
  onRestartWithSystemAudio,
}: RecordingViewProps) {
  const captureSummary = systemAudioActive ? 'Microphone + system audio' : 'Microphone only'
  const transcriptState =
    processingStage === 'saving'
      ? 'Saving audio'
      : processingStage === 'preparing'
        ? 'Ready'
        : sttStatus === 'error'
      ? 'Unavailable'
      : sttStatus === 'loading'
        ? 'Loading model'
        : paused
          ? 'Paused'
          : sttStatus === 'finalizing'
            ? 'Finalizing'
            : 'Live'
  const latestSegmentEnd = liveSegments.length > 0 ? liveSegments[liveSegments.length - 1].end : null
  const transcript = transcriptPace(elapsed, latestSegmentEnd, sttStatus, paused)
  const activeProcessingStage = processingStage === 'idle' ? null : processingStage
  const processing = stopping && activeProcessingStage !== null
  const [detailsOpen, setDetailsOpen] = useState(() => {
    if (typeof window.matchMedia !== 'function') return true
    return !window.matchMedia('(max-width: 1280px)').matches
  })
  const [markerOpen, setMarkerOpen] = useState(false)
  const [markerLabel, setMarkerLabel] = useState('')
  /** Two-step confirm for "Restart with system audio" (issue #26) — the restart splits the meeting into two notes, so a single stray click must not trigger it. */
  const [restartArmed, setRestartArmed] = useState(false)
  /** "Go back" returns focus here — backing out of the confirm unmounts the focused button, which would otherwise drop focus on body. */
  const restartOfferRef = useRef<HTMLButtonElement>(null)
  const [markerSaving, setMarkerSaving] = useState(false)

  async function saveMarker() {
    const label = markerLabel.trim()
    if (!label || markerSaving) return
    setMarkerSaving(true)
    try {
      await addMarker(label)
      setMarkerLabel('')
      setMarkerOpen(false)
    } catch {
      // useAppState already reports the persisted-write error; keep the
      // draft in place so the user can retry without retyping it.
    } finally {
      setMarkerSaving(false)
    }
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(max-width: 1280px)')
    const sync = () => setDetailsOpen(!query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

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

  return (
    <main
      className="recording-shell"
      data-details-open={detailsOpen ? 'true' : 'false'}
      style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--panel)' }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div className="recording-title-strip">
          <RecordingTitle title={title} disabled={processing || stopping} onRename={renameTitle} />
          <button
            type="button"
            className="recording-details-toggle"
            aria-expanded={detailsOpen}
            aria-controls="recording-details-panel"
            title={`${detailsOpen ? 'Hide' : 'Show'} recording details`}
            onClick={() => setDetailsOpen(open => !open)}
          >
            <PanelIcon open={detailsOpen} />
            {detailsOpen ? 'Hide details' : 'Show details'}
          </button>
        </div>
        <section
          className="capture-bar"
          data-paused={paused || processing ? 'true' : 'false'}
          data-processing={processing ? 'true' : 'false'}
          aria-labelledby="capture-source-heading"
        >
          <div className="capture-source">
            <div className="capture-icon">
              <MicrophoneIcon />
              <span className="capture-live-dot" aria-hidden="true" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="mlab" id="capture-source-heading">
                {processing ? 'Captured from' : paused ? 'Capture paused' : 'Capturing from'}
              </div>
              <div className="capture-source-name" title={microphoneName}>{microphoneName}</div>
              <div className="capture-source-meta">{captureSummary} · macOS default input</div>
            </div>
          </div>
          <Waveform paused={paused || processing} />
          <div className="capture-model">
            <div className="mlab">Live transcription</div>
            <div className="capture-model-name">{modelName}</div>
            <div className="capture-source-meta">{transcriptState} · on-device</div>
          </div>
        </section>

        {processing ? (
          <ProcessingHandoff
            stage={activeProcessingStage!}
            elapsed={elapsed}
            microphoneName={microphoneName}
            captureSummary={captureSummary}
          />
        ) : (
          <>
            <RecordingHealthBar captureHealth={captureHealth} transcript={transcript} />
            {autoStopSeconds !== null && (
              <div className="recording-recovery" role="status">
                <span>
                  <strong>Nothing has been audible for a while.</strong>
                  Minute will stop and transcribe in {formatMmSs(autoStopSeconds)} unless audio
                  returns.
                </span>
                <button type="button" className="btn-outline" onClick={onKeepRecording}>
                  Keep recording
                </button>
                <button type="button" className="btn-quiet" onClick={stopRec}>
                  Stop now
                </button>
              </div>
            )}
            {processingFailure?.stage === 'saving' && (
              <div className="recording-recovery" role="status">
                <span>
                  <strong>Minute could not finish this recording.</strong>
                  Audio capture is still active. {processingFailure.message}
                </span>
                <button type="button" className="btn-outline" onClick={onRetryProcessing}>Retry finish</button>
                <button type="button" className="btn-quiet" onClick={onDismissProcessingFailure}>Continue recording</button>
              </div>
            )}
            <LiveTranscriptScroller liveSegments={liveSegments} sttStatus={sttStatus} sttError={sttError} modelName={modelName} />
          </>
        )}

        {/* Flush control strip, continuous with the player bar on the notes
            side — same height, same rule, same chrome fill, so switching
            between the two views doesn't shift the bottom edge. */}
        {processing ? (
          <div className="recording-controls processing-controls">
            <span className="processing-spinner" aria-hidden="true" />
            Keep Minute open while this finishes.
          </div>
        ) : (
          <>
          {markerOpen && (
            <form
              className="recording-marker-compose"
              onSubmit={event => {
                event.preventDefault()
                void saveMarker()
              }}
            >
              <span className="marker-time">{formatMmSs(elapsed)}</span>
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
              <button type="submit" className="btn-solid" disabled={!markerLabel.trim() || markerSaving}>
                {markerSaving ? 'Saving…' : 'Save marker'}
              </button>
            </form>
          )}
          <div className="recording-controls">
            <button
              onClick={stopRec}
              disabled={stopping}
              className="btn-solid"
              aria-keyshortcuts="Meta+Enter"
              title="Stop and transcribe (⌘↵)"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect width="12" height="12" x="6" y="6"></rect>
              </svg>
              Stop & transcribe
              <kbd className="control-shortcut" aria-hidden="true">⌘↵</kbd>
            </button>
            <button
              onClick={togglePause}
              disabled={stopping}
              className="btn-outline"
              aria-keyshortcuts="Space"
              title={`${paused ? 'Resume' : 'Pause'} recording (Space)`}
            >
              {paused ? 'Resume' : 'Pause'}
              <kbd className="control-shortcut" aria-hidden="true">Space</kbd>
            </button>
            <button
              type="button"
              className="btn-quiet marker-control"
              aria-keyshortcuts="Meta+Shift+M"
              title="Add a timestamped marker (⌘⇧M)"
              onClick={() => setMarkerOpen(open => !open)}
            >
              Add marker
              <kbd className="control-shortcut" aria-hidden="true">⌘⇧M</kbd>
            </button>
          </div>
          </>
        )}
      </div>

      <aside
        id="recording-details-panel"
        aria-label="Recording details"
        aria-hidden={!detailsOpen}
        hidden={!detailsOpen}
        className="recording-details"
        style={{
          width: 304,
          flex: 'none',
          borderLeft: '1px solid var(--rule)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--panel)',
        }}
      >
        <div className="recording-details-head" style={{ padding: '24px 26px 20px' }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 17, letterSpacing: '-.005em' }}>
              Recording details
            </h2>
            <p style={{ margin: '5px 0 0', fontSize: 11.5, color: 'var(--ink-muted)' }}>
              Sources are fixed until you stop.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn recording-details-close"
            aria-label="Hide recording details"
            title="Hide recording details"
            onClick={() => setDetailsOpen(false)}
          >
            <PanelIcon open={true} />
          </button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 26px 24px' }}>
          <section style={{ marginBottom: 25 }}>
            <div className="sec-head" style={{ marginBottom: 9 }}>
              <span className="mlab">Capture sources</span>
            </div>
            <div className="source-detail-list">
              <SourceDetailRow
                icon={<MicrophoneIcon />}
                label="Microphone"
                value={microphoneName}
                state={processing ? 'Saved' : paused ? 'Paused' : 'Active'}
                active={!paused && !processing}
              />
              <SourceDetailRow
                icon={<SystemAudioIcon />}
                label="System audio"
                value={systemAudioActive ? 'Apps and call audio' : 'Not part of this recording'}
                state={systemAudioActive ? (processing ? 'Saved' : paused ? 'Paused' : 'Active') : 'Off'}
                active={systemAudioActive && !paused && !processing}
              />
            </div>
            {!systemAudioActive && !canRestartWithSystemAudio && (
              <p className="recording-detail-note">
                Turn on system audio in Settings before your next recording to capture the other side of a call.
              </p>
            )}
            {/* Issue #26: sources are fixed once a recording starts, so the
                honest mid-recording gesture is stop-and-restart — offered
                only when system audio could actually be captured. */}
            {!systemAudioActive && canRestartWithSystemAudio && !restartArmed && (
              <>
                <p className="recording-detail-note">
                  Started without system audio by mistake? Restart to capture the other side of the call.
                </p>
                <button
                  type="button"
                  ref={restartOfferRef}
                  className="btn-outline"
                  disabled={processing}
                  style={{ marginTop: 8, padding: '6px 12px', fontSize: 11.5 }}
                  onClick={() => setRestartArmed(true)}
                >
                  Restart with system audio
                </button>
              </>
            )}
            {/* An inline confirm, not a modal — no dialog role (that would
                promise focus trapping this block doesn't do). "Go back", not
                "Keep recording": the auto-stop banner's own "Keep recording"
                button can be on screen at the same time, and two identical
                accessible names doing different things is how the wrong one
                gets clicked. */}
            {!systemAudioActive && canRestartWithSystemAudio && restartArmed && (
              <div role="group" aria-label="Confirm restart with system audio">
                <p className="recording-detail-note">
                  This saves the recording so far as its own note, then starts a new one with system audio on. The
                  meeting ends up as two notes.
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    // Arming unmounts the focused offer button — land focus
                    // on the primary action instead of dropping it on body.
                    autoFocus
                    className="btn-solid"
                    disabled={processing}
                    style={{ padding: '6px 12px', fontSize: 11.5 }}
                    onClick={() => {
                      setRestartArmed(false)
                      onRestartWithSystemAudio()
                    }}
                  >
                    Save & restart
                  </button>
                  <button
                    type="button"
                    className="btn-outline"
                    style={{ padding: '6px 12px', fontSize: 11.5 }}
                    onClick={() => {
                      setRestartArmed(false)
                      requestAnimationFrame(() => restartOfferRef.current?.focus())
                    }}
                  >
                    Go back
                  </button>
                </div>
              </div>
            )}
          </section>
          <section style={{ marginBottom: 25 }}>
            <div className="sec-head" style={{ marginBottom: 9 }}>
              <span className="mlab">Markers · {markers.length}</span>
            </div>
            {markers.length === 0 ? (
              <p className="recording-detail-note">Add a marker when a decision or follow-up is worth revisiting.</p>
            ) : (
              <ol className="recording-marker-list">
                {markers.map((marker, index) => (
                  <li key={`${marker.seconds}-${index}`}>
                    <span>{formatMmSs(marker.seconds)}</span>
                    <strong>{marker.label}</strong>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section style={{ marginBottom: 25 }}>
            <div className="sec-head" style={{ marginBottom: 9 }}>
              <span className="mlab">Transcription</span>
            </div>
            <div className="detail-pair">
              <span>Model</span>
              <strong>{modelName}</strong>
            </div>
            <div className="detail-pair">
              <span>Status</span>
              <strong data-tone={sttStatus === 'error' ? 'danger' : 'positive'}>{transcriptState}</strong>
            </div>
            {!processing && (
              <div className="detail-pair">
                <span>Pace</span>
                <strong data-tone={transcript.pace === 'delayed' ? 'danger' : 'positive'}>
                  {transcriptPaceCopy(transcript).label}
                </strong>
              </div>
            )}
          </section>
          <section>
            <div className="sec-head" style={{ marginBottom: 9 }}>
              <span className="mlab">Privacy</span>
            </div>
            <p className="leaf-body">Audio, transcript, and model processing stay on this Mac.</p>
          </section>
        </div>
      </aside>
    </main>
  )
})
