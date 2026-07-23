import { render, screen } from '@testing-library/react'
import { demoMarkdown } from '../data/demo'
import { MarkdownCard } from './MarkdownCard'

const base = {
  filename: 'client-call-acme.md',
  subtitle: '4.2 KB · saved locally',
  markdown: demoMarkdown,
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
    render(<MarkdownCard filename="other-note.md" subtitle="80 B · saved locally" markdown="# Other note\n\nplaceholder" />)
    expect(screen.getByText('other-note.md')).toBeInTheDocument()
    expect(screen.getByText(/# Other note/)).toBeInTheDocument()
    expect(screen.queryByText(/# Client call — Acme/)).not.toBeInTheDocument()
  })
})
