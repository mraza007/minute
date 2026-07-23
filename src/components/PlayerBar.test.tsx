import { render, screen } from '@testing-library/react'
import { PlayerBar } from './PlayerBar'

describe('PlayerBar', () => {
  it('shows a static 00:00 elapsed time against the real formatted duration', () => {
    render(<PlayerBar durationSec={48 * 60 + 22} />)
    expect(screen.getByText('00:00 / 48:22')).toBeInTheDocument()
  })

  it('formats a sub-minute duration correctly', () => {
    render(<PlayerBar durationSec={42} />)
    expect(screen.getByText('00:00 / 00:42')).toBeInTheDocument()
  })

  it('renders the 1.5× speed chip regardless of duration (still cosmetic — playback is Stage 4)', () => {
    render(<PlayerBar durationSec={0} />)
    expect(screen.getByText('1.5×')).toBeInTheDocument()
  })

  it('renders the Play button', () => {
    render(<PlayerBar durationSec={120} />)
    expect(screen.getByTitle('Play')).toBeInTheDocument()
  })
})
