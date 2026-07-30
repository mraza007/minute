import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { LiveTranscriptGroup } from '../state/adapters'
import { RecordingView } from './RecordingView'

const base = {
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
}

describe('RecordingView', () => {
  it('calls stopRec when "Stop & transcribe" is clicked', () => {
    const stopRec = vi.fn()
    render(<RecordingView {...base} stopRec={stopRec} />)
    fireEvent.click(screen.getByRole('button', { name: /stop & transcribe/i }))
    expect(stopRec).toHaveBeenCalledTimes(1)
  })

  it('shows "Pause" when not paused and calls togglePause when clicked', () => {
    const togglePause = vi.fn()
    render(<RecordingView {...base} paused={false} togglePause={togglePause} />)
    const btn = screen.getByRole('button', { name: 'Pause' })
    fireEvent.click(btn)
    expect(togglePause).toHaveBeenCalledTimes(1)
  })

  it('shows "Resume" when paused', () => {
    render(<RecordingView {...base} paused={true} />)
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(screen.getByText('Capture paused')).toBeInTheDocument()
    expect(screen.getByText('Paused · on-device')).toBeInTheDocument()
  })

  it('shows the live transcript privacy label', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByText('Live transcript — audio never leaves this machine')).toBeInTheDocument()
  })

  it('shows the model name and "on-device" in the caption', () => {
    render(<RecordingView {...base} modelName="Whisper medium" />)
    expect(screen.getAllByText('Whisper medium')).toHaveLength(2)
    expect(screen.getByText('Live · on-device')).toBeInTheDocument()
  })

  describe('capture source visibility', () => {
    it('prominently names the microphone opened by the backend', () => {
      render(<RecordingView {...base} microphoneName="Studio Display Microphone" />)
      expect(screen.getAllByText('Studio Display Microphone')).toHaveLength(2)
      expect(screen.getByText('Microphone only · macOS default input')).toBeInTheDocument()
    })

    it('explains when system audio is not part of the recording', () => {
      render(<RecordingView {...base} systemAudioActive={false} />)
      expect(screen.getByText('Not part of this recording')).toBeInTheDocument()
      expect(screen.getByText(/Turn on system audio in Settings/)).toBeInTheDocument()
    })

    it('shows system audio as an active capture source when it is included', () => {
      render(<RecordingView {...base} systemAudioActive={true} />)
      expect(screen.getByText('Microphone + system audio · macOS default input')).toBeInTheDocument()
      expect(screen.getByText('Apps and call audio')).toBeInTheDocument()
      expect(screen.queryByText(/Turn on system audio in Settings/)).not.toBeInTheDocument()
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
    expect(screen.getByText('Hello there, how are you').closest('.script-line')).toHaveClass('live-script-line')
  })

  it('only renders working recording actions', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByRole('button', { name: /stop & transcribe/i })).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('aria-keyshortcuts', 'Space')
    expect(screen.getByRole('button', { name: /add marker/i })).toHaveAttribute('aria-keyshortcuts', 'Meta+Shift+M')
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

  it('collapses and restores the recording details rail', () => {
    render(<RecordingView {...base} />)
    const toggle = screen.getByRole('button', { name: 'Hide details' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(toggle)
    expect(screen.queryByRole('complementary', { name: 'Recording details' })).not.toBeInTheDocument()

    const restore = screen.getByRole('button', { name: 'Show details' })
    expect(restore).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(restore)
    expect(screen.getByRole('complementary', { name: 'Recording details' })).toBeInTheDocument()
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

  it('shows the blinking transcribing indicator when segments exist and sttStatus is ready', () => {
    const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 1, text: 'hi' }]
    render(<RecordingView {...base} liveSegments={liveSegments} sttStatus="ready" />)
    expect(screen.getByText('transcribing…')).toBeInTheDocument()
  })

  it('shows a loading hint row with the model name when empty and sttStatus is loading', () => {
    render(<RecordingView {...base} liveSegments={[]} sttStatus="loading" modelName="Whisper small" />)
    expect(screen.getByText('Loading Whisper small…')).toBeInTheDocument()
    expect(screen.queryByText('transcribing…')).not.toBeInTheDocument()
  })

  it('shows just the blinking cursor row (no hint) when empty and sttStatus is ready', () => {
    render(<RecordingView {...base} liveSegments={[]} sttStatus="ready" />)
    expect(screen.getByText('transcribing…')).toBeInTheDocument()
  })

  it('shows an error info row with sttError when empty and sttStatus is error', () => {
    render(<RecordingView {...base} liveSegments={[]} sttStatus="error" sttError="model not installed" />)
    expect(screen.getByText('Recording continues — transcript unavailable')).toBeInTheDocument()
    expect(screen.getByText('model not installed')).toBeInTheDocument()
    expect(screen.queryByText('transcribing…')).not.toBeInTheDocument()
  })

  it('shows the error info row instead of the blinking cursor when segments exist and sttStatus is error', () => {
    const liveSegments: LiveTranscriptGroup[] = [{ speaker: 'Speaker 1', start: 0, end: 1, text: 'hi' }]
    render(<RecordingView {...base} liveSegments={liveSegments} sttStatus="error" sttError="whisper inference failed" />)
    expect(screen.getByText('Recording continues — transcript unavailable')).toBeInTheDocument()
    expect(screen.queryByText('transcribing…')).not.toBeInTheDocument()
  })

  it('replaces recording controls with an explicit saving handoff while stopping', () => {
    render(<RecordingView {...base} stopping={true} processingStage="saving" elapsed={74} />)
    expect(screen.getByRole('heading', { name: 'Turning your recording into notes' })).toBeInTheDocument()
    expect(screen.getAllByText('Saving audio').length).toBeGreaterThan(0)
    expect(screen.getByText('01:14')).toBeInTheDocument()
    expect(screen.getByText('Keep Minute open while this finishes.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /stop & transcribe/i })).not.toBeInTheDocument()
  })

  it('shows completed and active processing stages without hiding source metadata', () => {
    render(
      <RecordingView
        {...base}
        stopping={true}
        processingStage="finalizing"
        elapsed={65}
        microphoneName="Studio Display Microphone"
      />,
    )
    const savingStep = screen.getByText('Saving audio').closest('li')
    const finalizingStep = screen.getByText('Finalizing transcript').closest('li')
    expect(savingStep).toHaveAttribute('data-state', 'complete')
    expect(finalizingStep).toHaveAttribute('data-state', 'active')
    expect(screen.getAllByText('Studio Display Microphone').length).toBeGreaterThan(0)
    expect(screen.getByText('01:05')).toBeInTheDocument()
  })

  it('surfaces capture silence with recovery guidance while recording continues', () => {
    render(<RecordingView {...base} captureHealth="silent" />)
    expect(screen.getByText('No input detected')).toBeInTheDocument()
    expect(screen.getByText('Check that the microphone is not muted or covered.')).toBeInTheDocument()
  })

  it('shows an honest observed transcript delay and reassures that audio capture is safe', () => {
    const liveSegments: LiveTranscriptGroup[] = [
      { speaker: 'Speaker 1', start: 0, end: 8, text: 'Earlier words' },
    ]
    render(<RecordingView {...base} liveSegments={liveSegments} elapsed={31} />)
    expect(screen.getAllByText('Transcript about 23s behind').length).toBeGreaterThan(0)
    expect(screen.getByText('Audio capture is safe while the transcript catches up.')).toBeInTheDocument()
  })

  it('announces recording-health categories without repeating changing lag seconds', () => {
    const liveSegments: LiveTranscriptGroup[] = [
      { speaker: 'Speaker 1', start: 0, end: 8, text: 'Earlier words' },
    ]
    const { rerender } = render(<RecordingView {...base} liveSegments={liveSegments} elapsed={31} />)
    const status = screen.getByRole('status', { name: 'Recording health updates' })
    const announcement = status.textContent
    expect(announcement).toContain('Transcript is behind.')
    expect(announcement).not.toContain('23s')

    rerender(<RecordingView {...base} liveSegments={liveSegments} elapsed={32} />)
    expect(screen.getAllByText('Transcript about 24s behind').length).toBeGreaterThan(0)
    expect(status).toHaveTextContent(announcement ?? '')
  })

  it('uses the context rail for useful recording details instead of placeholder content', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByRole('complementary', { name: 'Recording details' })).toHaveClass('recording-details')
    expect(screen.getByText('Sources are fixed until you stop.')).toBeInTheDocument()
    expect(screen.getByText('Audio, transcript, and model processing stay on this Mac.')).toBeInTheDocument()
    expect(screen.queryByText('Live insights arrive in a later update.')).not.toBeInTheDocument()
  })

  it('adds a labeled marker at the current recording time', async () => {
    const addMarker = vi.fn().mockResolvedValue(undefined)
    render(<RecordingView {...base} elapsed={74} addMarker={addMarker} />)

    fireEvent.click(screen.getByRole('button', { name: /add marker/i }))
    expect(screen.getByText('01:14')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Marker label' }), {
      target: { value: 'Pricing decision' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save marker' }))

    await waitFor(() => expect(addMarker).toHaveBeenCalledWith('Pricing decision'))
    expect(screen.queryByRole('textbox', { name: 'Marker label' })).not.toBeInTheDocument()
  })

  it('opens the marker composer with the visible ⌘⇧M shortcut', () => {
    render(<RecordingView {...base} />)
    fireEvent.keyDown(window, { key: 'm', metaKey: true, shiftKey: true })
    expect(screen.getByRole('textbox', { name: 'Marker label' })).toBeInTheDocument()
  })

  it('lists persisted markers in recording details', () => {
    render(
      <RecordingView
        {...base}
        markers={[
          { seconds: 18, label: 'Open question' },
          { seconds: 74, label: 'Decision' },
        ]}
      />,
    )
    expect(screen.getByText('Markers · 2')).toBeInTheDocument()
    expect(screen.getByText('Open question')).toBeInTheDocument()
    expect(screen.getByText('Decision')).toBeInTheDocument()
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
    expect(screen.getByText(/audio capture is still active/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry finish' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue recording' }))
    expect(onRetryProcessing).toHaveBeenCalledTimes(1)
    expect(onDismissProcessingFailure).toHaveBeenCalledTimes(1)
  })

  it('renders 56 waveform bars', () => {
    const { container } = render(<RecordingView {...base} />)
    const bars = container.querySelectorAll('[data-testid="waveform-bars"] > span')
    expect(bars).toHaveLength(56)
    expect(screen.getByTestId('waveform-bars')).toHaveAttribute('aria-hidden', 'true')
  })

  it('sets animationPlayState to paused on waveform bars when paused', () => {
    const { container } = render(<RecordingView {...base} paused={true} />)
    const bars = container.querySelectorAll('[data-testid="waveform-bars"] > span')
    expect(bars[0]).toHaveStyle({ animationPlayState: 'paused' })
    expect(screen.getByTestId('waveform-bars')).toHaveAttribute('data-paused', 'true')
  })

  it('does not set animationPlayState when not paused', () => {
    const { container } = render(<RecordingView {...base} paused={false} />)
    const bars = container.querySelectorAll('[data-testid="waveform-bars"] > span')
    expect(bars[0]).not.toHaveStyle({ animationPlayState: 'paused' })
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
      expect(screen.getByText('Showing the latest 200 entries — the full transcript is saved.')).toBeInTheDocument()
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

  describe('auto-stop banner (issue #9)', () => {
    it('is absent while no countdown is pending', () => {
      render(<RecordingView {...base} autoStopSeconds={null} />)
      expect(screen.queryByText(/Nothing has been audible/)).not.toBeInTheDocument()
    })

    it('shows the countdown and wires Keep recording / Stop now', () => {
      const onKeepRecording = vi.fn()
      const stopRec = vi.fn()
      render(
        <RecordingView {...base} autoStopSeconds={594} onKeepRecording={onKeepRecording} stopRec={stopRec} />,
      )
      expect(screen.getByText(/stop and transcribe in 09:54/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Keep recording' }))
      expect(onKeepRecording).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole('button', { name: 'Stop now' }))
      expect(stopRec).toHaveBeenCalledTimes(1)
    })
  })
})
