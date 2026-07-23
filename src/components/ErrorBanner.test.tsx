import { render, screen } from '@testing-library/react'
import { ErrorBanner } from './ErrorBanner'

describe('ErrorBanner', () => {
  it('renders the message with role="alert" when a message is set', () => {
    render(<ErrorBanner message="backend unavailable" />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('backend unavailable')
  })

  it('renders nothing when the message is null', () => {
    const { container } = render(<ErrorBanner message={null} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
