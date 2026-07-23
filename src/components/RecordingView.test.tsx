import { fireEvent, render, screen } from '@testing-library/react'
import { RecordingView } from './RecordingView'

const base = {
  paused: false,
  togglePause: vi.fn(),
  stopRec: vi.fn(),
}

describe('RecordingView', () => {
  it('calls stopRec when "Stop & summarize" is clicked', () => {
    const stopRec = vi.fn()
    render(<RecordingView {...base} stopRec={stopRec} />)
    fireEvent.click(screen.getByRole('button', { name: /stop & summarize/i }))
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

  it('renders the live transcript speakers and the transcribing indicator', () => {
    render(<RecordingView {...base} />)
    expect(screen.getAllByText('Speaker 1').length).toBe(2)
    expect(screen.getByText('Speaker 2')).toBeInTheDocument()
    expect(screen.getByText('transcribing…')).toBeInTheDocument()
  })

  it('shows the live transcript privacy label', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByText('LIVE TRANSCRIPT — AUDIO NEVER LEAVES THIS MACHINE')).toBeInTheDocument()
  })

  it('shows the live insights panel with action items, key points, and info box', () => {
    render(<RecordingView {...base} />)
    expect(screen.getByText('Live insights')).toBeInTheDocument()
    expect(screen.getByText('ACTION ITEMS · SO FAR')).toBeInTheDocument()
    expect(screen.getByText('KEY POINTS')).toBeInTheDocument()
    expect(screen.getByText(/Insights refresh every 60 s while recording/)).toBeInTheDocument()
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
})
