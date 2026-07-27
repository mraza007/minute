import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { LiveTranscriptGroup } from '../state/adapters'
import { formatMmSs } from '../state/adapters'
import type { SttStatus } from '../types'
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
        <div key={`${group.speaker}-${group.start}`} className="script-line">
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
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
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
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 14px',
            border: '1px solid var(--rule-strong)',
            borderRadius: 999,
            background: 'var(--card)',
            color: 'var(--ink)',
            fontFamily: 'inherit',
            fontSize: 11.5,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,.12)',
          }}
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

/** Audio-source indicator. Reads as a pair of underlined captions rather
 *  than a segmented control, because it isn't one: the source is fixed for
 *  the life of a recording (see `systemAudioActive`'s docs), so anything
 *  that looks pressable here is lying about what it does. */
function SourceTab({ on, disabled, title, icon, label }: { on: boolean; disabled?: boolean; title?: string; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        border: 'none',
        background: 'transparent',
        padding: '6px 0',
        borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
        fontFamily: 'var(--sans)',
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '.11em',
        textTransform: 'uppercase',
        color: on ? 'var(--ink)' : 'var(--ink-faint)',
        cursor: 'default',
      }}
    >
      {icon}
      {label}
    </button>
  )
}

export const RecordingView = memo(function RecordingView({
  liveSegments,
  paused,
  togglePause,
  stopRec,
  stopping,
  sttStatus,
  sttError,
  modelName,
  systemAudioActive,
}: RecordingViewProps) {
  return (
    <main style={{ flex: 1, display: 'flex', minHeight: 0, background: 'var(--panel)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
        <div
          style={{
            height: 56,
            flex: 'none',
            padding: '0 34px',
            borderBottom: '1px solid var(--rule)',
            display: 'flex',
            alignItems: 'center',
            gap: 26,
          }}
        >
          <div role="radiogroup" aria-label="Audio source" style={{ display: 'flex', gap: 22, flex: 'none' }}>
            <SourceTab
              on
              label="Microphone"
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                </svg>
              }
            />
            <SourceTab
              on={systemAudioActive}
              disabled
              label="System audio"
              title={
                systemAudioActive
                  ? 'Recording system audio — the other side of the call. The source can’t change mid-recording.'
                  : 'System audio isn’t part of this recording. Turn it on for the next one in Settings.'
              }
              icon={
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect width="20" height="14" x="2" y="3" rx="2"></rect>
                  <line x1="8" x2="16" y1="21" y2="21"></line>
                  <line x1="12" x2="12" y1="17" y2="21"></line>
                </svg>
              }
            />
          </div>
          <Waveform paused={paused} />
          <div className="mlab" style={{ flex: 'none' }}>{modelName} · on-device</div>
        </div>

        <LiveTranscriptScroller liveSegments={liveSegments} sttStatus={sttStatus} sttError={sttError} modelName={modelName} />

        {/* Flush control strip, continuous with the player bar on the notes
            side — same height, same rule, same chrome fill, so switching
            between the two views doesn't shift the bottom edge. */}
        <div
          style={{
            height: 62,
            flex: 'none',
            padding: '0 34px',
            borderTop: '1px solid var(--rule)',
            background: 'var(--panel-warm)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <button onClick={stopRec} disabled={stopping} className="btn-solid">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect width="12" height="12" x="6" y="6"></rect>
            </svg>
            {stopping ? 'Finishing…' : 'Stop & transcribe'}
          </button>
          <button onClick={togglePause} disabled={stopping} className="btn-outline">
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button disabled aria-disabled="true" title="Markers arrive in a later update." className="btn-quiet">
            Add marker
          </button>
        </div>
      </div>

      <div
        style={{
          width: 316,
          flex: 'none',
          borderLeft: '1px solid var(--rule)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--panel)',
        }}
      >
        <div style={{ padding: '24px 26px 20px' }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--serif)', fontWeight: 400, fontSize: 17, letterSpacing: '-.005em' }}>
            Live insights
          </h2>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 26px 24px' }}>
          <section style={{ marginBottom: 22 }}>
            <div className="sec-head" style={{ marginBottom: 9 }}>
              <span className="mlab">Not yet</span>
            </div>
            <div className="placeholder-block">Live insights arrive in a later update.</div>
          </section>
          <section>
            <div className="sec-head" style={{ marginBottom: 9 }}>
              <span className="mlab">Privacy</span>
            </div>
            <p className="leaf-body">Transcription runs on-device — nothing leaves this machine.</p>
          </section>
        </div>
      </div>
    </main>
  )
})
