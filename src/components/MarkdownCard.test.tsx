import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { demoMarkdown } from '../data/demo'
import { MarkdownCard } from './MarkdownCard'

const base = {
  filename: 'client-call-acme.md',
  subtitle: '4.2 KB · saved locally',
  markdown: demoMarkdown,
  onReveal: vi.fn(),
}

describe('MarkdownCard', () => {
  it('renders the given filename and subtitle', () => {
    render(<MarkdownCard {...base} />)
    expect(screen.getByText('client-call-acme.md')).toBeInTheDocument()
    expect(screen.getByText('4.2 KB · saved locally')).toBeInTheDocument()
  })

  it('renders Copy and Reveal in Finder buttons', () => {
    render(<MarkdownCard {...base} />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeInTheDocument()
  })

  it('renders the given markdown content', () => {
    render(<MarkdownCard {...base} />)
    expect(screen.getByText(/# Client call — Acme/)).toBeInTheDocument()
    expect(screen.getByText(/Send security documentation to Tom before procurement kickoff/)).toBeInTheDocument()
  })

  it('renders a different filename and markdown when given different props', () => {
    render(<MarkdownCard {...base} filename="other-note.md" subtitle="80 B · saved locally" markdown="# Other note\n\nplaceholder" />)
    expect(screen.getByText('other-note.md')).toBeInTheDocument()
    expect(screen.getByText(/# Other note/)).toBeInTheDocument()
    expect(screen.queryByText(/# Client call — Acme/)).not.toBeInTheDocument()
  })

  it('clicking Reveal in Finder calls the onReveal prop', () => {
    const onReveal = vi.fn()
    render(<MarkdownCard {...base} onReveal={onReveal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  describe('Copy button', () => {
    let writeText: ReturnType<typeof vi.fn>

    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      })
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    })

    it('writes the markdown to the clipboard', () => {
      render(<MarkdownCard {...base} />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expect(writeText).toHaveBeenCalledWith(demoMarkdown)
    })

    it('gracefully catches a clipboard rejection via the onCopyError prop', async () => {
      writeText.mockRejectedValue(new Error('clipboard denied'))
      const onCopyError = vi.fn()
      render(<MarkdownCard {...base} onCopyError={onCopyError} />)

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

      await vi.waitFor(() => expect(onCopyError).toHaveBeenCalledWith(new Error('clipboard denied')))
    })

    it('does not throw when onCopyError is omitted and the clipboard rejects', async () => {
      writeText.mockRejectedValue(new Error('clipboard denied'))
      render(<MarkdownCard {...base} />)

      expect(() => fireEvent.click(screen.getByRole('button', { name: 'Copy' }))).not.toThrow()
    })
  })
})
