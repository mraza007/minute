import { fireEvent, render, screen } from '@testing-library/react'
import type { LiveTranscriptGroup } from '../state/adapters'
import { RecordingView } from './RecordingView'

const base = {
  liveSegments: [] as LiveTranscriptGroup[],
  paused: false,
  togglePause: vi.fn(),
  stopRec: vi.fn(),
  stopping: false,
  sttStatus: 'ready' as const,
  sttError: null as string | null,
  modelName: 'Whisper small',
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
  })

  it('shows the live transcript privacy label', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByText('LIVE TRANSCRIPT — AUDIO NEVER LEAVES THIS MACHINE')).toBeInTheDocument()
  })

  it('shows the model name and "on-device" in the caption', () => {
    render(<RecordingView {...base} modelName="Whisper medium" />)
    expect(screen.getByText('Whisper medium · on-device')).toBeInTheDocument()
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

  it('disables the stop button and shows "Finishing…" while stopping', () => {
    render(<RecordingView {...base} stopping={true} />)
    const btn = screen.getByRole('button', { name: /finishing/i })
    expect(btn).toBeDisabled()
    expect(screen.queryByRole('button', { name: /stop & transcribe/i })).not.toBeInTheDocument()
  })

  it('shows an honest live insights placeholder — no fake AI content during a real recording', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByText('Live insights')).toBeInTheDocument()
    expect(screen.getByText('Live insights arrive in a later update.')).toBeInTheDocument()
    expect(screen.getByText('Transcription runs on-device — nothing leaves this machine.')).toBeInTheDocument()
    expect(screen.queryByText('ACTION ITEMS · SO FAR')).not.toBeInTheDocument()
    expect(screen.queryByText('KEY POINTS')).not.toBeInTheDocument()
    expect(screen.queryByText(/Acme expansion offsets SMB shortfall/)).not.toBeInTheDocument()
  })

  it('renders 56 waveform bars', () => {
    const { container } = render(<RecordingView {...base} />)
    const bars = container.querySelectorAll('[data-testid="waveform-bars"] > span')
    expect(bars).toHaveLength(56)
  })

  it('sets animationPlayState to paused on waveform bars when paused', () => {
    const { container } = render(<RecordingView {...base} paused={true} />)
    const bars = container.querySelectorAll('[data-testid="waveform-bars"] > span')
    expect(bars[0]).toHaveStyle({ animationPlayState: 'paused' })
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
