import { render, screen } from '@testing-library/react'
import { MarkdownCard } from './MarkdownCard'

describe('MarkdownCard', () => {
  it('renders the filename and file size', () => {
    render(<MarkdownCard />)
    expect(screen.getByText('client-call-acme.md')).toBeInTheDocument()
    expect(screen.getByText('4.2 KB · saved locally')).toBeInTheDocument()
  })

  it('renders Copy and Reveal in Finder buttons', () => {
    render(<MarkdownCard />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeInTheDocument()
  })

  it('renders the demo markdown content', () => {
    render(<MarkdownCard />)
    expect(screen.getByText(/# Client call — Acme/)).toBeInTheDocument()
    expect(screen.getByText(/Send security documentation to Tom before procurement kickoff/)).toBeInTheDocument()
  })
})
