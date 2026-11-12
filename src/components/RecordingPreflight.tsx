import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { AudioInputDevice, MicrophonePermission, SysAudioAvailability } from '../ipc/types'
import { InputLevelMeter } from './InputLevelMeter'
import { Toggle } from './Toggle'
import type { TranscriptionModeOption } from './transcriptionModes'

export interface RecordingPreflightProps {
  microphoneDevices: AudioInputDevice[]
  selectedMicrophoneId: string | null
  microphoneLoading: boolean
  microphonePermission: MicrophonePermission
  requestingMicrophonePermission: boolean
  /** Fast, Balanced, and Most accurate, each with the model behind it. */
  transcriptionModes: TranscriptionModeOption[]
  systemAudioEnabled: boolean
  sysAudioAvailability: SysAudioAvailability
  starting: boolean
  onSelectMicrophone: (id: string) => void
  onRequestMicrophonePermission: () => void
  onSelectTranscriptionModel: (modelId: string) => void
  onToggleSystemAudio: () => void
  onRequestSysAudioPermission: () => void
  /** Leaves the sheet for Settings, where models are downloaded. */
  onOpenSettings: () => void
  onClose: () => void
  onStart: (title: string | null) => void
}

function systemAudioCopy(availability: SysAudioAvailability): string {
  if (availability === 'unsupported') return 'Requires macOS 13 or later.'
  if (availability === 'notGranted') return 'Needs Screen Recording permission to record calls and app audio.'
  return 'Records the other people on the call.'
}

/** Why the microphone cannot record yet: a short state and what to do about it. */
function microphoneProblem(permission: MicrophonePermission): { state: string; detail: string } {
  switch (permission) {
    case 'notDetermined':
      return { state: 'Permission needed', detail: 'Minute needs microphone access before it can record.' }
    case 'denied':
      return {
        state: 'Blocked',
        detail: 'Microphone access is off. Enable Minute in System Settings → Privacy & Security → Microphone.',
      }
    case 'restricted':
      return { state: 'Blocked', detail: 'Microphone access is restricted by macOS settings.' }
    case 'unknown':
      return { state: 'Unavailable', detail: 'Minute could not determine the macOS microphone permission state.' }
    case 'authorized':
      return { state: 'Unavailable', detail: 'Connect or enable an input device to continue.' }
  }
}

export function RecordingPreflight({
  microphoneDevices,
  selectedMicrophoneId,
  microphoneLoading,
  microphonePermission,
  requestingMicrophonePermission,
  transcriptionModes,
  systemAudioEnabled,
  sysAudioAvailability,
  starting,
  onSelectMicrophone,
  onRequestMicrophonePermission,
  onSelectTranscriptionModel,
  onToggleSystemAudio,
  onRequestSysAudioPermission,
  onOpenSettings,
  onClose,
  onStart,
}: RecordingPreflightProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState('')
  const selectedMicrophone = microphoneDevices.find(device => device.id === selectedMicrophoneId) ?? null
  const microphoneAuthorized = microphonePermission === 'authorized'
  const microphoneReady = !microphoneLoading && microphoneAuthorized && selectedMicrophone !== null
  const problem = microphoneLoading || microphoneReady ? null : microphoneProblem(microphonePermission)
  const systemAudioReady = sysAudioAvailability === 'ready'
  const systemAudioIncluded = systemAudioReady && systemAudioEnabled
  const selectedMode = transcriptionModes.find(option => option.selected) ?? null
  const selectableModes = transcriptionModes.filter(option => option.installed && option.modelId !== null)
  const missingModel = transcriptionModes.some(option => !option.installed)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  function start() {
    onStart(title.trim() || null)
  }

  function handleTitleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || !microphoneReady || starting) return
    e.preventDefault()
    start()
  }

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
    // The sheet itself holds focus when it opens, before the first control.
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  function handleModeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const current = selectableModes.findIndex(option => option.selected)
    if (selectableModes.length === 0) return
    e.preventDefault()
    const step = e.key === 'ArrowRight' ? 1 : -1
    const next = selectableModes[(current + step + selectableModes.length) % selectableModes.length]
    if (next.modelId) onSelectTranscriptionModel(next.modelId)
    e.currentTarget.querySelector<HTMLElement>(`[data-mode="${next.mode}"]`)?.focus()
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
          <h2 id="recording-preflight-title">New recording</h2>
          <p>Sources cannot change after you start.</p>
        </div>

        <section className="preflight-section">
          <div className="preflight-row">
            <label className="preflight-label" htmlFor="preflight-title">Title</label>
            <input
              id="preflight-title"
              type="text"
              className="preflight-title-input"
              value={title}
              maxLength={120}
              placeholder="Optional, e.g. Weekly design sync"
              disabled={starting}
              onChange={event => setTitle(event.target.value)}
              onKeyDown={handleTitleKeyDown}
            />
          </div>
        </section>

        <section className="preflight-section" aria-labelledby="preflight-microphone-label">
          <div className="preflight-row">
            <label className="preflight-label" id="preflight-microphone-label" htmlFor="preflight-microphone">Microphone</label>
            {microphoneLoading ? (
              <span className="preflight-value">Checking microphones…</span>
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
                      {device.name}{device.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <span className="preflight-value">No microphone available</span>
            )}
          </div>
          {microphoneAuthorized && (
            // The slot keeps the meter's height while devices re-check, so
            // Start does not move in the instant it becomes clickable (issue #23).
            <div className="input-level-slot">
              {microphoneReady && <InputLevelMeter deviceId={selectedMicrophoneId} active={!starting} />}
            </div>
          )}
          {problem && (
            <p className="preflight-note" data-tone="danger">
              <strong>{problem.state}</strong> {problem.detail}
            </p>
          )}
          {microphonePermission === 'notDetermined' && (
            <button
              type="button"
              className="message-action"
              onClick={onRequestMicrophonePermission}
              disabled={starting || requestingMicrophonePermission}
            >
              {requestingMicrophonePermission ? 'Waiting for macOS…' : 'Allow microphone…'}
            </button>
          )}
        </section>

        <section className="preflight-section">
          <div className="preflight-row">
            <div className="preflight-copy">
              <div className="preflight-label" aria-hidden="true">Include system audio</div>
              <p className="preflight-note">{systemAudioCopy(sysAudioAvailability)}</p>
            </div>
            <div className="preflight-switch">
              <Toggle
                on={systemAudioIncluded}
                onToggle={onToggleSystemAudio}
                label="Include system audio"
                disabled={!systemAudioReady || starting}
              />
            </div>
          </div>
          {sysAudioAvailability === 'notGranted' && (
            <button type="button" className="message-action" onClick={onRequestSysAudioPermission}>
              Grant permission…
            </button>
          )}
        </section>

        <section className="preflight-section" aria-labelledby="preflight-transcription-label">
          <div className="preflight-label" id="preflight-transcription-label">Transcription</div>
          <div className="segmented" role="radiogroup" aria-labelledby="preflight-transcription-label" onKeyDown={handleModeKeyDown}>
            {transcriptionModes.map(option => (
              <button
                key={option.mode}
                type="button"
                role="radio"
                data-mode={option.mode}
                aria-checked={option.selected}
                // One tab stop for the group. The arrow keys move within it.
                tabIndex={option.selected || (selectedMode === null && option === selectableModes[0]) ? 0 : -1}
                disabled={!option.installed || option.modelId === null || starting}
                title={
                  option.modelName === null
                    ? 'No model for this mode'
                    : option.installed
                      ? option.modelName
                      : `${option.modelName} is not downloaded`
                }
                onClick={() => option.modelId && onSelectTranscriptionModel(option.modelId)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="preflight-note">
            {selectedMode?.modelName
              ? [selectedMode.modelName, selectedMode.fit].filter(Boolean).join(' · ')
              : 'No transcription model is installed.'}
            {missingModel && (
              <>
                {' '}
                <button type="button" className="message-action" disabled={starting} onClick={onOpenSettings}>
                  Get more models in Settings
                </button>
              </>
            )}
          </p>
        </section>

        <footer className="preflight-actions">
          <div className="preflight-privacy">Audio stays on this Mac.</div>
          <button type="button" className="preflight-btn" onClick={onClose} disabled={starting}>Cancel</button>
          <button type="button" className="preflight-btn" data-variant="primary" onClick={start} disabled={!microphoneReady || starting}>
            <span className="preflight-record-dot" aria-hidden="true" />
            {starting ? 'Starting…' : 'Start recording'}
          </button>
        </footer>
      </div>
    </div>
  )
}
