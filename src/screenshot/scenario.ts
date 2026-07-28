// Drives the mounted `<App/>` into the right on-screen state for each
// `?state=` value — entirely through the same surfaces a real user would
// use (clicks, the ⌘K keyboard shortcut, typing into the real search input)
// plus emitting the same Tauri events the real backend would during a
// recording, rather than reaching into React internals. Keeps this harness
// honest: if a capture looks right, the real app produces that screen too.

import { emit } from '@tauri-apps/api/event'
import { AURORA_ASK_ENTRIES, RECORDING_ELAPSED_SECONDS, RECORDING_LIVE_TURNS, RECORDING_NOTE_ID } from './demoData'
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

function closestScrollable(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    if (node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY !== 'visible') return node
    node = node.parentElement
  }
  return null
}

function scrollAskSectionIntoView(): void {
  const askInput = document.querySelector<HTMLElement>('input[aria-label="Ask about this meeting"]')
  const scrollContainer = closestScrollable(askInput)
  if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight
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

async function driveRecording(params: URLSearchParams): Promise<void> {
  const startButton = await waitForButtonByText('New recording')
  startButton?.click()
  const confirmButton = await waitForButtonByText('Start recording')
  confirmButton?.click()

  await waitFor(() => document.querySelector('[data-testid="waveform-bars"]') !== null)

  // Stream the demo dialogue in as individual transcript-segment events,
  // exactly like the real stt worker would, then report the elapsed time
  // the recording pill/title bar should show.
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
  const latestSegmentEnd = RECORDING_LIVE_TURNS[RECORDING_LIVE_TURNS.length - 1]?.end ?? 0
  const elapsed = params.get('lag') === 'delayed'
    ? Math.max(RECORDING_ELAPSED_SECONDS, latestSegmentEnd + 45)
    : RECORDING_ELAPSED_SECONDS
  await emit('recording-state', {
    noteId: RECORDING_NOTE_ID,
    state: 'recording',
    elapsed,
    systemAudioActive: false,
    microphoneName: 'MacBook Pro Microphone',
    inputRms: 0.08,
    inputPeak: 0.42,
    inputSequence: 120,
    inputError: null,
  })

  if (params.get('health') === 'silent') {
    await emit('recording-state', {
      noteId: RECORDING_NOTE_ID,
      state: 'recording',
      elapsed: elapsed + 1,
      systemAudioActive: false,
      microphoneName: 'MacBook Pro Microphone',
      inputRms: 0,
      inputPeak: 0.12,
      inputSequence: 121,
      inputError: null,
    })
    await emit('recording-state', {
      noteId: RECORDING_NOTE_ID,
      state: 'recording',
      elapsed: elapsed + 11,
      systemAudioActive: false,
      microphoneName: 'MacBook Pro Microphone',
      inputRms: 0,
      inputPeak: 0.1,
      inputSequence: 122,
      inputError: null,
    })
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
      await waitFor(() => document.querySelector('.recording-title-value h1')?.textContent === title)
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
      await waitFor(() => document.body.textContent?.includes(marker) ?? false)
    }
  }

  const details = params.get('details')
  if (details === 'closed') {
    findButtonByText('Hide details')?.click()
    await waitFor(() => findButtonByText('Show details') !== undefined)
  } else if (details === 'open') {
    findButtonByText('Show details')?.click()
    await waitFor(() => document.querySelector('#recording-details-panel:not([hidden])') !== null)
  }

  const processing = params.get('processing')
  if (processing) {
    findButtonByText('Stop & transcribe')?.click()
    await waitFor(() => document.body.textContent?.includes('Turning your recording into notes') ?? false)
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

async function drivePopup(): Promise<void> {
  await waitFor(() => document.querySelector('[role="dialog"][aria-label="Meeting detected"]') !== null)
  // Same event the real detector (detect.rs) fires into the popup webview —
  // see src/ipc/events.ts's `onMeetingPopupPayload`. "Zoom" mirrors the
  // allowlisted app named in the detection engine's own bundle-id list.
  await emit('meeting-popup-payload', { appName: 'Zoom' })
  await waitFor(() => document.body.textContent?.includes('Zoom is using the microphone') ?? false)
}

async function driveSettings(): Promise<void> {
  const settingsButton = await waitForButtonByText('Settings')
  settingsButton?.click()
  await waitFor(() => document.querySelector('[role="radiogroup"][aria-label="Transcription model"]') !== null)
}

async function driveNote(params: URLSearchParams): Promise<void> {
  await waitFor(() => document.querySelector('[role="tablist"][aria-label="Note content"]') !== null)

  const tab = params.get('tab')
  if (tab === 'overview') {
    findButtonByText('Overview')?.click()
    await waitFor(() => document.querySelector('#note-panel-overview') !== null)
  }

  if (params.get('markerAction') === 'edit') {
    const editButton = await waitForSelector<HTMLButtonElement>('button[aria-label^="Edit marker"]')
    editButton?.click()
    await waitFor(() => document.querySelector('input[aria-label="Marker label"]') !== null)
  }

  if (params.get('markerAction') === 'add') {
    const addButton = await waitForSelector<HTMLButtonElement>('button[aria-label^="Add marker at"]')
    addButton?.click()
    await waitFor(() => document.querySelector('input[aria-label^="New marker label at"]') !== null)
  }

  const filter = params.get('filter')
  if (filter) {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')
    if (select) {
      select.value = filter
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  if (params.get('sidebar') === 'collapsed') {
    document.querySelector<HTMLButtonElement>('button[aria-label="Collapse library sidebar"]')?.click()
    await waitFor(() => document.querySelector('.library-sidebar')?.getAttribute('data-collapsed') === 'true')
  }

  const speaker = params.get('speaker')
  if (speaker) {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Filter transcript by speaker"]')
    if (select) {
      select.value = speaker
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await waitFor(() => findButtonByText('Rename speaker') !== undefined)
    }
  }

  const speakerMerge = params.get('speakerMerge')
  if (speakerMerge && speaker) {
    findButtonByText('Merge speaker')?.click()
    const target = await waitForSelector<HTMLSelectElement>('select[aria-label="Merge into speaker"]')
    const mergeInto = params.get('mergeInto')
    if (target && mergeInto) {
      target.value = mergeInto
      target.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (speakerMerge === 'done') {
      document.querySelector<HTMLButtonElement>('.speaker-merge-form button[type="submit"]')?.click()
      await waitFor(() => findButtonByText('Undo') !== undefined)
    }
  }

  // Populate ask-your-notes' session history — session-only state, only
  // ever produced by real `ask-answer` events (see useNoteDetail.ts), so
  // there's no IPC field to seed this from; emitted in order so the second
  // question ends up on top (history is newest-first). Awaited + settled
  // one at a time — `emit`'s promise resolves once the mocked IPC dispatch
  // has run, not once React has necessarily flushed and painted the
  // resulting state update, so each iteration gets a short settle beat too.
  for (const entry of AURORA_ASK_ENTRIES) {
    // eslint-disable-next-line no-await-in-loop
    await emit('ask-answer', { noteId: 'note-aurora', question: entry.question, answer: entry.answer })
    // eslint-disable-next-line no-await-in-loop
    await sleep(50)
  }

  if (params.get('focus') === 'ask') {
    // 3 total citation buttons across both demo answers (1 + 2) — the
    // precise count, not just ">0", so this doesn't race ahead of the
    // second (topmost) entry still rendering.
    await waitFor(() => document.querySelectorAll('button[aria-label^="Play from"]').length >= 3)
    await sleep(50)
    scrollAskSectionIntoView()
    // One more pass after a layout settle beat, in case the first scroll
    // landed before the panel's final content height (fonts/reflow).
    await sleep(120)
    scrollAskSectionIntoView()
  }
}

/** Entry point — call once after `<App/>` has mounted. Resolves once the requested state is fully settled on screen. */
export async function driveScenario(state: ScreenshotState, params: URLSearchParams): Promise<void> {
  await waitFor(() => document.querySelector('#root')?.children.length !== 0)

  if (state === 'recording') {
    await driveRecording(params)
  } else if (state === 'preflight') {
    await drivePreflight(params)
  } else if (state === 'palette') {
    await drivePalette()
  } else if (state === 'settings') {
    await driveSettings()
  } else if (state === 'onboarding') {
    await waitFor(() => document.body.textContent?.includes('Start using Minute') ?? false)
  } else if (state === 'popup') {
    await drivePopup()
  } else {
    await driveNote(params)
  }

  // A short final settle so the last state update's re-render (and any CSS
  // transition it kicked off) has definitely painted before capture.
  await sleep(200)
  document.documentElement.setAttribute('data-screenshot-ready', 'true')
}
