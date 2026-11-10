import { fireEvent, render, screen } from '@testing-library/react'
import type { SummaryDoc } from '../ipc/types'
import { NoteSummary, type NoteSummaryProps } from './NoteSummary'

function summaryFixture(overrides: Partial<SummaryDoc> = {}): SummaryDoc {
  return {
    summary: 'Acme is ready to expand the pilot from 20 to 200 seats in Q3.',
    topics: [],
    decisions: ['Pilot expands to 200 seats in Q3 if security review passes.', "Exports will match Acme's Monday digest template."],
    actionItems: [
      { text: 'Send security documentation to Tom before procurement kickoff', done: true },
      { text: 'Set up Markdown export matching Acme Monday digest template', done: false },
    ],
    ...overrides,
  }
}

function baseProps(overrides: Partial<NoteSummaryProps> = {}): NoteSummaryProps {
  return {
    summary: summaryFixture(),
    status: 'idle',
    error: undefined,
    modelName: 'Qwen3.5-4B',
    llmInstalled: true,
    onGenerate: vi.fn(),
    onCancel: vi.fn(),
    onToggleAction: vi.fn(),
    onGoSettings: vi.fn(),
    ...overrides,
  }
}

describe('NoteSummary', () => {
  describe('with a summary', () => {
    it('renders the summary text', () => {
      render(<NoteSummary {...baseProps()} />)
      expect(screen.getByText(summaryFixture().summary)).toBeInTheDocument()
    })

    it('renders each decision in a numbered list', () => {
      render(<NoteSummary {...baseProps()} />)
      const items = screen.getAllByRole('listitem').filter(item => item.closest('ol'))
      expect(items.map(item => item.textContent)).toEqual(summaryFixture().decisions)
    })

    it('says so when no decisions or action items were found', () => {
      render(<NoteSummary {...baseProps({ summary: summaryFixture({ decisions: [], actionItems: [] }) })} />)
      expect(screen.getByText('No decisions were identified.')).toBeInTheDocument()
      expect(screen.getByText('No action items were identified.')).toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    })

    // Issue #14: the Detailed style's per-topic breakdown.
    it('renders each topic with its title and body', () => {
      const summary = summaryFixture({
        topics: [
          { title: 'Pricing', summary: 'Locked at $29. Annual discount deferred.' },
          { title: 'Rollout', summary: 'EU first, then US.' },
        ],
      })
      render(<NoteSummary {...baseProps({ summary })} />)
      expect(screen.getByRole('heading', { name: 'Topics' })).toBeInTheDocument()
      expect(screen.getByText('Pricing')).toBeInTheDocument()
      expect(screen.getByText('Locked at $29. Annual discount deferred.')).toBeInTheDocument()
      expect(screen.getByText('Rollout')).toBeInTheDocument()
      expect(screen.getByText('EU first, then US.')).toBeInTheDocument()
    })

    // Short and Standard summaries never carry topics, so they get no
    // empty section heading for it.
    it('omits the Topics section when there are no topics', () => {
      render(<NoteSummary {...baseProps({ summary: summaryFixture({ topics: [] }) })} />)
      expect(screen.queryByRole('heading', { name: 'Topics' })).not.toBeInTheDocument()
    })

    it('renders a title-only topic without an empty body', () => {
      const summary = summaryFixture({ topics: [{ title: 'Pricing', summary: '' }] })
      const { container } = render(<NoteSummary {...baseProps({ summary })} />)
      expect(screen.getByText('Pricing')).toBeInTheDocument()
      expect(container.querySelectorAll('.note-topic p')).toHaveLength(0)
    })

    it('names the length the summary was made at', () => {
      const { rerender } = render(<NoteSummary {...baseProps({ summary: summaryFixture({ style: 'short' }) })} />)
      expect(screen.getByText('Short · made on this Mac')).toBeInTheDocument()
      rerender(<NoteSummary {...baseProps({ summary: summaryFixture({ style: 'standard' }) })} />)
      expect(screen.getByText('Standard · made on this Mac')).toBeInTheDocument()
      rerender(<NoteSummary {...baseProps({ summary: summaryFixture({ style: 'detailed' }) })} />)
      expect(screen.getByText('Detailed · made on this Mac')).toBeInTheDocument()
    })

    it('names no length for an older summary that did not record one, even with topics', () => {
      render(<NoteSummary {...baseProps({ summary: summaryFixture({ topics: [{ title: 'Pricing', summary: 'Locked.' }] }) })} />)
      expect(screen.getByText('Made on this Mac')).toBeInTheDocument()
    })

    // Issue #41: a cut transcript must say so on the page.
    it('says when the summary covers only part of a long meeting', () => {
      render(<NoteSummary {...baseProps({ summary: summaryFixture({ truncated: true }) })} />)
      expect(screen.getByText(/too long for the summary model's memory/)).toBeInTheDocument()
    })

    it('renders action items with their checked state, wired to onToggleAction', () => {
      const onToggleAction = vi.fn()
      render(<NoteSummary {...baseProps({ onToggleAction })} />)
      const checkboxes = screen.getAllByRole('checkbox')
      expect(checkboxes).toHaveLength(2)
      expect(checkboxes[0]).toBeChecked()
      expect(checkboxes[1]).not.toBeChecked()

      fireEvent.click(checkboxes[1])
      expect(onToggleAction).toHaveBeenCalledWith(1, true)
    })

    it('leaves the action item checkboxes enabled when idle', () => {
      render(<NoteSummary {...baseProps({ status: 'idle' })} />)
      for (const checkbox of screen.getAllByRole('checkbox')) {
        expect(checkbox).not.toBeDisabled()
      }
    })

    it('regenerates from the Summary heading', () => {
      const onGenerate = vi.fn()
      render(<NoteSummary {...baseProps({ onGenerate })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
      expect(onGenerate).toHaveBeenCalledTimes(1)
    })
  })

  describe('while a summary runs', () => {
    it('names the model that is summarizing', () => {
      render(<NoteSummary {...baseProps({ status: 'running', modelName: 'Qwen3.5-4B' })} />)
      expect(screen.getByText('Summarizing on this Mac · Qwen3.5-4B')).toBeInTheDocument()
    })

    it('shows no running line when idle', () => {
      render(<NoteSummary {...baseProps({ status: 'idle' })} />)
      expect(screen.queryByText(/Summarizing on this Mac/)).not.toBeInTheDocument()
    })

    // Issue #30: before Cancel existed, the only way out of a stuck
    // generation was restarting the app.
    it('offers Cancel in place of Regenerate, wired to onCancel', () => {
      const onCancel = vi.fn()
      render(<NoteSummary {...baseProps({ status: 'running', onCancel })} />)
      expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onCancel).toHaveBeenCalledTimes(1)
    })

    it('offers no Cancel while idle', () => {
      render(<NoteSummary {...baseProps({ status: 'idle' })} />)
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    })

    it('disables the action item checkboxes', () => {
      render(<NoteSummary {...baseProps({ status: 'running' })} />)
      for (const checkbox of screen.getAllByRole('checkbox')) {
        expect(checkbox).toBeDisabled()
      }
    })

    it('keeps the transcript promise and offers nothing to generate when there is no summary yet', () => {
      render(<NoteSummary {...baseProps({ summary: null, status: 'running' })} />)
      expect(screen.getByText('The transcript stays available while Minute writes the summary.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
    })
  })

  // Issue #11: a note waiting behind another generation.
  describe('while a summary is queued', () => {
    it('says the note is queued and will start on its own', () => {
      render(<NoteSummary {...baseProps({ status: 'queued' })} />)
      expect(screen.getByText('Queued. Starts when the engine is free.')).toBeInTheDocument()
    })

    it('does not claim to be summarizing', () => {
      render(<NoteSummary {...baseProps({ status: 'queued' })} />)
      expect(screen.queryByText(/Summarizing on this Mac/)).not.toBeInTheDocument()
    })

    // Asking again for a queued note would schedule work that is already
    // scheduled.
    it('offers neither Regenerate nor Generate summary', () => {
      const { rerender } = render(<NoteSummary {...baseProps({ status: 'queued' })} />)
      expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument()
      rerender(<NoteSummary {...baseProps({ status: 'queued', summary: null })} />)
      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
      expect(screen.getByText('Minute is busy with a recording or another summary. This one starts on its own.')).toBeInTheDocument()
    })

    it('disables the action item checkboxes', () => {
      render(<NoteSummary {...baseProps({ status: 'queued' })} />)
      for (const checkbox of screen.getAllByRole('checkbox')) {
        expect(checkbox).toBeDisabled()
      }
    })

    // Issue #30: a queued note can be pulled back out of the queue.
    it('offers Cancel, wired to onCancel', () => {
      const onCancel = vi.fn()
      render(<NoteSummary {...baseProps({ status: 'queued', onCancel })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onCancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('after a failed summary', () => {
    it('shows the error with a retry', () => {
      const onGenerate = vi.fn()
      render(<NoteSummary {...baseProps({ status: 'error', error: 'model failed to load', onGenerate })} />)
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('Summary unavailable.')
      expect(alert).toHaveTextContent('model failed to load')
      fireEvent.click(screen.getByRole('button', { name: 'Retry summary' }))
      expect(onGenerate).toHaveBeenCalledTimes(1)
    })

    it('falls back to a generic message when no error text is given', () => {
      render(<NoteSummary {...baseProps({ status: 'error', error: undefined })} />)
      expect(screen.getByRole('alert')).toHaveTextContent('Minute could not write the summary. The transcript and audio are still available.')
    })

    it('still shows the earlier summary, decisions, and action items underneath', () => {
      render(<NoteSummary {...baseProps({ status: 'error', error: 'boom' })} />)
      expect(screen.getByText(summaryFixture().summary)).toBeInTheDocument()
      expect(screen.getByText(summaryFixture().decisions[0])).toBeInTheDocument()
      expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    })

    it('shows one error surface and no separate Generate button when there is no summary', () => {
      render(<NoteSummary {...baseProps({ summary: null, status: 'error', error: 'boom' })} />)
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
    })
  })

  describe('with no summary yet', () => {
    it('offers Generate summary when a summary model is installed', () => {
      const onGenerate = vi.fn()
      render(<NoteSummary {...baseProps({ summary: null, onGenerate })} />)
      fireEvent.click(screen.getByRole('button', { name: 'Generate summary' }))
      expect(onGenerate).toHaveBeenCalledTimes(1)
    })

    it('points to Settings when no summary model is installed', () => {
      const onGoSettings = vi.fn()
      render(<NoteSummary {...baseProps({ summary: null, llmInstalled: false, onGoSettings })} />)
      expect(screen.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Download a summary model' }))
      expect(onGoSettings).toHaveBeenCalledTimes(1)
    })
  })
})
