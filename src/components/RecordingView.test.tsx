import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RecordingOrigin } from '../ipc/types'
import type { LiveTranscriptGroup } from '../state/adapters'
import { RecordingView } from './RecordingView'

const base = {
  quietSecs: 0,
  liveSegments: [] as LiveTranscriptGroup[],
  paused: false,
  togglePause: vi.fn(),
  stopRec: vi.fn(),
  stopping: false,
  processingStage: 'idle' as const,
  sttStatus: 'ready' as const,
  sttError: null as string | null,
  modelName: 'Whisper small',
  systemAudioActive: false,
  microphoneName: 'MacBook Pro Microphone',
  captureHealth: 'healthy' as const,
  elapsed: 0,
  title: 'New recording',
  renameTitle: vi.fn(() => Promise.resolve()),
  markers: [],
  addMarker: vi.fn(() => Promise.resolve()),
  processingFailure: null,
  onRetryProcessing: vi.fn(),
  onDismissProcessingFailure: vi.fn(),
  autoStopSeconds: null,
  onKeepRecording: vi.fn(),
  canRestartWithSystemAudio: false,
  onRestartWithSystemAudio: vi.fn(),
  origin: { kind: 'manual' } as RecordingOrigin,
  onOpenSettings: vi.fn(),
  speakersExpected: false,
  summaryExpected: true,
  summaryStyle: 'detailed' as const,
}

describe('RecordingView', () => {
  it('stops the recording from the red Stop button', () => {
    const stopRec = vi.fn()
    render(<RecordingView {...base} stopRec={stopRec} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop and summarize' }))
    expect(stopRec).toHaveBeenCalledTimes(1)
  })

  it('does not promise a summary when none will be written', () => {
    render(<RecordingView {...base} summaryExpected={false} />)
    expect(screen.getByRole('button', { name: 'Stop and transcribe' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop and summarize' })).not.toBeInTheDocument()
  })

  it('shows "Pause" when not paused and calls togglePause when clicked', () => {
    const togglePause = vi.fn()
    render(<RecordingView {...base} paused={false} togglePause={togglePause} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(togglePause).toHaveBeenCalledTimes(1)
  })

  it('shows "Resume" and a paused health line when paused', () => {
    render(<RecordingView {...base} paused={true} captureHealth="paused" />)
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Recording health updates' })).toHaveTextContent('Paused')
  })

  it('sends "Change" on the automatic-start notice to the Recording settings', () => {
    const onOpenSettings = vi.fn()
    render(<RecordingView {...base} origin={{ kind: 'automatic', appName: 'Zoom' }} onOpenSettings={onOpenSettings} />)
    expect(screen.getByText('Started automatically when Zoom began a call.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(onOpenSettings).toHaveBeenCalledWith('recording')
  })

  describe('sources line', () => {
    it('names the microphone the backend opened, the mode, and the model', () => {
      render(<RecordingView {...base} microphoneName="Studio Display Microphone" modelName="Whisper medium" />)
      expect(
        screen.getByText('Studio Display Microphone only · Balanced transcription · Whisper medium'),
      ).toBeInTheDocument()
    })

    it('says when system audio is part of the recording', () => {
      render(<RecordingView {...base} systemAudioActive={true} />)
      expect(
        screen.getByText('MacBook Pro Microphone + system audio · Fast transcription · Whisper small'),
      ).toBeInTheDocument()
    })
  })

  describe('status message', () => {
    function shownMessages(container: HTMLElement) {
      return container.querySelectorAll('.recording-message')
    }

    it('shows none on a healthy recording', () => {
      const { container } = render(
        <RecordingView
          {...base}
          systemAudioActive={true}
          liveSegments={[{ speaker: 'You', start: 0, end: 9, text: 'Hello' }]}
          elapsed={10}
        />,
      )
      expect(shownMessages(container)).toHaveLength(0)
      expect(screen.getByRole('status', { name: 'Recording status' })).toBeEmptyDOMElement()
      expect(screen.getByRole('status', { name: 'Recording health updates' })).toHaveTextContent(
        'Audio and transcript are healthy',
      )
    })

    // Issue #42: the auto-stop arm window is visible instead of a silent
    // 2-minute mystery.
    it('shows the quiet run once it passes 30 seconds', () => {
      render(<RecordingView {...base} quietSecs={84} />)
      expect(screen.getByText('Quiet for 1:24')).toBeInTheDocument()
      expect(screen.getByText('Minute offers to stop after 2 quiet minutes.')).toBeInTheDocument()
    })

    it('says nothing about quiet below 30 seconds', () => {
      render(<RecordingView {...base} quietSecs={20} />)
      expect(screen.queryByText(/Quiet for/)).not.toBeInTheDocument()
    })

    it('names the microphone to check when it goes silent', () => {
      const { container } = render(<RecordingView {...base} captureHealth="silent" />)
      expect(container.querySelector('.recording-message strong')).toHaveTextContent('No sound from the microphone')
      expect(screen.getByText('Check that MacBook Pro Microphone is not muted.')).toBeInTheDocument()
    })

    // Issue #9.
    it('shows the auto-stop countdown and keeps recording on request', () => {
      const onKeepRecording = vi.fn()
      render(<RecordingView {...base} quietSecs={120} autoStopSeconds={108} onKeepRecording={onKeepRecording} />)
      expect(screen.getByText('Quiet for 2:00. Minute stops in 1:48.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Keep recording' }))
      expect(onKeepRecording).toHaveBeenCalledTimes(1)
    })

    it('offers Stop and save when the microphone stops responding', () => {
      const stopRec = vi.fn()
      render(<RecordingView {...base} captureHealth="disconnected" microphoneName="AirPods Pro" stopRec={stopRec} />)
      expect(screen.getByText('AirPods Pro stopped responding')).toBeInTheDocument()
      expect(screen.getByText('The audio recorded so far is safe. Reconnect the microphone to continue.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }))
      expect(stopRec).toHaveBeenCalledTimes(1)
    })

    it('reports a delayed transcript and says the audio is safe', () => {
      const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 8, text: 'Earlier words' }]
      render(<RecordingView {...base} systemAudioActive={true} liveSegments={liveSegments} elapsed={42} />)
      expect(screen.getByText('The transcript is 34 seconds behind')).toBeInTheDocument()
      expect(screen.getByText('Audio is still recording. The transcript catches up when you stop.')).toBeInTheDocument()
    })

    it('reports a failed transcript with its reason and a way to stop safely', () => {
      const stopRec = vi.fn()
      render(<RecordingView {...base} sttStatus="error" sttError="model not installed" stopRec={stopRec} />)
      expect(screen.getByText('The live transcript stopped')).toBeInTheDocument()
      expect(screen.getByText('Audio is still recording. model not installed')).toBeInTheDocument()
      expect(screen.queryByText('Listening…')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Stop and save' }))
      expect(stopRec).toHaveBeenCalledTimes(1)
    })

    it('keeps capture available and offers retry after a save failure', () => {
      const onRetryProcessing = vi.fn()
      const onDismissProcessingFailure = vi.fn()
      render(
        <RecordingView
          {...base}
          processingFailure={{ stage: 'saving', message: 'Disk temporarily unavailable.' }}
          onRetryProcessing={onRetryProcessing}
          onDismissProcessingFailure={onDismissProcessingFailure}
        />,
      )
      expect(screen.getByText('The recording is still running. Disk temporarily unavailable.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Stop and summarize' })).toBeEnabled()
      fireEvent.click(screen.getByRole('button', { name: 'Retry finish' }))
      fireEvent.click(screen.getByRole('button', { name: 'Continue recording' }))
      expect(onRetryProcessing).toHaveBeenCalledTimes(1)
      expect(onDismissProcessingFailure).toHaveBeenCalledTimes(1)
    })

    it('shows one message when several conditions hold, and announces it', () => {
      const { container } = render(
        <RecordingView
          {...base}
          canRestartWithSystemAudio={true}
          captureHealth="silent"
          quietSecs={130}
          autoStopSeconds={110}
        />,
      )
      expect(shownMessages(container)).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Keep recording' })).toBeInTheDocument()
      expect(screen.getByRole('status', { name: 'Recording status' })).toHaveTextContent(
        'Quiet for 2:10. Minute stops in 1:50.',
      )
    })
  })

  // Issue #26: sources are fixed at start, so the mid-recording gesture is
  // an explicit stop-and-restart behind a confirm step. Microphone-only is
  // a standing condition, so the offer sits on the sources line.
  describe('add system audio', () => {
    it('offers it on the sources line when system audio is off but available', () => {
      render(<RecordingView {...base} canRestartWithSystemAudio={true} />)
      const sources = screen.getByText(/MacBook Pro Microphone only/)
      expect(within(sources).getByRole('button', { name: 'Add system audio' })).toBeInTheDocument()
      expect(sources).toHaveTextContent('MacBook Pro Microphone only · Add system audio · Fast transcription · Whisper small')
    })

    it('offers nothing when system audio is already part of the recording', () => {
      render(<RecordingView {...base} systemAudioActive={true} canRestartWithSystemAudio={true} />)
      expect(screen.queryByRole('button', { name: 'Add system audio' })).not.toBeInTheDocument()
    })

    it('offers nothing when this Mac cannot capture system audio', () => {
      render(<RecordingView {...base} canRestartWithSystemAudio={false} />)
      expect(screen.queryByRole('button', { name: 'Add system audio' })).not.toBeInTheDocument()
    })

    it('offers nothing once the recording is stopping', () => {
      render(<RecordingView {...base} canRestartWithSystemAudio={true} stopping={true} processingStage="saving" />)
      expect(screen.queryByRole('button', { name: 'Add system audio' })).not.toBeInTheDocument()
    })

    it('requires a confirm step that names the two-notes consequence before restarting', () => {
      const onRestartWithSystemAudio = vi.fn()
      render(<RecordingView {...base} canRestartWithSystemAudio={true} onRestartWithSystemAudio={onRestartWithSystemAudio} />)

      fireEvent.click(screen.getByRole('button', { name: 'Add system audio' }))
      expect(onRestartWithSystemAudio).not.toHaveBeenCalled()
      expect(screen.getByRole('group', { name: 'Confirm restart with system audio' })).toHaveTextContent(/two notes/)
      expect(screen.getByRole('button', { name: 'Save & restart' })).toHaveFocus()

      fireEvent.click(screen.getByRole('button', { name: 'Save & restart' }))
      expect(onRestartWithSystemAudio).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('group', { name: 'Confirm restart with system audio' })).not.toBeInTheDocument()
    })

    it('"Go back" backs out of the confirm step without restarting, and returns focus to the offer', () => {
      const onRestartWithSystemAudio = vi.fn()
      render(<RecordingView {...base} canRestartWithSystemAudio={true} onRestartWithSystemAudio={onRestartWithSystemAudio} />)

      fireEvent.click(screen.getByRole('button', { name: 'Add system audio' }))
      fireEvent.click(screen.getByRole('button', { name: 'Go back' }))

      expect(onRestartWithSystemAudio).not.toHaveBeenCalled()
      expect(screen.queryByRole('group', { name: 'Confirm restart with system audio' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Add system audio' })).toHaveFocus()
    })

    it('keeps the offer and an open confirm step while a status message shows', () => {
      const { rerender } = render(<RecordingView {...base} canRestartWithSystemAudio={true} captureHealth="silent" quietSecs={40} />)
      expect(screen.getByText('Quiet for 0:40')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Add system audio' }))

      rerender(<RecordingView {...base} canRestartWithSystemAudio={true} quietSecs={120} autoStopSeconds={90} />)
      expect(screen.getByRole('button', { name: 'Keep recording' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save & restart' })).toBeInTheDocument()

    })
  })

  it('renders grouped live segments with speaker, mm:ss start time, and merged text', () => {
    const liveSegments: LiveTranscriptGroup[] = [
      { speaker: 'Speaker 1', start: 74, end: 80, text: 'Hello there, how are you' },
      { speaker: 'Speaker 2', start: 80, end: 85, text: 'Doing well, thanks' },
    ]
    render(<RecordingView {...base} liveSegments={liveSegments} />)
    expect(screen.getByText('Speaker 1')).toBeInTheDocument()
    expect(screen.getByText('01:14')).toBeInTheDocument()
    expect(screen.getByText('Hello there, how are you')).toBeInTheDocument()
    expect(screen.getByText('Speaker 2')).toBeInTheDocument()
    expect(screen.getByText('01:20')).toBeInTheDocument()
    expect(screen.getByText('Doing well, thanks')).toBeInTheDocument()
  })

  it('gives "You" the first speaker colour and each other speaker their own', () => {
    const liveSegments: LiveTranscriptGroup[] = [
      { speaker: 'Speaker 2', start: 0, end: 4, text: 'First' },
      { speaker: 'You', start: 4, end: 8, text: 'Second' },
      { speaker: 'Speaker 3', start: 8, end: 12, text: 'Third' },
    ]
    render(<RecordingView {...base} liveSegments={liveSegments} />)
    expect(screen.getByText('You').style.getPropertyValue('--speaker-color')).toBe('var(--speaker-1)')
    expect(screen.getByText('Speaker 2').style.getPropertyValue('--speaker-color')).toBe('var(--speaker-2)')
    expect(screen.getByText('Speaker 3').style.getPropertyValue('--speaker-color')).toBe('var(--speaker-3)')
  })

  it('only renders working recording actions', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByRole('button', { name: 'Stop and summarize' })).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-keyshortcuts', 'Space')
    expect(screen.getByRole('button', { name: 'Add marker' })).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+M')
  })

  it('edits and persists the working recording title', async () => {
    const renameTitle = vi.fn(() => Promise.resolve())
    render(<RecordingView {...base} renameTitle={renameTitle} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit recording title' }))
    const input = screen.getByRole('textbox', { name: 'Recording title' })
    fireEvent.change(input, { target: { value: 'Onboarding flow review' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameTitle).toHaveBeenCalledWith('Onboarding flow review'))
  })

  it('cancels a working-title edit with Escape', () => {
    const renameTitle = vi.fn(() => Promise.resolve())
    render(<RecordingView {...base} renameTitle={renameTitle} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit recording title' }))
    const input = screen.getByRole('textbox', { name: 'Recording title' })
    fireEvent.change(input, { target: { value: 'Discard this' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(renameTitle).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'New recording' })).toBeInTheDocument()
  })

  it('supports Space to pause and Command-Enter to stop outside interactive controls', () => {
    const togglePause = vi.fn()
    const stopRec = vi.fn()
    render(<RecordingView {...base} togglePause={togglePause} stopRec={stopRec} />)

    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', metaKey: true })

    expect(togglePause).toHaveBeenCalledTimes(1)
    expect(stopRec).toHaveBeenCalledTimes(1)
  })

  it('does not trigger recording shortcuts while the title field has focus', () => {
    const togglePause = vi.fn()
    const stopRec = vi.fn()
    render(<RecordingView {...base} togglePause={togglePause} stopRec={stopRec} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit recording title' }))
    const input = screen.getByRole('textbox', { name: 'Recording title' })
    fireEvent.keyDown(input, { key: ' ', code: 'Space' })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', metaKey: true })

    expect(togglePause).not.toHaveBeenCalled()
    expect(stopRec).not.toHaveBeenCalled()
  })

  describe('row after the last turn', () => {
    it('says "Listening…" while the transcript is live', () => {
      const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 1, text: 'hi' }]
      render(<RecordingView {...base} liveSegments={liveSegments} sttStatus="ready" />)
      expect(screen.getByText('Listening…')).toBeInTheDocument()
    })

    it('names the model while it loads', () => {
      render(<RecordingView {...base} liveSegments={[]} sttStatus="loading" modelName="Whisper small" />)
      expect(screen.getByText('Loading Whisper small…')).toBeInTheDocument()
      expect(screen.queryByText('Listening…')).not.toBeInTheDocument()
    })

    it('says "Paused" while paused', () => {
      render(<RecordingView {...base} paused={true} captureHealth="paused" />)
      expect(screen.queryByText('Listening…')).not.toBeInTheDocument()
      expect(screen.getAllByText('Paused').length).toBeGreaterThan(0)
    })
  })

  describe('after Stop', () => {
    it('replaces the recording controls with the steps still to run', () => {
      render(<RecordingView {...base} stopping={true} processingStage="saving" elapsed={74} speakersExpected={true} />)
      const steps = screen.getAllByRole('listitem')
      expect(steps.map(step => [step.textContent, step.dataset.state])).toEqual([
        ['Saving audio…', 'active'],
        ['Transcript', 'waiting'],
        ['Finding speakers', 'waiting'],
        ['Detailed summary · next', 'waiting'],
      ])
      expect(screen.getByText('Keep Minute open while this finishes.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Stop and summarize' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Add marker' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Skip summary' })).not.toBeInTheDocument()
    })

    it('marks the audio saved while the transcript finishes, and keeps the length and sources', () => {
      render(
        <RecordingView
          {...base}
          stopping={true}
          processingStage="finalizing"
          elapsed={65}
          microphoneName="Studio Display Microphone"
          summaryExpected={false}
        />,
      )
      expect(screen.getByText('Audio saved').closest('li')).toHaveAttribute('data-state', 'done')
      expect(screen.getByText('Finishing transcript…').closest('li')).toHaveAttribute('data-state', 'active')
      expect(screen.queryByText(/summary/i)).not.toBeInTheDocument()
      expect(
        screen.getByText('01:05 · Studio Display Microphone only · Fast transcription · Whisper small'),
      ).toBeInTheDocument()
    })

    it('keeps the transcript on screen under its own heading', () => {
      const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 1, text: 'Last words' }]
      render(<RecordingView {...base} stopping={true} processingStage="finalizing" liveSegments={liveSegments} />)
      expect(screen.getByRole('heading', { name: 'Transcript' })).toBeInTheDocument()
      expect(screen.getByText('Last words')).toBeInTheDocument()
      expect(screen.queryByText('Listening…')).not.toBeInTheDocument()
    })
  })

  describe('health line', () => {
    it('shows an observed transcript delay next to healthy audio', () => {
      const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 8, text: 'Earlier words' }]
      render(<RecordingView {...base} liveSegments={liveSegments} elapsed={31} />)
      expect(screen.getByText('Audio is healthy. Transcript 23s behind.')).toBeInTheDocument()
    })

    it('announces the category without repeating the changing lag seconds', () => {
      const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 8, text: 'Earlier words' }]
      const { rerender } = render(<RecordingView {...base} liveSegments={liveSegments} elapsed={31} />)
      const status = screen.getByRole('status', { name: 'Recording health updates' })
      const announcement = status.textContent
      expect(announcement).toBe('Audio is healthy. The transcript is behind.')

      rerender(<RecordingView {...base} liveSegments={liveSegments} elapsed={32} />)
      expect(screen.getByText('Audio is healthy. Transcript 24s behind.')).toBeInTheDocument()
      expect(status).toHaveTextContent(announcement ?? '')
    })

    it('warns about clipping without raising a message', () => {
      const { container } = render(<RecordingView {...base} systemAudioActive={true} captureHealth="clipping" />)
      expect(screen.getByRole('status', { name: 'Recording health updates' })).toHaveTextContent(
        'The microphone is clipping. Lower the input level.',
      )
      expect(container.querySelectorAll('.recording-message')).toHaveLength(0)
    })
  })

  describe('markers', () => {
    it('adds a labeled marker at the current recording time', async () => {
      const addMarker = vi.fn().mockResolvedValue(undefined)
      render(<RecordingView {...base} elapsed={74} addMarker={addMarker} />)

      fireEvent.click(screen.getByRole('button', { name: 'Add marker' }))
      expect(screen.getByText('01:14')).toBeInTheDocument()
      fireEvent.change(screen.getByRole('textbox', { name: 'Marker label' }), {
        target: { value: 'Pricing decision' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save marker' }))

      await waitFor(() => expect(addMarker).toHaveBeenCalledWith('Pricing decision'))
      expect(screen.queryByRole('textbox', { name: 'Marker label' })).not.toBeInTheDocument()
    })

    it('returns focus to Add marker when the composer closes, by Escape or by saving', async () => {
      render(<RecordingView {...base} />)
      const addMarker = screen.getByRole('button', { name: 'Add marker' })

      fireEvent.click(addMarker)
      const label = screen.getByRole('textbox', { name: 'Marker label' })
      expect(label).toHaveFocus()
      fireEvent.keyDown(label, { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: 'Marker label' })).not.toBeInTheDocument()
      expect(addMarker).toHaveFocus()

      fireEvent.click(addMarker)
      fireEvent.change(screen.getByRole('textbox', { name: 'Marker label' }), { target: { value: 'Decision' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save marker' }))
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Marker label' })).not.toBeInTheDocument())
      expect(addMarker).toHaveFocus()
    })

    it('opens the marker composer with the visible ⌘⇧M shortcut', () => {
      render(<RecordingView {...base} />)
      fireEvent.keyDown(window, { key: 'm', metaKey: true, shiftKey: true })
      expect(screen.getByRole('textbox', { name: 'Marker label' })).toBeInTheDocument()
    })

    it('shows saved markers inline, between the turns around them', () => {
      const liveSegments: LiveTranscriptGroup[] = [
        { speaker: 'You', start: 10, end: 16, text: 'Before the marker' },
        { speaker: 'Speaker 2', start: 30, end: 36, text: 'After the marker' },
      ]
      render(
        <RecordingView
          {...base}
          liveSegments={liveSegments}
          markers={[
            { seconds: 74, label: 'Decision' },
            { seconds: 18, label: 'Open question' },
          ]}
        />,
      )
      const column = screen.getByTestId('live-transcript-scroll')
      const order = ['Before the marker', 'Marker · Open question', 'After the marker', 'Marker · Decision'].map(text =>
        column.textContent?.indexOf(text) ?? -1,
      )
      expect(order.every(position => position >= 0)).toBe(true)
      expect(order).toEqual([...order].sort((a, b) => a - b))
    })
  })

  describe('level indicator', () => {
    it('moves while the microphone delivers sound and is hidden from assistive tech', () => {
      const { container } = render(<RecordingView {...base} captureHealth="healthy" />)
      const indicator = screen.getByTestId('level-indicator')
      expect(indicator).toHaveAttribute('aria-hidden', 'true')
      expect(indicator).toHaveAttribute('data-state', 'live')
      const bar = container.querySelector<HTMLElement>('[data-testid="level-indicator"] > span')
      expect(bar?.style.animation).toContain('wf')
      expect(bar).not.toHaveStyle({ animationPlayState: 'paused' })
    })

    it('holds its bars while paused', () => {
      const { container } = render(<RecordingView {...base} paused={true} captureHealth="paused" />)
      expect(screen.getByTestId('level-indicator')).toHaveAttribute('data-state', 'paused')
      expect(container.querySelector('[data-testid="level-indicator"] > span')).toHaveStyle({ animationPlayState: 'paused' })
    })

    it('rests flat when no sound is arriving', () => {
      const { container } = render(<RecordingView {...base} captureHealth="silent" />)
      expect(screen.getByTestId('level-indicator')).toHaveAttribute('data-state', 'idle')
      expect(container.querySelector<HTMLElement>('[data-testid="level-indicator"] > span')?.style.animation).toBe('')
    })
  })


  describe('live transcript render cap', () => {
    function makeGroups(count: number): LiveTranscriptGroup[] {
      return Array.from({ length: count }, (_, i) => ({
        speaker: 'Speaker 1',
        start: i,
        end: i + 1,
        text: `entry number ${i}`,
      }))
    }

    it('renders every group and shows no honest-count line when under the cap', () => {
      render(<RecordingView {...base} liveSegments={makeGroups(150)} />)
      expect(screen.getByText('entry number 0')).toBeInTheDocument()
      expect(screen.getByText('entry number 149')).toBeInTheDocument()
      expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument()
    })

    it('caps rendered groups at 200 and shows the honest count line when over the cap', () => {
      render(<RecordingView {...base} liveSegments={makeGroups(250)} />)
      // Only the most recent 200 are rendered — the earliest 50 are dropped.
      expect(screen.queryByText('entry number 49')).not.toBeInTheDocument()
      expect(screen.getByText('entry number 50')).toBeInTheDocument()
      expect(screen.getByText('entry number 249')).toBeInTheDocument()
      expect(screen.getByText('Showing the latest 200 entries. The full transcript is saved.')).toBeInTheDocument()
    })

    it('keeps a still-visible group’s DOM node identity (and thus its own text) stable as the capped window rotates', () => {
      // Regression test for positional (index) keys on a rotating window:
      // with 201 groups, the visible window is entries [1..200]; a group
      // that survives the *next* arrival must keep its own DOM node rather
      // than having some other row's text rewritten into it.
      const { rerender } = render(<RecordingView {...base} liveSegments={makeGroups(201)} />)
      const survivorText = 'entry number 150'
      const nodeBefore = screen.getByText(survivorText)

      // One more group arrives — the window rotates forward by one (entry 1
      // drops out, entry 201 is added); entry 150 remains in the window
      // throughout.
      rerender(<RecordingView {...base} liveSegments={makeGroups(202)} />)
      const nodeAfter = screen.getByText(survivorText)

      expect(nodeAfter).toBe(nodeBefore)

      // The full visible slice after rotation is exactly the latest 200
      // (entries [2..201]) — the oldest surviving entry from before (1) is
      // now gone, and the freshly-arrived one (201) is present.
      expect(screen.queryByText('entry number 1')).not.toBeInTheDocument()
      expect(screen.getByText('entry number 2')).toBeInTheDocument()
      expect(screen.getByText('entry number 201')).toBeInTheDocument()
    })
  })

  describe('live transcript auto-scroll (H6)', () => {
    /** jsdom never computes real layout — scrollHeight/clientHeight are always 0 — so the scroll metrics the component reads have to be stubbed directly on the node. */
    function setScrollMetrics(el: HTMLElement, metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
      Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true })
      Object.defineProperty(el, 'scrollTop', { value: metrics.scrollTop, writable: true, configurable: true })
    }

    it('does not show the "Jump to latest" pill while stuck to the bottom', () => {
      render(<RecordingView {...base} />)
      expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeInTheDocument()
    })

    it('shows the "Jump to latest" pill once the user scrolls away from the bottom', () => {
      render(<RecordingView {...base} />)
      const scroller = screen.getByTestId('live-transcript-scroll')
      setScrollMetrics(scroller, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })
      fireEvent.scroll(scroller)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
    })

    it('stays stuck (no pill) when the scroll position is within the stick threshold of the bottom', () => {
      render(<RecordingView {...base} />)
      const scroller = screen.getByTestId('live-transcript-scroll')
      setScrollMetrics(scroller, { scrollTop: 580, scrollHeight: 1000, clientHeight: 400 })
      fireEvent.scroll(scroller)
      expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeInTheDocument()
    })

    it('clicking "Jump to latest" scrolls to the bottom and hides the pill again', () => {
      render(<RecordingView {...base} />)
      const scroller = screen.getByTestId('live-transcript-scroll')
      setScrollMetrics(scroller, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })
      fireEvent.scroll(scroller)
      expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /jump to latest/i }))
      expect(scroller.scrollTop).toBe(1000)
      expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeInTheDocument()
    })
  })
})
