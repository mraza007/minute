import { fireEvent, render, screen } from '@testing-library/react'
import { TitleBar } from './TitleBar'

const base = { isRecording: false, recTime: '14:32', onStartRec: vi.fn(), onReturnToRecording: vi.fn() }

describe('TitleBar', () => {
  it('shows New recording button when idle', () => {
    render(<TitleBar {...base} />)
    expect(screen.getByRole('button', { name: /new recording/i })).toBeInTheDocument()
    expect(screen.queryByText(/REC/)).not.toBeInTheDocument()
  })

  it('shows REC pill with time while recording, and hides New recording', () => {
    render(<TitleBar {...base} isRecording />)
    expect(screen.getByText(/REC 14:32/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()
  })

  it('calls onStartRec when the New recording button is clicked', () => {
    const onStartRec = vi.fn()
    render(<TitleBar {...base} onStartRec={onStartRec} />)
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(onStartRec).toHaveBeenCalledTimes(1)
  })

  it('renders the REC pill as a clickable "Return to recording" button', () => {
    render(<TitleBar {...base} isRecording />)
    expect(screen.getByRole('button', { name: 'Return to recording' })).toBeInTheDocument()
  })

  it('calls onReturnToRecording when the REC pill is clicked', () => {
    const onReturnToRecording = vi.fn()
    render(<TitleBar {...base} isRecording onReturnToRecording={onReturnToRecording} />)
    fireEvent.click(screen.getByRole('button', { name: 'Return to recording' }))
    expect(onReturnToRecording).toHaveBeenCalledTimes(1)
  })

  it('shows the REC pill (not New recording) when isRecording is true, regardless of which screen is current', () => {
    // TitleBar itself has no notion of "current view" — isRecording alone
    // drives this, which is what makes it correct from Notes or Settings
    // too, not just the recording screen itself.
    render(<TitleBar {...base} isRecording recTime="00:42" />)
    expect(screen.getByText(/REC 00:42/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()
  })
})
