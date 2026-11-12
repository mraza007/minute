import { fireEvent, render, screen } from '@testing-library/react'
import { RecordingPreflight, type RecordingPreflightProps } from './RecordingPreflight'
import type { TranscriptionModeOption } from './transcriptionModes'

vi.mock('../ipc/commands', () => ({
  startAudioInputPreview: vi.fn(() => Promise.resolve()),
  stopAudioInputPreview: vi.fn(() => Promise.resolve()),
}))

vi.mock('../ipc/events', () => ({
  onAudioInputLevel: vi.fn(() => Promise.resolve(() => {})),
}))

const modes: TranscriptionModeOption[] = [
  { mode: 'fast', label: 'Fast', modelId: 'whisper-small', modelName: 'Whisper small', installed: true, selected: true, fit: 'recommended for this Mac' },
  { mode: 'balanced', label: 'Balanced', modelId: 'whisper-medium', modelName: 'Whisper medium', installed: true, selected: false, fit: 'good fit for this Mac' },
  { mode: 'accurate', label: 'Most accurate', modelId: 'whisper-large-v3-turbo', modelName: 'Whisper large-v3-turbo', installed: false, selected: false, fit: null },
]

const base: RecordingPreflightProps = {
  microphoneDevices: [
    { id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true },
    { id: 'studio', name: 'Studio Display Microphone', isDefault: false },
  ],
  selectedMicrophoneId: 'built-in',
  microphoneLoading: false,
  microphonePermission: 'authorized',
  requestingMicrophonePermission: false,
  transcriptionModes: modes,
  systemAudioEnabled: false,
  sysAudioAvailability: 'ready',
  starting: false,
  onSelectMicrophone: vi.fn(),
  onRequestMicrophonePermission: vi.fn(),
  onSelectTranscriptionModel: vi.fn(),
  onOpenSettings: vi.fn(),
  onToggleSystemAudio: vi.fn(),
  onRequestSysAudioPermission: vi.fn(),
  onClose: vi.fn(),
  onStart: vi.fn(),
}

describe('RecordingPreflight', () => {
  it('shows the real default microphone, source lock, privacy, and the transcription mode in use', () => {
    render(<RecordingPreflight {...base} />)
    expect(screen.getByRole('dialog', { name: 'New recording' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('built-in')
    expect(screen.getByRole('option', { name: 'MacBook Pro Microphone (default)' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Microphone input level' })).toBeInTheDocument()
    expect(screen.getByText('Sources cannot change after you start.')).toBeInTheDocument()
    expect(screen.getByText('Audio stays on this Mac.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked()
    expect(screen.getByText(/Whisper small · recommended for this Mac/)).toBeInTheDocument()
  })

  it('starts only when a microphone is available', () => {
    const onStart = vi.fn()
    const { rerender } = render(
      <RecordingPreflight
        {...base}
        onStart={onStart}
        microphoneDevices={[]}
        selectedMicrophoneId={null}
      />,
    )
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
    expect(screen.getByText('No microphone available')).toBeInTheDocument()

    rerender(<RecordingPreflight {...base} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('starts with the typed title, from the button or Enter', () => {
    const onStart = vi.fn()
    render(<RecordingPreflight {...base} onStart={onStart} />)
    const field = screen.getByRole('textbox', { name: 'Title' })
    fireEvent.change(field, { target: { value: 'Weekly design sync' } })

    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenLastCalledWith('Weekly design sync')

    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onStart).toHaveBeenCalledTimes(2)
    expect(onStart).toHaveBeenLastCalledWith('Weekly design sync')
  })

  it('trims the typed title', () => {
    const onStart = vi.fn()
    render(<RecordingPreflight {...base} onStart={onStart} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '  Weekly design sync ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenCalledWith('Weekly design sync')
  })

  it('passes no title when the field is blank or only spaces', () => {
    const onStart = vi.fn()
    render(<RecordingPreflight {...base} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenLastCalledWith(null)

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }))
    expect(onStart).toHaveBeenLastCalledWith(null)
  })

  it('does not start on Enter while the microphone is not ready, starting, or composing', () => {
    const onStart = vi.fn()
    const { rerender } = render(
      <RecordingPreflight {...base} onStart={onStart} microphoneDevices={[]} selectedMicrophoneId={null} />,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' })
    expect(onStart).not.toHaveBeenCalled()

    rerender(<RecordingPreflight {...base} onStart={onStart} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter', isComposing: true })
    expect(onStart).not.toHaveBeenCalled()

    rerender(<RecordingPreflight {...base} onStart={onStart} starting={true} />)
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled()
  })

  it('keeps the meter space reserved while devices re-check so Start does not move', () => {
    const { container, rerender } = render(<RecordingPreflight {...base} />)
    const readySlot = container.querySelector('.input-level-slot')
    expect(readySlot).not.toBeNull()
    expect(readySlot!.querySelector('[role="meter"]')).not.toBeNull()

    rerender(<RecordingPreflight {...base} microphoneLoading={true} />)
    const loadingSlot = container.querySelector('.input-level-slot')
    expect(loadingSlot).not.toBeNull()
    expect(loadingSlot!.querySelector('[role="meter"]')).toBeNull()

    rerender(<RecordingPreflight {...base} microphonePermission="notDetermined" />)
    expect(container.querySelector('.input-level-slot')).toBeNull()
  })

  it('asks for microphone access explicitly before enabling recording', () => {
    const onRequestMicrophonePermission = vi.fn()
    render(
      <RecordingPreflight
        {...base}
        microphonePermission="notDetermined"
        onRequestMicrophonePermission={onRequestMicrophonePermission}
      />,
    )

    expect(screen.getByText('Permission needed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
    expect(screen.queryByRole('meter', { name: 'Microphone input level' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow microphone…' }))
    expect(onRequestMicrophonePermission).toHaveBeenCalledTimes(1)
  })

  it('explains a denied microphone permission and keeps recording blocked', () => {
    render(<RecordingPreflight {...base} microphonePermission="denied" />)

    expect(screen.getByText('Blocked')).toBeInTheDocument()
    expect(
      screen.getByText('Microphone access is off. Enable Minute in System Settings → Privacy & Security → Microphone.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  })

  it('lets the user choose which connected microphone capture opens', () => {
    const onSelectMicrophone = vi.fn()
    render(<RecordingPreflight {...base} onSelectMicrophone={onSelectMicrophone} />)

    fireEvent.change(screen.getByRole('combobox', { name: 'Microphone' }), {
      target: { value: 'studio' },
    })

    expect(onSelectMicrophone).toHaveBeenCalledWith('studio')
  })

  it('shows system audio as an explicit, working choice', () => {
    const onToggleSystemAudio = vi.fn()
    render(<RecordingPreflight {...base} onToggleSystemAudio={onToggleSystemAudio} systemAudioEnabled={true} />)
    const toggle = screen.getByRole('switch', { name: 'Include system audio' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Records the other people on the call.')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(onToggleSystemAudio).toHaveBeenCalledTimes(1)
  })

  it('offers the real permission action when system audio is not granted', () => {
    const onRequestSysAudioPermission = vi.fn()
    render(
      <RecordingPreflight
        {...base}
        sysAudioAvailability="notGranted"
        onRequestSysAudioPermission={onRequestSysAudioPermission}
      />,
    )
    expect(screen.getByRole('switch', { name: 'Include system audio' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Needs Screen Recording permission to record calls and app audio.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Grant permission…' }))
    expect(onRequestSysAudioPermission).toHaveBeenCalledTimes(1)
  })

  // The sheet itself holds focus when it opens. Shift+Tab from there used
  // to leave the dialog for the page behind it.
  it('keeps Tab and Shift+Tab inside the sheet, from the sheet itself too', () => {
    render(<RecordingPreflight {...base} />)
    const sheet = screen.getByRole('dialog')
    const first = screen.getByRole('textbox', { name: 'Title' })
    const last = screen.getByRole('button', { name: 'Start recording' })
    expect(sheet).toHaveFocus()

    expect(fireEvent.keyDown(sheet, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(last).toHaveFocus()

    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false)
    expect(first).toHaveFocus()

    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(last).toHaveFocus()
  })

  it('closes with Escape or Cancel while idle but not while starting', () => {
    const onClose = vi.fn()
    const { rerender } = render(<RecordingPreflight {...base} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)

    rerender(<RecordingPreflight {...base} onClose={onClose} starting={true} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })

  it('says when this Mac is too old to capture system audio', () => {
    render(<RecordingPreflight {...base} sysAudioAvailability="unsupported" />)
    expect(screen.getByRole('switch', { name: 'Include system audio' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Requires macOS 13 or later.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Grant permission…' })).not.toBeInTheDocument()
  })

  describe('transcription mode', () => {
    it('switches to the model behind an installed mode', () => {
      const onSelectTranscriptionModel = vi.fn()
      render(<RecordingPreflight {...base} onSelectTranscriptionModel={onSelectTranscriptionModel} />)
      fireEvent.click(screen.getByRole('radio', { name: 'Balanced' }))
      expect(onSelectTranscriptionModel).toHaveBeenCalledWith('whisper-medium')
    })

    it('moves between installed modes with the arrow keys, skipping one that is not downloaded', () => {
      const onSelectTranscriptionModel = vi.fn()
      render(<RecordingPreflight {...base} onSelectTranscriptionModel={onSelectTranscriptionModel} />)
      const group = screen.getByRole('radiogroup', { name: 'Transcription' })
      fireEvent.keyDown(group, { key: 'ArrowLeft' })
      expect(onSelectTranscriptionModel).toHaveBeenLastCalledWith('whisper-medium')
      fireEvent.keyDown(group, { key: 'ArrowRight' })
      expect(onSelectTranscriptionModel).toHaveBeenLastCalledWith('whisper-medium')
    })

    it('disables a mode whose model is not downloaded and points to Settings', () => {
      const onSelectTranscriptionModel = vi.fn()
      const onOpenSettings = vi.fn()
      render(
        <RecordingPreflight
          {...base}
          onSelectTranscriptionModel={onSelectTranscriptionModel}
          onOpenSettings={onOpenSettings}
        />,
      )
      const accurate = screen.getByRole('radio', { name: 'Most accurate' })
      expect(accurate).toBeDisabled()
      expect(accurate).toHaveAttribute('title', 'Whisper large-v3-turbo is not downloaded')
      fireEvent.click(accurate)
      expect(onSelectTranscriptionModel).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Get more models in Settings' }))
      expect(onOpenSettings).toHaveBeenCalledTimes(1)
    })

    it('does not point to Settings once every mode is downloaded', () => {
      render(<RecordingPreflight {...base} transcriptionModes={modes.map(option => ({ ...option, installed: true }))} />)
      expect(screen.queryByRole('button', { name: 'Get more models in Settings' })).not.toBeInTheDocument()
    })

    it('names the model and fit of whichever mode is in use', () => {
      render(
        <RecordingPreflight
          {...base}
          transcriptionModes={modes.map(option => ({ ...option, selected: option.mode === 'balanced' }))}
        />,
      )
      expect(screen.getByRole('radio', { name: 'Balanced' })).toBeChecked()
      expect(screen.getByRole('radio', { name: 'Fast' })).not.toBeChecked()
      expect(screen.getByText(/Whisper medium · good fit for this Mac/)).toBeInTheDocument()
    })
  })
})
