import { noteProcessingSteps, processingSteps, type NoteProcessingInput, type ProcessingInput } from './processingSteps'

const full: ProcessingInput = { capture: 'saving', speakers: 'expected', summary: 'expected', summaryStyle: 'detailed' }

function shape(input: ProcessingInput) {
  return processingSteps(input).map(step => `${step.id}:${step.state}`)
}

describe('processingSteps', () => {
  it('walks one active step at a time from saving to the summary', () => {
    expect(shape(full)).toEqual(['audio:active', 'transcript:waiting', 'speakers:waiting', 'summary:waiting'])
    expect(shape({ ...full, capture: 'finalizing' })).toEqual(['audio:done', 'transcript:active', 'speakers:waiting', 'summary:waiting'])
    expect(shape({ ...full, capture: 'saved', speakers: 'running' })).toEqual(['audio:done', 'transcript:done', 'speakers:active', 'summary:waiting'])
    expect(shape({ ...full, capture: 'saved', speakers: 'none', summary: 'running' })).toEqual(['audio:done', 'transcript:done', 'summary:active'])
  })

  it('never shows two active steps, whatever the inputs claim', () => {
    for (const capture of ['saving', 'finalizing', 'saved'] as const) {
      for (const speakers of ['none', 'expected', 'running'] as const) {
        for (const summary of ['none', 'expected', 'queued', 'running'] as const) {
          const active = processingSteps({ capture, speakers, summary, summaryStyle: 'standard' }).filter(step => step.state === 'active')
          expect(active.length).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('leaves out the stages that are not part of this note', () => {
    expect(shape({ ...full, speakers: 'none', summary: 'none' })).toEqual(['audio:active', 'transcript:waiting'])
  })

  it('labels the steps as the design does while speakers are found', () => {
    expect(processingSteps({ ...full, capture: 'saved', speakers: 'running' }).map(step => step.label)).toEqual([
      'Audio saved',
      'Transcript finished',
      'Finding speakers…',
      'Detailed summary · next',
    ])
  })

  it('names the summary style and whether it is queued or being written', () => {
    const summaryLabel = (input: Partial<ProcessingInput>) =>
      processingSteps({ ...full, capture: 'saved', speakers: 'none', ...input }).at(-1)?.label
    expect(summaryLabel({ summary: 'queued', summaryStyle: 'short' })).toBe('Short summary · queued')
    expect(summaryLabel({ summary: 'running', summaryStyle: 'standard' })).toBe('Writing the standard summary…')
  })

  it('lets the summary be skipped only once it can be cancelled', () => {
    const skippable = (summary: ProcessingInput['summary']) =>
      processingSteps({ ...full, capture: 'saved', speakers: 'none', summary }).some(step => step.skippable)
    expect(skippable('expected')).toBe(false)
    expect(skippable('queued')).toBe(true)
    expect(skippable('running')).toBe(true)
  })
})

describe('noteProcessingSteps', () => {
  const note: NoteProcessingInput = {
    justRecorded: true,
    hasSummary: false,
    speakersRunning: false,
    summaryStatus: 'idle',
    summaryModelInstalled: true,
    summaryStyle: 'detailed',
  }
  const ids = (input: NoteProcessingInput) => noteProcessingSteps(input)?.map(step => `${step.id}:${step.state}`) ?? null

  it('shows nothing once nothing is pending', () => {
    expect(ids(note)).toBeNull()
  })

  it('shows the summary as next while speakers are found', () => {
    expect(ids({ ...note, speakersRunning: true })).toEqual(['audio:done', 'transcript:done', 'speakers:active', 'summary:waiting'])
  })

  it('promises no summary without a summary model', () => {
    expect(ids({ ...note, speakersRunning: true, summaryModelInstalled: false })).toEqual(['audio:done', 'transcript:done', 'speakers:active'])
  })

  it('follows the summary through the queue', () => {
    expect(ids({ ...note, summaryStatus: 'queued' })).toEqual(['audio:done', 'transcript:done', 'summary:waiting'])
    expect(ids({ ...note, summaryStatus: 'running' })).toEqual(['audio:done', 'transcript:done', 'summary:active'])
  })

  it('steps aside for the summary section after a failure, so its retry is reachable', () => {
    expect(ids({ ...note, summaryStatus: 'error' })).toBeNull()
  })

  it('leaves older notes and notes that already have a summary to their own controls', () => {
    expect(ids({ ...note, justRecorded: false, summaryStatus: 'running' })).toBeNull()
    expect(ids({ ...note, hasSummary: true, summaryStatus: 'running' })).toBeNull()
  })
})
