import { fireEvent, render, screen } from '@testing-library/react'
import { Toggle } from './Toggle'

describe('Toggle', () => {
  it('renders a switch with aria-checked matching "on"', () => {
    render(<Toggle on={true} onToggle={vi.fn()} label="Delete original audio" />)
    const el = screen.getByRole('switch', { name: /delete original audio/i })
    expect(el).toHaveAttribute('aria-checked', 'true')
  })

  it('sets aria-checked to false when off', () => {
    render(<Toggle on={false} onToggle={vi.fn()} label="Delete original audio" />)
    const el = screen.getByRole('switch', { name: /delete original audio/i })
    expect(el).toHaveAttribute('aria-checked', 'false')
  })

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn()
    render(<Toggle on={false} onToggle={onToggle} label="Delete original audio" />)
    fireEvent.click(screen.getByRole('switch', { name: /delete original audio/i }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('translates the knob 16px (2 -> 18 left, track 40 − knob 20 − inset 2) when on, and leaves it untranslated when off', () => {
    const { rerender } = render(<Toggle on={true} onToggle={vi.fn()} label="Encrypt" />)
    expect(screen.getByTestId('toggle-knob')).toHaveStyle({ left: '2px', transform: 'translateX(16px)' })

    rerender(<Toggle on={false} onToggle={vi.fn()} label="Encrypt" />)
    expect(screen.getByTestId('toggle-knob')).toHaveStyle({ left: '2px', transform: 'translateX(0)' })
  })

  it('renders the label text', () => {
    render(<Toggle on={false} onToggle={vi.fn()} label="Encrypt note library with FileVault key" />)
    expect(screen.getByText('Encrypt note library with FileVault key')).toBeInTheDocument()
  })

  it('is not disabled by default', () => {
    render(<Toggle on={false} onToggle={vi.fn()} label="Delete original audio" />)
    expect(screen.getByRole('switch', { name: /delete original audio/i })).toHaveAttribute('aria-disabled', 'false')
  })

  it('sets aria-disabled and does not call onToggle when clicked while disabled', () => {
    const onToggle = vi.fn()
    render(<Toggle on={false} onToggle={onToggle} label="Capture system audio" disabled />)
    const el = screen.getByRole('switch', { name: /capture system audio/i })
    expect(el).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(el)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
