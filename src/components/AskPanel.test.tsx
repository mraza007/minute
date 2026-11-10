import { fireEvent, render, screen } from '@testing-library/react'
import { AskPanel, type AskPanelProps } from './AskPanel'

function baseProps(overrides: Partial<AskPanelProps> = {}): AskPanelProps {
  return {
    llmInstalled: true,
    askHistory: [],
    askStatus: 'idle',
    llmBusy: false,
    seekable: true,
    onGoSettings: vi.fn(),
    onAsk: vi.fn(),
    onSeekCitation: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('AskPanel', () => {
  it('is a labelled dialog with the question input focused', () => {
    render(<AskPanel {...baseProps()} />)
    expect(screen.getByRole('dialog', { name: 'Ask about this meeting' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Ask a question')).toHaveFocus()
    expect(screen.getByText('Answers use only this transcript. Click a time to play it.')).toBeInTheDocument()
  })

  it('closes from the close button and on Escape', () => {
    const onClose = vi.fn()
    render(<AskPanel {...baseProps({ onClose })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Ask' }))
    fireEvent.keyDown(screen.getByPlaceholderText('Ask a question'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows the download prompt instead of the input when no summary model is installed', () => {
    const onGoSettings = vi.fn()
    render(<AskPanel {...baseProps({ llmInstalled: false, onGoSettings })} />)
    expect(screen.getByText('Ask questions about this meeting on this Mac once a summary model is installed.')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Ask a question')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download a summary model' }))
    expect(onGoSettings).toHaveBeenCalledTimes(1)
  })

  it('submits from the send button too', () => {
    const onAsk = vi.fn()
    render(<AskPanel {...baseProps({ onAsk })} />)
    const send = screen.getByRole('button', { name: 'Send question' })
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('Ask a question'), { target: { value: 'Who owns the FAQ?' } })
    fireEvent.click(send)
    expect(onAsk).toHaveBeenCalledWith('Who owns the FAQ?')
  })

  it('makes the input read-only and shows the answering line while askStatus is running', () => {
    render(<AskPanel {...baseProps({ askStatus: 'running' })} />)
    const input = screen.getByPlaceholderText('Ask a question')
    expect(input).toHaveAttribute('readonly')
    expect(input).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Answering on this Mac…')).toBeInTheDocument()
  })

  // A disabled input drops focus on <body>, where Escape no longer reaches
  // the panel. Focus has to stay inside for the whole answer.
  it('keeps focus in the panel while it answers, so Escape still closes it', () => {
    const onClose = vi.fn()
    const onAsk = vi.fn()
    const { rerender } = render(<AskPanel {...baseProps({ onAsk, onClose })} />)
    const input = screen.getByPlaceholderText('Ask a question')
    fireEvent.change(input, { target: { value: 'Who owns the FAQ?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAsk).toHaveBeenCalledWith('Who owns the FAQ?')

    rerender(<AskPanel {...baseProps({ onAsk, onClose, askStatus: 'running', llmBusy: true })} />)
    expect(input).toHaveFocus()
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not send a second question while one is being answered', () => {
    const onAsk = vi.fn()
    render(<AskPanel {...baseProps({ onAsk, askStatus: 'running', llmBusy: true })} />)
    const input = screen.getByPlaceholderText('Ask a question')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAsk).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled()
  })

  it('moves focus to the input when Send or Retry is pressed, since both disable while answering', () => {
    const onAsk = vi.fn()
    render(
      <AskPanel
        {...baseProps({ onAsk, askHistory: [{ id: 1, question: 'Who owns the FAQ?', error: 'The model stopped.' }] })}
      />,
    )
    const input = screen.getByPlaceholderText('Ask a question')
    const retry = screen.getByRole('button', { name: 'Retry' })
    retry.focus()
    fireEvent.click(retry)
    expect(onAsk).toHaveBeenCalledWith('Who owns the FAQ?')
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: 'And the rollout?' } })
    const send = screen.getByRole('button', { name: 'Send question' })
    send.focus()
    fireEvent.click(send)
    expect(input).toHaveFocus()
  })

  // `askHistory` arrives newest-first. The panel reads as a conversation,
  // so the latest exchange sits last, next to the input.
  it('renders history as a conversation, oldest first', () => {
    render(
      <AskPanel
        {...baseProps({
          askHistory: [
            { id: 2, question: 'What did they decide about the rollout?', answer: 'A phased EU-first rollout.' },
            { id: 1, question: 'Who owns the FAQ doc?', answer: 'Speaker 3, due Friday.' },
          ],
        })}
      />,
    )
    const questions = screen.getAllByText(/What did they decide|Who owns the FAQ/)
    expect(questions[0]).toHaveTextContent('Who owns the FAQ doc?')
    expect(questions[1]).toHaveTextContent('What did they decide about the rollout?')
    expect(screen.getByText('A phased EU-first rollout.')).toBeInTheDocument()
    expect(screen.getByText('Speaker 3, due Friday.')).toBeInTheDocument()
  })

    it('submits the trimmed question and clears the input on Enter', () => {
      const onAsk = vi.fn()
      render(<AskPanel {...baseProps({ onAsk })} />)
      const input = screen.getByPlaceholderText('Ask a question')

      fireEvent.change(input, { target: { value: '  What did they decide?  ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onAsk).toHaveBeenCalledWith('What did they decide?')
      expect(input).toHaveValue('')
    })

    it('does not submit a blank/whitespace-only question', () => {
      const onAsk = vi.fn()
      render(<AskPanel {...baseProps({ onAsk })} />)
      const input = screen.getByPlaceholderText('Ask a question')

      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onAsk).not.toHaveBeenCalled()
    })

    it('makes the input read-only (without the "answering" spinner) while llmBusy is true for a different flow', () => {
      render(<AskPanel {...baseProps({ askStatus: 'idle', llmBusy: true })} />)
      expect(screen.getByPlaceholderText('Ask a question')).toHaveAttribute('readonly')
      expect(screen.getByText('Waiting for the current generation…')).toBeInTheDocument()
    })

    it('does not show the "waiting" hint while this note\'s own ask is the one running', () => {
      render(<AskPanel {...baseProps({ askStatus: 'running', llmBusy: true })} />)
      expect(screen.queryByText('Waiting for the current generation…')).not.toBeInTheDocument()
    })

    it('leaves the input enabled and shows no hint when idle and nothing is busy', () => {
      render(<AskPanel {...baseProps({ askStatus: 'idle', llmBusy: false })} />)
      expect(screen.getByPlaceholderText('Ask a question')).not.toHaveAttribute('readonly')
      expect(screen.queryByText('Waiting for the current generation…')).not.toBeInTheDocument()
    })

    it('renders [mm:ss] citations as clickable buttons that call onSeekCitation with the right seconds', () => {
      const onSeekCitation = vi.fn()
      render(
        <AskPanel
          {...baseProps({
            askHistory: [{ id: 1, question: 'When was pricing locked?', answer: 'Pricing was locked at [01:34] during the call.' }],
            onSeekCitation,
          })}
        />,
      )
      const citation = screen.getByRole('button', { name: 'Play from 01:34' })
      fireEvent.click(citation)
      expect(onSeekCitation).toHaveBeenCalledWith(94)
    })

    it('gives each citation button an aria-label matching TranscriptList\'s "Play from {mm:ss}" convention', () => {
      render(
        <AskPanel
          {...baseProps({
            askHistory: [{ id: 1, question: 'When was pricing locked?', answer: 'Pricing was locked at [01:34] during the call.' }],
          })}
        />,
      )
      expect(screen.getByRole('button', { name: 'Play from 01:34' })).toBeInTheDocument()
    })

    it('disables citation buttons and does not call onSeekCitation when the note is not seekable (e.g. swept or failed-to-load audio)', () => {
      const onSeekCitation = vi.fn()
      render(
        <AskPanel
          {...baseProps({
            askHistory: [{ id: 1, question: 'When was pricing locked?', answer: 'Pricing was locked at [01:34] during the call.' }],
            seekable: false,
            onSeekCitation,
          })}
        />,
      )
      const citation = screen.getByRole('button', { name: 'Play from 01:34' })
      expect(citation).toBeDisabled()
      expect(citation).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(citation)
      expect(onSeekCitation).not.toHaveBeenCalled()
    })

    it('citation buttons are enabled and clickable when the note is seekable', () => {
      const onSeekCitation = vi.fn()
      render(
        <AskPanel
          {...baseProps({
            askHistory: [{ id: 1, question: 'When was pricing locked?', answer: 'Pricing was locked at [01:34] during the call.' }],
            seekable: true,
            onSeekCitation,
          })}
        />,
      )
      const citation = screen.getByRole('button', { name: 'Play from 01:34' })
      expect(citation).not.toBeDisabled()
      fireEvent.click(citation)
      expect(onSeekCitation).toHaveBeenCalledWith(94)
    })

    it('renders an answer with no citations as plain text with no extra buttons', () => {
      render(
        <AskPanel
          {...baseProps({ askHistory: [{ id: 1, question: 'What happened?', answer: "The transcript doesn't cover that." }] })}
        />,
      )
      expect(screen.getByText("The transcript doesn't cover that.")).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Play from \d{1,2}:\d{2}$/ })).not.toBeInTheDocument()
    })

    it('shows an inline error and a Retry button for a failed entry, which re-asks the same question', () => {
      const onAsk = vi.fn()
      render(
        <AskPanel
          {...baseProps({
            askHistory: [{ id: 1, question: 'What did they discuss?', error: 'The transcript doesn\'t cover that.' }],
            onAsk,
          })}
        />,
      )
      expect(screen.getByRole('alert')).toHaveTextContent("The transcript doesn't cover that.")
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(onAsk).toHaveBeenCalledWith('What did they discuss?')
    })

    it('disables the Retry button while busy', () => {
      render(
        <AskPanel
          {...baseProps({
            askHistory: [{ id: 1, question: 'What did they discuss?', error: 'boom' }],
            llmBusy: true,
          })}
        />,
      )
      expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    })

    it('does not submit on the Enter that confirms an IME composition (e.g. CJK input)', () => {
      const onAsk = vi.fn()
      render(<AskPanel {...baseProps({ onAsk })} />)
      const input = screen.getByPlaceholderText('Ask a question')

      fireEvent.change(input, { target: { value: '日本語' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

      expect(onAsk).not.toHaveBeenCalled()
      expect(input).toHaveValue('日本語')
    })

    it('renders no history cards when askHistory is empty', () => {
      render(<AskPanel {...baseProps({ askHistory: [] })} />)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    })
})
