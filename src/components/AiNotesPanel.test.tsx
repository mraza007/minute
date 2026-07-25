import { fireEvent, render, screen } from '@testing-library/react'
import type { SummaryDoc } from '../ipc/types'
import { AiNotesPanel, type AiNotesPanelProps } from './AiNotesPanel'

function summaryFixture(overrides: Partial<SummaryDoc> = {}): SummaryDoc {
  return {
    summary: 'Acme is ready to expand the pilot from 20 to 200 seats in Q3.',
    decisions: ['Pilot expands to 200 seats in Q3 if security review passes.', "Exports will match Acme's Monday digest template."],
    actionItems: [
      { text: 'Send security documentation to Tom before procurement kickoff', done: true },
      { text: 'Set up Markdown export matching Acme Monday digest template', done: false },
    ],
    ...overrides,
  }
}

function baseProps(overrides: Partial<AiNotesPanelProps> = {}): AiNotesPanelProps {
  return {
    summary: summaryFixture(),
    status: 'idle',
    error: undefined,
    modelName: 'Qwen3.5-4B',
    llmInstalled: true,
    askHistory: [],
    askStatus: 'idle',
    llmBusy: false,
    seekable: true,
    onToggleAction: vi.fn(),
    onRegenerate: vi.fn(),
    onCopy: vi.fn(),
    onExport: vi.fn(),
    onGoSettings: vi.fn(),
    onAsk: vi.fn(),
    onSeekCitation: vi.fn(),
    ...overrides,
  }
}

describe('AiNotesPanel', () => {
  it('shows the header with "AI notes" and "generated locally"', () => {
    render(<AiNotesPanel {...baseProps()} />)
    expect(screen.getByText('AI notes')).toBeInTheDocument()
    expect(screen.getByText('generated locally')).toBeInTheDocument()
  })

  describe('with a real summary', () => {
    it('renders the summary text', () => {
      render(<AiNotesPanel {...baseProps()} />)
      expect(screen.getByText(summaryFixture().summary)).toBeInTheDocument()
    })

    it('renders each decision as a bullet', () => {
      render(<AiNotesPanel {...baseProps()} />)
      for (const decision of summaryFixture().decisions) {
        expect(screen.getByText(decision)).toBeInTheDocument()
      }
    })

    it('omits the DECISIONS card when decisions is empty', () => {
      render(<AiNotesPanel {...baseProps({ summary: summaryFixture({ decisions: [] }) })} />)
      expect(screen.queryByText('DECISIONS')).not.toBeInTheDocument()
    })

    it('renders action items with correct checked state, wired to onToggleAction', () => {
      const onToggleAction = vi.fn()
      render(<AiNotesPanel {...baseProps({ onToggleAction })} />)
      const checkboxes = screen.getAllByRole('checkbox')
      expect(checkboxes).toHaveLength(2)
      expect(checkboxes[0]).toBeChecked()
      expect(checkboxes[1]).not.toBeChecked()

      fireEvent.click(checkboxes[1])
      expect(onToggleAction).toHaveBeenCalledWith(1, true)
    })

    it('disables the action item checkboxes while status is running', () => {
      render(<AiNotesPanel {...baseProps({ status: 'running' })} />)
      for (const checkbox of screen.getAllByRole('checkbox')) {
        expect(checkbox).toBeDisabled()
      }
    })

    it('leaves the action item checkboxes enabled when not running', () => {
      render(<AiNotesPanel {...baseProps({ status: 'idle' })} />)
      for (const checkbox of screen.getAllByRole('checkbox')) {
        expect(checkbox).not.toBeDisabled()
      }
    })

    it('renders a done action item with line-through styling', () => {
      render(<AiNotesPanel {...baseProps()} />)
      const doneText = screen.getByText(summaryFixture().actionItems[0].text)
      expect(doneText).toHaveStyle({ textDecoration: 'line-through' })
    })

    it('omits the ACTION ITEMS card when action items is empty', () => {
      render(<AiNotesPanel {...baseProps({ summary: summaryFixture({ actionItems: [] }) })} />)
      expect(screen.queryByText('ACTION ITEMS')).not.toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })

    it('calls onCopy/onExport/onRegenerate when their buttons are clicked', () => {
      const onCopy = vi.fn()
      const onExport = vi.fn()
      const onRegenerate = vi.fn()
      render(<AiNotesPanel {...baseProps({ onCopy, onExport, onRegenerate })} />)

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expect(onCopy).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Export .md' }))
      expect(onExport).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
      expect(onRegenerate).toHaveBeenCalledTimes(1)
    })

    it('disables the Regenerate button while status is running', () => {
      render(<AiNotesPanel {...baseProps({ status: 'running' })} />)
      expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled()
    })

    it('does not disable Regenerate when idle', () => {
      render(<AiNotesPanel {...baseProps({ status: 'idle' })} />)
      expect(screen.getByRole('button', { name: 'Regenerate' })).not.toBeDisabled()
    })
  })

  describe('summarizing banner', () => {
    it('shows "Summarizing on-device — {modelName}" while status is running', () => {
      render(<AiNotesPanel {...baseProps({ status: 'running', modelName: 'Qwen3.5-4B' })} />)
      expect(screen.getByText('Summarizing on-device — Qwen3.5-4B')).toBeInTheDocument()
    })

    it('hides the banner when status is not running', () => {
      render(<AiNotesPanel {...baseProps({ status: 'idle' })} />)
      expect(screen.queryByText(/Summarizing on-device/)).not.toBeInTheDocument()
    })
  })

  describe('error state', () => {
    it('shows a red-tint error card with the error message and a Regenerate suggestion when status is error', () => {
      const onRegenerate = vi.fn()
      render(<AiNotesPanel {...baseProps({ status: 'error', error: 'model failed to load', onRegenerate })} />)

      expect(screen.getByText('SUMMARY FAILED')).toBeInTheDocument()
      expect(screen.getByText('model failed to load')).toBeInTheDocument()

      const regenerateButtons = screen.getAllByRole('button', { name: 'Regenerate' })
      fireEvent.click(regenerateButtons[0])
      expect(onRegenerate).toHaveBeenCalled()
    })

    it('falls back to a generic message when error is not provided', () => {
      render(<AiNotesPanel {...baseProps({ status: 'error', error: undefined })} />)
      expect(screen.getByText('Something went wrong generating this summary.')).toBeInTheDocument()
    })

    it('still shows a stale summary underneath the error card when one exists', () => {
      render(<AiNotesPanel {...baseProps({ status: 'error', error: 'boom', summary: summaryFixture() })} />)
      expect(screen.getByText('SUMMARY FAILED')).toBeInTheDocument()
      expect(screen.getByText(summaryFixture().summary)).toBeInTheDocument()
    })
  })

  describe('empty state (no summary yet)', () => {
    it('shows a "Generate summary" button when an LLM is installed', () => {
      const onRegenerate = vi.fn()
      render(<AiNotesPanel {...baseProps({ summary: null, status: 'idle', llmInstalled: true, onRegenerate })} />)

      const button = screen.getByRole('button', { name: 'Generate summary' })
      fireEvent.click(button)
      expect(onRegenerate).toHaveBeenCalledTimes(1)
    })

    it('shows the no-LLM placeholder with a "Download a summary model" link when no LLM is installed', () => {
      const onGoSettings = vi.fn()
      render(<AiNotesPanel {...baseProps({ summary: null, status: 'idle', llmInstalled: false, onGoSettings })} />)

      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
      // Two links share this name — the summary placeholder's, and the ask
      // section's own no-LLM placeholder (see the "ask your notes" describe
      // block below) — both call the same `onGoSettings`.
      const links = screen.getAllByRole('button', { name: 'Download a summary model' })
      expect(links).toHaveLength(2)
      fireEvent.click(links[0])
      expect(onGoSettings).toHaveBeenCalledTimes(1)
    })

    it('shows neither the generate button nor the placeholder while status is running', () => {
      render(<AiNotesPanel {...baseProps({ summary: null, status: 'running', llmInstalled: true })} />)
      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
    })

    it('shows nothing action/summary-shaped when status is error (the error card owns that state)', () => {
      render(<AiNotesPanel {...baseProps({ summary: null, status: 'error', error: 'boom', llmInstalled: true })} />)
      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
    })
  })

  describe('ask your notes', () => {
    it('shows the section header and an input with the right placeholder', () => {
      render(<AiNotesPanel {...baseProps()} />)
      expect(screen.getByText('ASK YOUR NOTES')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Ask about this meeting…')).toBeInTheDocument()
    })

    it('shows the no-LLM placeholder instead of the input when no LLM is installed', () => {
      render(<AiNotesPanel {...baseProps({ llmInstalled: false })} />)
      expect(screen.getByText('ASK YOUR NOTES')).toBeInTheDocument()
      expect(screen.getByText('Ask questions about this meeting on-device once a summary model is installed.')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('Ask about this meeting…')).not.toBeInTheDocument()
    })

    it('submits the trimmed question and clears the input on Enter', () => {
      const onAsk = vi.fn()
      render(<AiNotesPanel {...baseProps({ onAsk })} />)
      const input = screen.getByPlaceholderText('Ask about this meeting…')

      fireEvent.change(input, { target: { value: '  What did they decide?  ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onAsk).toHaveBeenCalledWith('What did they decide?')
      expect(input).toHaveValue('')
    })

    it('does not submit a blank/whitespace-only question', () => {
      const onAsk = vi.fn()
      render(<AiNotesPanel {...baseProps({ onAsk })} />)
      const input = screen.getByPlaceholderText('Ask about this meeting…')

      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onAsk).not.toHaveBeenCalled()
    })

    it('disables the input and shows a spinner while askStatus is running', () => {
      render(<AiNotesPanel {...baseProps({ askStatus: 'running' })} />)
      expect(screen.getByPlaceholderText('Ask about this meeting…')).toBeDisabled()
    })

    it('disables the input (without the "answering" spinner) while llmBusy is true for a different flow', () => {
      render(<AiNotesPanel {...baseProps({ askStatus: 'idle', llmBusy: true })} />)
      expect(screen.getByPlaceholderText('Ask about this meeting…')).toBeDisabled()
      expect(screen.getByText('Waiting for the current generation…')).toBeInTheDocument()
    })

    it('does not show the "waiting" hint while this note\'s own ask is the one running', () => {
      render(<AiNotesPanel {...baseProps({ askStatus: 'running', llmBusy: true })} />)
      expect(screen.queryByText('Waiting for the current generation…')).not.toBeInTheDocument()
    })

    it('leaves the input enabled and shows no hint when idle and nothing is busy', () => {
      render(<AiNotesPanel {...baseProps({ askStatus: 'idle', llmBusy: false })} />)
      expect(screen.getByPlaceholderText('Ask about this meeting…')).not.toBeDisabled()
      expect(screen.queryByText('Waiting for the current generation…')).not.toBeInTheDocument()
    })

    it('announces "Answering…" via the persistent status span while askStatus is running', () => {
      render(<AiNotesPanel {...baseProps({ askStatus: 'running' })} />)
      expect(screen.getByRole('status')).toHaveTextContent('Answering…')
    })

    it('renders history newest-first with the question and plain-text answer', () => {
      render(
        <AiNotesPanel
          {...baseProps({
            askHistory: [
              { id: 2, question: 'What did they decide about the rollout?', answer: 'A phased EU-first rollout.' },
              { id: 1, question: 'Who owns the FAQ doc?', answer: 'Speaker 3, due Friday.' },
            ],
          })}
        />,
      )
      const questions = screen.getAllByText(/What did they decide|Who owns the FAQ/)
      expect(questions[0]).toHaveTextContent('What did they decide about the rollout?')
      expect(questions[1]).toHaveTextContent('Who owns the FAQ doc?')
      expect(screen.getByText('A phased EU-first rollout.')).toBeInTheDocument()
      expect(screen.getByText('Speaker 3, due Friday.')).toBeInTheDocument()
    })

    it('renders [mm:ss] citations as clickable buttons that call onSeekCitation with the right seconds', () => {
      const onSeekCitation = vi.fn()
      render(
        <AiNotesPanel
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
        <AiNotesPanel
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
        <AiNotesPanel
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
        <AiNotesPanel
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
        <AiNotesPanel
          {...baseProps({ askHistory: [{ id: 1, question: 'What happened?', answer: "The transcript doesn't cover that." }] })}
        />,
      )
      expect(screen.getByText("The transcript doesn't cover that.")).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Play from \d{1,2}:\d{2}$/ })).not.toBeInTheDocument()
    })

    it('shows an inline error and a Retry button for a failed entry, which re-asks the same question', () => {
      const onAsk = vi.fn()
      render(
        <AiNotesPanel
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
        <AiNotesPanel
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
      render(<AiNotesPanel {...baseProps({ onAsk })} />)
      const input = screen.getByPlaceholderText('Ask about this meeting…')

      fireEvent.change(input, { target: { value: '日本語' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

      expect(onAsk).not.toHaveBeenCalled()
      expect(input).toHaveValue('日本語')
    })

    it('renders no history cards when askHistory is empty', () => {
      render(<AiNotesPanel {...baseProps({ askHistory: [] })} />)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    })
  })
})
