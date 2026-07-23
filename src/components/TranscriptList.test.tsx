import { render, screen } from '@testing-library/react'
import { demoTranscript } from '../data/demo'
import { TranscriptList } from './TranscriptList'

describe('TranscriptList', () => {
  it('renders every segment speaker and text', () => {
    render(<TranscriptList segments={demoTranscript} />)
    expect(screen.getAllByText('Tom Reyes — Acme').length).toBe(2)
    expect(screen.getAllByText('You', { selector: 'b' }).length).toBe(2)
    expect(screen.getByText('Priya Shah')).toBeInTheDocument()
  })

  it('shows exactly one HIGHLIGHT chip for the highlighted segment', () => {
    render(<TranscriptList segments={demoTranscript} />)
    expect(screen.getAllByText('HIGHLIGHT')).toHaveLength(1)
  })

  it('renders nothing but an empty container for an empty segment list', () => {
    const { container } = render(<TranscriptList segments={[]} />)
    expect(container.firstChild).toBeEmptyDOMElement()
  })

  it('renders segment timestamps', () => {
    render(<TranscriptList segments={demoTranscript} />)
    expect(screen.getByText('00:41')).toBeInTheDocument()
    expect(screen.getByText('02:26')).toBeInTheDocument()
  })
})
