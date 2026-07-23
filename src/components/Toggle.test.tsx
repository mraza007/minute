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

  it('positions the knob at left 16 when on and 2 when off', () => {
    const { rerender } = render(<Toggle on={true} onToggle={vi.fn()} label="Encrypt" />)
    const knobOn = document.querySelector('span span') as HTMLElement
    expect(knobOn).toHaveStyle({ left: '16px' })

    rerender(<Toggle on={false} onToggle={vi.fn()} label="Encrypt" />)
    const knobOff = document.querySelector('span span') as HTMLElement
    expect(knobOff).toHaveStyle({ left: '2px' })
  })

  it('renders the label text', () => {
    render(<Toggle on={false} onToggle={vi.fn()} label="Encrypt note library with FileVault key" />)
    expect(screen.getByText('Encrypt note library with FileVault key')).toBeInTheDocument()
  })
})
