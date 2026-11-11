// Drives the mounted `<App/>` into the right on-screen state for each
// `?state=` value — entirely through the same surfaces a real user would
// use (clicks, the ⌘K keyboard shortcut, typing into the real search input)
// plus emitting the same Tauri events the real backend would during a
// recording, rather than reaching into React internals. Keeps this harness
// honest: if a capture looks right, the real app produces that screen too.

import { emit } from '@tauri-apps/api/event'
import { AURORA_ASK_ENTRIES, AURORA_NOTE_ID, PRICING_NOTE_ID, RECORDING_ELAPSED_SECONDS, RECORDING_LIVE_TURNS, RECORDING_NOTE_ID, SAM_NOTE_ID } from './demoData'
import type { ScreenshotState } from './mockIpc'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, { timeoutMs = 4000, intervalMs = 30 } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs)
  }
  return predicate()
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined
}

function dispatchCmdK(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** One `recording-state` tick as the backend sends it, shaped by the harness parameters. */
function recordingTick(params: URLSearchParams, elapsed: number, overrides: Record<string, unknown> = {}) {
  return {
    noteId: RECORDING_NOTE_ID,
    state: 'recording',
    elapsed,
    systemAudioActive: params.get('sysaudio') === '1',
    microphoneName: 'MacBook Pro Microphone',
    inputRms: 0.08,
    inputPeak: 0.42,
    inputSequence: 120,
    inputError: null,
    quietSecs: 0,
    origin: params.get('origin') === 'auto' ? { kind: 'automatic', appName: 'Microsoft Teams' } : { kind: 'manual' },
    ...overrides,
  }
}

/**
 * `?state=recording`, with:
 * - `sysaudio=1`: system audio is part of the recording.
 * - `origin=auto`: the recording was started by a detected call.
 * - `message=silent|autostop|disconnected|lag|failed`: the condition behind one status message.
 * - `restart=confirm`: press "Add system audio" and hold on its confirm step.
 * - `title=`, `marker=`: rename the recording, add a marker.
 * - `processing=saving|finalizing`: press Stop and hold on that stage.
 * - `processing=note`: press Stop and land on the note while speakers are found.
 */
async function driveRecording(params: URLSearchParams): Promise<void> {
  const startButton = await waitForButtonByText('New recording')
  startButton?.click()
  const confirmButton = await waitForButtonByText('Start recording')
  confirmButton?.click()

  await waitFor(() => document.querySelector('[data-testid="level-indicator"]') !== null)

  // Stream the demo dialogue in as individual transcript-segment events,
  // exactly like the real stt worker would, then report the elapsed time.
  for (const turn of RECORDING_LIVE_TURNS) {
    // eslint-disable-next-line no-await-in-loop
    await emit('transcript-segment', {
      noteId: RECORDING_NOTE_ID,
      speaker: turn.speaker,
      start: turn.start,
      end: turn.end,
      text: turn.text,
    })
  }
  await emit('stt-status', { noteId: RECORDING_NOTE_ID, state: 'ready', error: null })
  const message = params.get('message')
  const latestSegmentEnd = RECORDING_LIVE_TURNS[RECORDING_LIVE_TURNS.length - 1]?.end ?? 0
  const elapsed = message === 'lag' ? latestSegmentEnd + 45 : RECORDING_ELAPSED_SECONDS
  await emit('recording-state', recordingTick(params, elapsed))

  if (message === 'silent') {
    await emit('recording-state', recordingTick(params, elapsed + 1, { inputRms: 0, inputPeak: 0.12, inputSequence: 121 }))
    await emit('recording-state', recordingTick(params, elapsed + 11, { inputRms: 0, inputPeak: 0.1, inputSequence: 122, quietSecs: 40 }))
  } else if (message === 'autostop') {
    await emit('recording-state', recordingTick(params, elapsed + 1, { inputRms: 0, inputPeak: 0, inputSequence: 121, quietSecs: 120 }))
    await emit('auto-stop-state', { noteId: RECORDING_NOTE_ID, state: 'pending', secondsRemaining: 108 })
  } else if (message === 'disconnected') {
    await emit('recording-state', recordingTick(params, elapsed + 1, { inputSequence: 121, inputError: 'device disconnected' }))
  } else if (message === 'failed') {
    await emit('stt-status', { noteId: RECORDING_NOTE_ID, state: 'error', error: 'The transcription model stopped.' })
  }
  if (message) await waitFor(() => document.querySelector('.recording-message') !== null)

  if (params.get('restart') === 'confirm') {
    findButtonByText('Add system audio')?.click()
    await waitFor(() => document.querySelector('[aria-label="Confirm restart with system audio"]') !== null)
  }

  const title = params.get('title')
  if (title) {
    document.querySelector<HTMLButtonElement>('button[aria-label="Edit recording title"]')?.click()
    const input = await waitForSelector<HTMLInputElement>('input[aria-label="Recording title"]')
    if (input) {
      setNativeInputValue(input, title)
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
      await waitFor(() => document.querySelector('.recording-head h1')?.textContent === title)
    }
  }

  const marker = params.get('marker')
  if (marker) {
    findButtonByText('Add marker')?.click()
    const markerInput = await waitForSelector<HTMLInputElement>('input[aria-label="Marker label"]')
    if (markerInput) {
      setNativeInputValue(markerInput, marker)
      await waitFor(() => findButtonByText('Save marker')?.disabled === false)
      findButtonByText('Save marker')?.click()
      await waitFor(() => document.querySelector('.live-marker') !== null)
    }
  }

  const processing = params.get('processing')
  if (processing === 'note') {
    findButtonByText('Stop and')?.click()
    await waitFor(() => document.querySelector('.note-scroll') !== null)
    await emit('diar-status', { noteId: SAM_NOTE_ID, state: 'running', error: null })
    await waitFor(() => document.querySelector('.processing-list') !== null)
  } else if (processing) {
    findButtonByText('Stop and')?.click()
    await waitFor(() => document.querySelector('.processing-list') !== null)
    if (processing === 'finalizing') {
      await emit('stt-status', { noteId: RECORDING_NOTE_ID, state: 'finalizing', error: null })
    }
  }
}

async function drivePreflight(params: URLSearchParams): Promise<void> {
  const startButton = await waitForButtonByText('New recording')
  startButton?.click()
  await waitFor(() => document.querySelector('[role="dialog"][aria-labelledby="recording-preflight-title"]') !== null)
  const meter = await waitForSelector<HTMLElement>('[data-preview-session]')
  const sessionId = meter?.dataset.previewSession
  if (sessionId) {
    const clipping = params.get('meter') === 'clipping'
    const payload = {
      sessionId,
      rms: clipping ? 0.72 : 0.09,
      peak: clipping ? 0.995 : 0.42,
      error: null,
    }
    await emit('audio-input-level', payload)
    if (clipping) await emit('audio-input-level', payload)
  }
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement | undefined> {
  let found: HTMLButtonElement | undefined
  await waitFor(() => {
    found = findButtonByText(text)
    return found !== undefined
  })
  return found
}

async function drivePalette(): Promise<void> {
  await waitFor(() => document.querySelector('nav[aria-label="Notes"]') !== null)
  dispatchCmdK()
  const input = await waitForSelector<HTMLInputElement>('input[role="combobox"]')
  if (!input) return
  setNativeInputValue(input, 'pricing')
  // SearchPalette debounces 150ms before calling search_notes.
  await waitFor(() => document.querySelectorAll('#search-palette-listbox [role="option"]').length > 0, { timeoutMs: 2000 })
}

async function waitForSelector<T extends Element>(selector: string): Promise<T | null> {
  let found: T | null = null
  await waitFor(() => {
    found = document.querySelector<T>(selector)
    return found !== null
  })
  return found
}

/**
 * Sends one event until `text` is on screen. An event sent before the page's
 * async `listen()` has registered is dropped, not queued, so a single emit can
 * lose the race with the subscription.
 */
async function emitUntilShown(event: string, payload: unknown, text: string): Promise<void> {
  await waitFor(() => {
    if (document.body.textContent?.includes(text)) return true
    void emit(event, payload)
    return false
  })
}

async function drivePopup(params: URLSearchParams): Promise<void> {
  await waitFor(() => document.querySelector('[role="dialog"]') !== null)
  // Same events the backend sends the popup webview: the payload from
  // popup.rs, and for the auto-started pill the recorder's clock. The app
  // names mirror the detector's own list.
  if (params.get('kind') === 'started') {
    await emitUntilShown('meeting-popup-payload', { kind: 'started', appName: 'Microsoft Teams' }, 'Recording Microsoft Teams')
    const tick = {
      noteId: 'demo-note',
      state: 'recording',
      elapsed: 4,
      systemAudioActive: true,
      microphoneName: 'MacBook Pro Microphone',
      inputRms: 0.08,
      inputPeak: 0.4,
      inputSequence: 1,
      inputError: null,
      quietSecs: 0,
      origin: { kind: 'automatic', appName: 'Microsoft Teams' },
    }
    // The pill subscribes to the recorder clock only after its payload renders.
    await emitUntilShown('recording-state', tick, 'Started automatically · 0:04')
  } else {
    await emitUntilShown('meeting-popup-payload', { kind: 'ask', appName: 'Zoom' }, 'Zoom meeting started')
  }
}

const SETTINGS_SECTION_LABELS: Record<string, string> = {
  recording: 'Recording',
  summaries: 'Summaries',
  speakers: 'Speakers',
  models: 'Models',
  integrations: 'Integrations',
  storage: 'Storage',
  about: 'About',
}

/**
 * `?section=<id>` picks the Settings page. On Models, `&downloading=1` puts
 * one whisper.cpp file mid-download and `&consent=1` opens the
 * unknown-publisher confirm.
 */
async function driveSettings(params: URLSearchParams): Promise<void> {
  const settingsButton = await waitForButtonByText('Settings')
  settingsButton?.click()
  await waitFor(() => document.querySelector('nav[aria-label="Settings sections"]') !== null)
  const section = params.get('section') ?? 'recording'
  const label = SETTINGS_SECTION_LABELS[section]
  const navButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-nav-item')).find(b => b.textContent === label)
  navButton?.click()
  await waitFor(() => document.querySelector('.st-title')?.textContent?.startsWith(label) ?? false)

  if (section === 'models') {
    await waitFor(() => /Granite 4\.0 H Tiny|Could not reach Hugging Face/.test(document.body.textContent ?? ''))
  }
  if (section === 'models' && params.get('downloading') === '1') {
    await emit('model-download-progress', { modelId: 'hf:ggerganov/whisper.cpp/ggml-small.en.bin', downloaded: 302_000_000, total: 487_614_201 })
    await waitFor(() => document.querySelector('[role="progressbar"]') !== null)
  }
  if (section === 'models' && params.get('consent') === '1') {
    document.querySelector<HTMLButtonElement>('button[aria-label^="Download Llama 3.1 8B Instruct"]')?.click()
    await waitFor(() => findButtonByText('Download anyway') !== undefined)
  }
  if (section === 'integrations') {
    // The vault check runs on mount; wait for it so the capture shows its verdict.
    await sleep(150)
  }
}

/** `?downloading=1` starts the recommended transcription model's download part way. */
async function driveOnboarding(params: URLSearchParams): Promise<void> {
  await waitFor(() => document.body.textContent?.includes('Open Minute') ?? false)
  if (params.get('downloading') === '1') {
    await emit('model-download-progress', { modelId: 'whisper-large-v3-turbo', downloaded: 1_000_000_000, total: 1_624_555_275 })
    await waitFor(() => document.querySelector('[role="progressbar"]') !== null)
  }
}

async function driveEmpty(): Promise<void> {
  await waitFor(() => document.body.textContent?.includes('Record your first meeting') ?? false)
}

async function openFilterMenu(): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="Sort and filter notes"]')?.click()
  await waitFor(() => document.querySelector('[role="menu"][aria-label="Sort and filter notes"]') !== null)
}

async function driveSidebar(params: URLSearchParams): Promise<void> {
  if (params.get('summarizing') === '1') {
    await emit('summary-status', { noteId: PRICING_NOTE_ID, state: 'running', error: null })
    await waitFor(() => document.querySelector('.side-row-status[data-tone="blue"]') !== null)
  }

  if (params.get('menu') === 'open') {
    await openFilterMenu()
  }

  const selected = Number(params.get('select') ?? 0)
  if (selected > 0) {
    await openFilterMenu()
    findButtonByText('Select notes')?.click()
    await waitFor(() => document.querySelector('.side-row-check') !== null)
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('.side-row-check')).slice(0, selected)
    for (const box of boxes) box.click()
    await waitFor(() => document.querySelectorAll('.side-row-check:checked').length === selected)
  }
}

async function driveNote(params: URLSearchParams): Promise<void> {
  await waitFor(() => document.querySelector('.note-scroll') !== null)
  await waitFor(() => document.querySelector('.speaker-chip') !== null)

  if (params.get('markerAction') === 'edit') {
    const editButton = await waitForSelector<HTMLButtonElement>('button[aria-label^="Edit marker"]')
    editButton?.click()
    await waitFor(() => document.querySelector('input[aria-label^="Marker label at"]') !== null)
  }

  if (params.get('markerAction') === 'add') {
    const addButton = await waitForSelector<HTMLButtonElement>('button[aria-label^="Add marker at"]')
    addButton?.click()
    await waitFor(() => document.querySelector('input[aria-label^="New marker label at"]') !== null)
  }

  await driveSidebar(params)

  // `?summary=queued`: Aurora's summary has waited six hours behind the
  // summary running for the 1:1 with Sam.
  if (params.get('summary') === 'queued') {
    await emit('summary-status', { noteId: SAM_NOTE_ID, state: 'running', error: null })
    await emit('summary-status', { noteId: AURORA_NOTE_ID, state: 'queued', error: null, queuedAt: Date.now() - 6 * 3_600_000 })
    await waitFor(() => document.querySelector('.summary-wait') !== null)
  }

  const filter = params.get('filter')
  if (filter) {
    await openFilterMenu()
    document.querySelector<HTMLElement>('[role="group"][aria-label="Show"]')
      ?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
      .forEach(item => {
        if (item.textContent === filter) item.click()
      })
  }

  if (params.get('sidebar') === 'collapsed') {
    document.querySelector<HTMLButtonElement>('button[aria-label="Collapse library sidebar"]')?.click()
    await waitFor(() => document.querySelector('button[aria-label="Show notes"]') !== null)
  }

  const speakerFilter = params.get('speaker')
  if (speakerFilter) {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Filter transcript by speaker"]')
    if (select) {
      select.value = speakerFilter
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  // `?rename=<speaker>` opens that speaker's popover; `&mergeInto=<speaker>`
  // goes on to merge, and `&speakerMerge=done` confirms it. `&markUnknown=done`
  // marks that speaker's turns as unknown instead, and `&assignUnknown=open`
  // then opens the Unknown speaker chip's popover.
  const rename = params.get('rename')
  if (rename) {
    const chip = await waitForSelector<HTMLButtonElement>(`.speaker-chip[data-speaker="${rename}"]`)
    chip?.click()
    await waitFor(() => document.querySelector('.speaker-popover') !== null)
    const mergeInto = params.get('mergeInto')
    if (mergeInto) {
      findButtonByText('Merge with another speaker')?.click()
      const target = await waitForSelector<HTMLSelectElement>('select[aria-label="Merge into speaker"]')
      if (target) {
        target.value = mergeInto
        target.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (params.get('speakerMerge') === 'done') {
        document.querySelector<HTMLButtonElement>('.speaker-popover-merge button')?.click()
        await waitFor(() => findButtonByText('Undo') !== undefined)
      }
    }
    if (params.get('markUnknown') === 'done') {
      findButtonByText('Mark these turns as unknown')?.click()
      await waitFor(() => findButtonByText('Undo') !== undefined)
      // Closing the popover returns focus to "Rename speakers", which scrolls
      // it into view. Let that land first: on a slower machine it otherwise
      // arrives after the transcript scroll below and undoes it.
      await waitFor(() => document.activeElement === findButtonByText('Rename speakers'))
      if (params.get('assignUnknown') === 'open') {
        const unknownChip = await waitForSelector<HTMLButtonElement>('.speaker-chip[aria-label="Assign unknown turns"]')
        unknownChip?.click()
        await waitFor(() => document.querySelector('.speaker-popover') !== null)
      }
    }
  }

  if (params.get('scroll') === 'transcript') {
    document.querySelector('.note-transcript')?.scrollIntoView({ block: 'start' })
  }

  const menu = params.get('menu')
  if (menu === 'note' || menu === 'markdown') {
    document.querySelector<HTMLButtonElement>('button[aria-label="More note actions"]')?.click()
    await waitFor(() => document.querySelector('.note-menu') !== null)
  }
  if (menu === 'markdown') {
    findButtonByText('View Markdown')?.click()
    await waitFor(() => document.querySelector('.markdown-panel') !== null)
  }

  if (params.get('ask') === 'open') {
    // Ask history is session-only state that only real `ask-answer` events
    // produce, so there is no IPC field to seed it from. `emit` resolves
    // once the mocked dispatch has run, not once React has painted, hence
    // the short settle after each one.
    for (const entry of AURORA_ASK_ENTRIES) {
      // eslint-disable-next-line no-await-in-loop
      await emit('ask-answer', { noteId: 'note-aurora', question: entry.question, answer: entry.answer })
      // eslint-disable-next-line no-await-in-loop
      await sleep(50)
    }
    document.querySelector<HTMLButtonElement>('.toolbar-btn[aria-haspopup="dialog"]')?.click()
    await waitFor(() => document.querySelector('.ask-panel') !== null)
    // 3 citations across both demo answers (1 + 2).
    await waitFor(() => document.querySelectorAll('.ask-panel button[aria-label^="Play from"]').length >= 3)
  }
}

/** Entry point — call once after `<App/>` has mounted. Resolves once the requested state is fully settled on screen. */
export async function driveScenario(state: ScreenshotState, params: URLSearchParams): Promise<void> {
  await waitFor(() => document.querySelector('#root')?.children.length !== 0)

  if (state === 'recording') {
    await driveRecording(params)
  } else if (state === 'preflight') {
    await drivePreflight(params)
  } else if (state === 'messages') {
    await waitFor(() => document.querySelector('.recording-message') !== null)
  } else if (state === 'palette') {
    await drivePalette()
  } else if (state === 'settings') {
    await driveSettings(params)
  } else if (state === 'onboarding') {
    await driveOnboarding(params)
  } else if (state === 'popup') {
    await drivePopup(params)
  } else if (state === 'empty') {
    await driveEmpty()
  } else {
    await driveNote(params)
  }

  // A short final settle so the last state update's re-render (and any CSS
  // transition it kicked off) has definitely painted before capture.
  await sleep(200)
  document.documentElement.setAttribute('data-screenshot-ready', 'true')
}
