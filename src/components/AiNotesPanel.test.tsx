import { fireEvent, render, screen } from '@testing-library/react'
import { initialActions } from '../data/demo'
import { AiNotesPanel } from './AiNotesPanel'

const base = {
  summarizing: false,
  actions: initialActions,
  toggleAction: vi.fn(),
  asked: false,
  askText: 'What did we promise Acme?',
  askDraft: '',
  setAskDraft: vi.fn(),
  ask: vi.fn(),
}

describe('AiNotesPanel', () => {
  it('renders the three demo action items with correct checked state', () => {
    render(<AiNotesPanel {...base} />)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(3)
    expect(checkboxes[0]).toBeChecked()
    expect(checkboxes[1]).not.toBeChecked()
    expect(checkboxes[2]).not.toBeChecked()
  })

  it('calls toggleAction with the clicked index when a checkbox is clicked', () => {
    const toggleAction = vi.fn()
    render(<AiNotesPanel {...base} toggleAction={toggleAction} />)
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1])
    expect(toggleAction).toHaveBeenCalledWith(1)
  })

  it('renders a done action item with line-through styling', () => {
    render(<AiNotesPanel {...base} />)
    const doneText = screen.getByText(initialActions[0].text)
    expect(doneText).toHaveStyle({ textDecoration: 'line-through' })
  })

  it('shows the summarizing banner with model name when summarizing', () => {
    render(<AiNotesPanel {...base} summarizing={true} />)
    expect(screen.getByText('Summarizing on-device — Qwen3.5-4B')).toBeInTheDocument()
  })

  it('hides the summarizing banner when not summarizing', () => {
    render(<AiNotesPanel {...base} summarizing={false} />)
    expect(screen.queryByText('Summarizing on-device — Qwen3.5-4B')).not.toBeInTheDocument()
  })

  it('calls setAskDraft when typing in the ask input', () => {
    const setAskDraft = vi.fn()
    render(<AiNotesPanel {...base} setAskDraft={setAskDraft} />)
    fireEvent.change(screen.getByPlaceholderText('e.g. what did we promise Acme?'), { target: { value: 'hi' } })
    expect(setAskDraft).toHaveBeenCalledWith('hi')
  })

  it('calls ask when Enter is pressed in the ask input', () => {
    const ask = vi.fn()
    render(<AiNotesPanel {...base} ask={ask} />)
    fireEvent.keyDown(screen.getByPlaceholderText('e.g. what did we promise Acme?'), { key: 'Enter' })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('calls ask when the send button is clicked', () => {
    const ask = vi.fn()
    render(<AiNotesPanel {...base} ask={ask} />)
    fireEvent.click(screen.getByRole('button', { name: '' }))
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('shows the answer card with the asked question and answer text when asked', () => {
    render(<AiNotesPanel {...base} asked={true} askText="What did we promise Acme?" />)
    expect(screen.getByText('“What did we promise Acme?”')).toBeInTheDocument()
    expect(screen.getByText('Answered from 2 notes · on-device')).toBeInTheDocument()
  })

  it('hides the answer card when not asked', () => {
    render(<AiNotesPanel {...base} asked={false} />)
    expect(screen.queryByText('Answered from 2 notes · on-device')).not.toBeInTheDocument()
  })
})
