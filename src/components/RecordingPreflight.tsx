import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { AudioInputDevice, MicrophonePermission, SysAudioAvailability } from '../ipc/types'
import { InputLevelMeter } from './InputLevelMeter'
import { Toggle } from './Toggle'

export interface RecordingPreflightProps {
  microphoneDevices: AudioInputDevice[]
  selectedMicrophoneId: string | null
  microphoneLoading: boolean
  microphonePermission: MicrophonePermission
  requestingMicrophonePermission: boolean
  modelName: string
  systemAudioEnabled: boolean
  sysAudioAvailability: SysAudioAvailability
  starting: boolean
  onSelectMicrophone: (id: string) => void
  onRequestMicrophonePermission: () => void
  onToggleSystemAudio: () => void
  onRequestSysAudioPermission: () => void
  onClose: () => void
  onStart: () => void
}

function MicrophoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
    </svg>
  )
}

function SystemAudioIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

function TranscriptionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M4 12h2M9 7v10M14 4v16M19 9v6" />
    </svg>
  )
}

function recordingModeLabel(modelName: string): string {
  const normalized = modelName.toLowerCase()
  if (normalized.includes('small')) return 'Fast'
  if (normalized.includes('medium')) return 'Balanced'
  return 'Most accurate'
}

function systemAudioCopy(availability: SysAudioAvailability, enabled: boolean): string {
  if (availability === 'unsupported') return 'Requires macOS 13 or later.'
  if (availability === 'notGranted') return 'Screen Recording permission is required to capture calls and app audio.'
  return enabled ? 'Apps and call audio will be included.' : 'Microphone only for this recording.'
}

function microphonePermissionCopy(permission: MicrophonePermission): string | null {
  if (permission === 'notDetermined') return 'Minute needs microphone access before it can record.'
  if (permission === 'denied') {
    return 'Microphone access is off. Enable Minute in System Settings → Privacy & Security → Microphone.'
  }
  if (permission === 'restricted') return 'Microphone access is restricted by macOS settings.'
  if (permission === 'unknown') return 'Minute could not determine the macOS microphone permission state.'
  return null
}

export function RecordingPreflight({
  microphoneDevices,
  selectedMicrophoneId,
  microphoneLoading,
  microphonePermission,
  requestingMicrophonePermission,
  modelName,
  systemAudioEnabled,
  sysAudioAvailability,
  starting,
  onSelectMicrophone,
  onRequestMicrophonePermission,
  onToggleSystemAudio,
  onRequestSysAudioPermission,
  onClose,
  onStart,
}: RecordingPreflightProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const selectedMicrophone = microphoneDevices.find(device => device.id === selectedMicrophoneId) ?? null
  const microphoneAuthorized = microphonePermission === 'authorized'
  const microphoneReady = !microphoneLoading && microphoneAuthorized && selectedMicrophone !== null
  const microphonePermissionMessage = microphonePermissionCopy(microphonePermission)
  const microphoneState = microphoneLoading
    ? 'Checking'
    : microphoneReady
      ? 'Ready'
      : microphonePermission === 'notDetermined'
        ? 'Permission needed'
        : microphonePermission === 'denied' || microphonePermission === 'restricted'
          ? 'Blocked'
          : 'Unavailable'
  const systemAudioIncluded = sysAudioAvailability === 'ready' && systemAudioEnabled

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  function handleOverlayMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (!starting && e.target === e.currentTarget) onClose()
  }

  function handlePanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && !starting) {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled])') ?? [],
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="preflight-overlay" onMouseDown={handleOverlayMouseDown}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-preflight-title"
        className="preflight-sheet"
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
      >
        <div className="preflight-head">
          <div className="mlab">New recording</div>
          <h2 id="recording-preflight-title">Ready to record</h2>
          <p>Check what Minute will capture before the session begins.</p>
        </div>

        <div className="preflight-sources">
          <section className="preflight-row" aria-labelledby="preflight-microphone-label">
            <div className="preflight-icon"><MicrophoneIcon /></div>
            <div className="preflight-row-copy">
              <label className="preflight-label" id="preflight-microphone-label" htmlFor="preflight-microphone">Microphone</label>
              {microphoneLoading ? (
                <strong>Checking microphones…</strong>
              ) : microphoneDevices.length > 0 ? (
                <div className="preflight-select-wrap">
                  <select
                    id="preflight-microphone"
                    aria-label="Microphone"
                    value={selectedMicrophoneId ?? ''}
                    disabled={starting || !microphoneAuthorized}
                    onChange={event => onSelectMicrophone(event.target.value)}
                  >
                    {microphoneDevices.map(device => (
                      <option key={device.id} value={device.id}>
                        {device.name}{device.isDefault ? ' — Default' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <strong>No microphone available</strong>
              )}
              <span>
                {microphonePermissionMessage ??
                  (microphoneReady
                    ? selectedMicrophone.isDefault
                      ? 'macOS default input'
                      : 'Selected for this recording'
                    : 'Connect or enable an input device to continue.')}
              </span>
              {microphonePermission === 'notDetermined' && (
                <button
                  type="button"
                  className="preflight-permission"
                  onClick={onRequestMicrophonePermission}
                  disabled={starting || requestingMicrophonePermission}
                >
                  {requestingMicrophonePermission ? 'Waiting for macOS…' : 'Allow microphone…'}
                </button>
              )}
              {microphoneAuthorized && (
                // The slot keeps the meter's height reserved while devices
                // re-check, so the Start button below does not move in the
                // same instant it becomes clickable (issue #23).
                <div className="input-level-slot">
                  {microphoneReady && (
                    <InputLevelMeter
                      deviceId={selectedMicrophoneId}
                      active={!starting}
                    />
                  )}
                </div>
              )}
            </div>
            <div className="preflight-state" data-tone={microphoneReady ? 'positive' : microphoneLoading ? 'neutral' : 'danger'}>
              <span aria-hidden="true" />
              {microphoneState}
            </div>
          </section>

          <section className="preflight-row" aria-labelledby="preflight-system-audio-label">
            <div className="preflight-icon"><SystemAudioIcon /></div>
            <div className="preflight-row-copy">
              <div className="preflight-label" id="preflight-system-audio-label">System audio</div>
              <Toggle
                on={systemAudioIncluded}
                onToggle={onToggleSystemAudio}
                label="Include system audio"
                disabled={sysAudioAvailability !== 'ready' || starting}
              />
              <span>{systemAudioCopy(sysAudioAvailability, systemAudioIncluded)}</span>
              {sysAudioAvailability === 'notGranted' && (
                <button type="button" className="preflight-permission" onClick={onRequestSysAudioPermission}>
                  Grant permission…
                </button>
              )}
            </div>
          </section>

          <section className="preflight-row" aria-labelledby="preflight-transcription-label">
            <div className="preflight-icon"><TranscriptionIcon /></div>
            <div className="preflight-row-copy">
              <div className="preflight-label" id="preflight-transcription-label">Transcription</div>
              <strong>{recordingModeLabel(modelName)}</strong>
              <span>{modelName} · runs on this Mac</span>
            </div>
          </section>
        </div>

        <div className="preflight-fixed-note">
          <span aria-hidden="true">ⓘ</span>
          Sources are fixed after recording starts.
        </div>

        <footer className="preflight-actions">
          <div className="preflight-privacy">Audio never leaves this Mac.</div>
          <button type="button" className="btn-outline" onClick={onClose} disabled={starting}>Cancel</button>
          <button type="button" className="btn-solid" onClick={onStart} disabled={!microphoneReady || starting}>
            <span className="preflight-record-dot" aria-hidden="true" />
            {starting ? 'Starting…' : 'Start recording'}
          </button>
        </footer>
      </div>
    </div>
  )
}
