import type { SummaryStyle } from '../ipc/types'

export type ProcessingStepId = 'audio' | 'transcript' | 'speakers' | 'summary'
export type ProcessingStepState = 'done' | 'active' | 'waiting'

export interface ProcessingStep {
  id: ProcessingStepId
  state: ProcessingStepState
  label: string
  /** Set only while cancelling the summary would do something. */
  skippable?: true
}

/**
 * Where a finished recording is on its way to a full note. Each field is
 * one stage's own state, so two stages cannot both claim to be running.
 */
export interface ProcessingInput {
  /** `'saved'` once the audio file is closed and the transcript is complete. */
  capture: 'saving' | 'finalizing' | 'saved'
  /** Speaker detection: not part of this note, due later, or running. */
  speakers: 'none' | 'expected' | 'running'
  /** Summary: not part of this note, due later, waiting in the queue, or running. */
  summary: 'none' | 'expected' | 'queued' | 'running'
  summaryStyle: SummaryStyle
}

const STYLE_NAME: Record<SummaryStyle, string> = {
  short: 'Short',
  standard: 'Standard',
  detailed: 'Detailed',
}

/**
 * The steps to show, in order. At most one is active: a stage only runs
 * once every stage before it is done.
 */
export function processingSteps(input: ProcessingInput): ProcessingStep[] {
  const steps: ProcessingStep[] = [
    input.capture === 'saving'
      ? { id: 'audio', state: 'active', label: 'Saving audio…' }
      : { id: 'audio', state: 'done', label: 'Audio saved' },
    input.capture === 'saved'
      ? { id: 'transcript', state: 'done', label: 'Transcript finished' }
      : input.capture === 'finalizing'
        ? { id: 'transcript', state: 'active', label: 'Finishing transcript…' }
        : { id: 'transcript', state: 'waiting', label: 'Transcript' },
  ]
  const captured = input.capture === 'saved'

  const speakersRunning = captured && input.speakers === 'running'
  if (input.speakers !== 'none') {
    steps.push(
      speakersRunning
        ? { id: 'speakers', state: 'active', label: 'Finding speakers…' }
        : { id: 'speakers', state: 'waiting', label: 'Finding speakers' },
    )
  }

  if (input.summary !== 'none') {
    const name = `${STYLE_NAME[input.summaryStyle]} summary`
    const skippable = input.summary === 'queued' || input.summary === 'running'
    const step: ProcessingStep =
      captured && !speakersRunning && input.summary === 'running'
        ? { id: 'summary', state: 'active', label: `Writing the ${name.toLowerCase()}…` }
        : { id: 'summary', state: 'waiting', label: `${name} · ${input.summary === 'queued' ? 'queued' : 'next'}` }
    steps.push(skippable ? { ...step, skippable: true } : step)
  }

  return steps
}

export interface NoteProcessingInput {
  /** Whether this note is the recording that just stopped in this session. */
  justRecorded: boolean
  hasSummary: boolean
  speakersRunning: boolean
  summaryStatus: 'idle' | 'queued' | 'running' | 'error'
  /** Whether a summary model is installed, so a summary follows speaker detection. */
  summaryModelInstalled: boolean
  summaryStyle: SummaryStyle
}

/**
 * The steps a just-recorded note still has ahead of it, or `null` once
 * nothing is pending. Only the note that just stopped gets them: a summary
 * or speaker pass started by hand on an older note keeps its own controls.
 */
export function noteProcessingSteps(input: NoteProcessingInput): ProcessingStep[] | null {
  if (!input.justRecorded || input.hasSummary) return null
  const pendingSummary =
    input.summaryStatus === 'queued' || input.summaryStatus === 'running' ? input.summaryStatus : null
  if (!input.speakersRunning && pendingSummary === null) return null
  return processingSteps({
    capture: 'saved',
    speakers: input.speakersRunning ? 'running' : 'none',
    summary: pendingSummary ?? (input.summaryStatus === 'idle' && input.summaryModelInstalled ? 'expected' : 'none'),
    summaryStyle: input.summaryStyle,
  })
}
