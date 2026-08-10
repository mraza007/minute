import { fireEvent, render, screen } from '@testing-library/react'
import { RecordingPreflight, type RecordingPreflightProps } from './RecordingPreflight'

vi.mock('../ipc/commands', () => ({
  startAudioInputPreview: vi.fn(() => Promise.resolve()),
  stopAudioInputPreview: vi.fn(() => Promise.resolve()),
}))

vi.mock('../ipc/events', () => ({
  onAudioInputLevel: vi.fn(() => Promise.resolve(() => {})),
}))

const base: RecordingPreflightProps = {
  microphoneDevices: [
    { id: 'built-in', name: 'MacBook Pro Microphone', isDefault: true },
    { id: 'studio', name: 'Studio Display Microphone', isDefault: false },
  ],
  selectedMicrophoneId: 'built-in',
  microphoneLoading: false,
  microphonePermission: 'authorized',
  requestingMicrophonePermission: false,
  modelName: 'Whisper small',
  systemAudioEnabled: false,
  sysAudioAvailability: 'ready',
  starting: false,
  onSelectMicrophone: vi.fn(),
  onRequestMicrophonePermission: vi.fn(),
  onToggleSystemAudio: vi.fn(),
  onRequestSysAudioPermission: vi.fn(),
  onClose: vi.fn(),
  onStart: vi.fn(),
}

describe('RecordingPreflight', () => {
  it('shows the real default microphone, source lock, privacy, and friendly transcription mode', () => {
    render(<RecordingPreflight {...base} />)
    expect(screen.getByRole('dialog', { name: 'Ready to record' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue('built-in')
    expect(screen.getByText('macOS default input')).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Microphone input level' })).toBeInTheDocument()
    expect(screen.getByText('Sources are fixed after recording starts.')).toBeInTheDocument()
    expect(screen.getByText('Audio never leaves this Mac.')).toBeInTheDocument()
    expect(screen.getByText('Fast')).toBeInTheDocument()
    expect(screen.getByText('Whisper small · runs on this Mac')).toBeInTheDocument()
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
    expect(screen.getByText('Apps and call audio will be included.')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Grant permission…' }))
    expect(onRequestSysAudioPermission).toHaveBeenCalledTimes(1)
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

  it('maps installed Whisper tiers to human-readable modes', () => {
    const { rerender } = render(<RecordingPreflight {...base} modelName="Whisper small" />)
    expect(screen.getByText('Fast')).toBeInTheDocument()

    rerender(<RecordingPreflight {...base} modelName="Whisper medium" />)
    expect(screen.getByText('Balanced')).toBeInTheDocument()

    rerender(<RecordingPreflight {...base} modelName="Whisper large-v3 turbo" />)
    expect(screen.getByText('Most accurate')).toBeInTheDocument()
  })
})
