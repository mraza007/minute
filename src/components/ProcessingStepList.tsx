import type { ProcessingStep } from './processingSteps'

export interface ProcessingStepListProps {
  steps: ProcessingStep[]
  /** Cancels the summary. Shown only on a step the model marked skippable. */
  onSkipSummary?: () => void
  /** One line under the steps, such as what the user can do meanwhile. */
  note?: string
}

function StepMark({ state }: { state: ProcessingStep['state'] }) {
  if (state === 'done') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    )
  }
  return <span className="processing-ring" aria-hidden="true" />
}

/** What a finished recording still has to go through, one row per stage. */
export function ProcessingStepList({ steps, onSkipSummary, note }: ProcessingStepListProps) {
  return (
    <section className="processing" aria-label="Finishing this note">
      <ol className="processing-list" aria-live="polite">
        {steps.map(step => (
          <li key={step.id} data-state={step.state}>
            <span className="processing-mark"><StepMark state={step.state} /></span>
            <span className="processing-label">{step.label}</span>
            {step.skippable && onSkipSummary && (
              <button type="button" className="message-action" onClick={onSkipSummary}>Skip summary</button>
            )}
          </li>
        ))}
      </ol>
      {note && <p className="processing-note">{note}</p>}
    </section>
  )
}
