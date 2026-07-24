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
    onToggleAction: vi.fn(),
    onRegenerate: vi.fn(),
    onCopy: vi.fn(),
    onExport: vi.fn(),
    onGoSettings: vi.fn(),
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
      const link = screen.getByRole('button', { name: 'Download a summary model' })
      fireEvent.click(link)
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
})
