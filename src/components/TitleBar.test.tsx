import { fireEvent, render, screen } from '@testing-library/react'
import { TitleBar } from './TitleBar'

const base = { recording: false, recTime: '14:32', onStartRec: vi.fn() }

describe('TitleBar', () => {
  it('shows New recording button when idle', () => {
    render(<TitleBar {...base} />)
    expect(screen.getByRole('button', { name: /new recording/i })).toBeInTheDocument()
    expect(screen.queryByText(/REC/)).not.toBeInTheDocument()
  })

  it('shows REC pill with time while recording', () => {
    render(<TitleBar {...base} recording />)
    expect(screen.getByText(/REC 14:32/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new recording/i })).not.toBeInTheDocument()
  })

  it('calls onStartRec when the New recording button is clicked', () => {
    const onStartRec = vi.fn()
    render(<TitleBar {...base} onStartRec={onStartRec} />)
    fireEvent.click(screen.getByRole('button', { name: /new recording/i }))
    expect(onStartRec).toHaveBeenCalledTimes(1)
  })
})
