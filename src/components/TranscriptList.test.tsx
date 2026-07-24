import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { demoTranscript } from '../data/demo'
import { TranscriptList, type TranscriptListProps } from './TranscriptList'

function makeProps(overrides: Partial<TranscriptListProps> = {}): TranscriptListProps {
  return {
    segments: demoTranscript,
    activeIndex: -1,
    onSeek: vi.fn(),
    seekable: true,
    ...overrides,
  }
}

describe('TranscriptList', () => {
  it('renders every segment speaker and text', () => {
    render(<TranscriptList {...makeProps()} />)
    expect(screen.getAllByText('Tom Reyes — Acme').length).toBe(2)
    expect(screen.getAllByText('You', { selector: 'b' }).length).toBe(2)
    expect(screen.getByText('Priya Shah')).toBeInTheDocument()
  })

  it('renders nothing but an empty container for an empty segment list', () => {
    const { container } = render(<TranscriptList {...makeProps({ segments: [] })} />)
    expect(container.firstChild).toBeEmptyDOMElement()
  })

  it('renders segment timestamps', () => {
    render(<TranscriptList {...makeProps()} />)
    expect(screen.getByText('00:41')).toBeInTheDocument()
    expect(screen.getByText('02:26')).toBeInTheDocument()
  })

  it('renders timestamps as buttons with a "Play from mm:ss" aria-label', () => {
    render(<TranscriptList {...makeProps()} />)
    const button = screen.getByRole('button', { name: 'Play from 00:41' })
    expect(button).toBeInTheDocument()
  })

  it('clicking a timestamp calls onSeek with that segment’s start time', () => {
    const onSeek = vi.fn()
    render(<TranscriptList {...makeProps({ onSeek })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play from 01:34' }))
    expect(onSeek).toHaveBeenCalledWith(94)
  })

  it('highlights the active segment (per activeIndex) and no other', () => {
    render(<TranscriptList {...makeProps({ activeIndex: 1 })} />)
    const activeButton = screen.getByRole('button', { name: 'Play from 01:02' })
    const activeRow = activeButton.closest('div')?.parentElement?.parentElement
    expect(activeRow).toHaveStyle({ background: 'var(--surface-soft)' })
  })

  it('highlights nothing when activeIndex is -1', () => {
    const { container } = render(<TranscriptList {...makeProps({ activeIndex: -1 })} />)
    const rows = container.querySelectorAll(':scope > div')
    rows.forEach(row => {
      expect(row).not.toHaveStyle({ background: 'var(--surface-soft)' })
    })
  })

  it('disables timestamp buttons and does not call onSeek when not seekable', () => {
    const onSeek = vi.fn()
    render(<TranscriptList {...makeProps({ onSeek, seekable: false })} />)
    const button = screen.getByRole('button', { name: 'Play from 00:41' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onSeek).not.toHaveBeenCalled()
  })
})
