import { fireEvent, render, screen } from '@testing-library/react'
import { ShortcutReference } from './ShortcutReference'

describe('ShortcutReference', () => {
  it('documents core shortcuts, traps focus, and closes with Escape', () => {
    const onClose = vi.fn()
    render(<ShortcutReference onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.getByText('Search notes')).toBeInTheDocument()
    expect(screen.getByText('Pause or resume')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close keyboard shortcuts' })).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Close keyboard shortcuts' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
