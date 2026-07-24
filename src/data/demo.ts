// Test-fixtures-only, as of Task 9. The app renders real data from the
// Tauri backend (src/ipc/*) for notes/models/settings/live transcripts —
// no component imports this file at runtime anymore (RecordingView's live
// transcript is now wired to real `transcript-segment` events, grouped via
// `state/adapters.ts`'s `groupLiveSegments`). Everything here is a reusable
// fixture for component tests (Sidebar.test, TranscriptList.test,
// AiNotesPanel.test, MarkdownCard.test).

import type { ActionItem, NoteListItem, SttModelInfo, TranscriptSegment } from '../types'

export const demoNotes: NoteListItem[] = [
  { id: 'demo-1', title: 'Board prep sync', meta: '32 min · 2 speakers', group: 'Today' },
  { id: 'demo-2', title: '1:1 — Sarah', meta: '25 min' },
  { id: 'demo-3', title: 'Client call — Acme', meta: '48 min · 4 speakers', group: 'Yesterday' },
  { id: 'demo-4', title: 'Interview — SDK candidate', meta: '55 min' },
  { id: 'demo-5', title: 'All hands — June', meta: '61 min · 6 speakers', group: 'Last week' },
  { id: 'demo-6', title: 'Pricing workshop', meta: '90 min · 3 speakers' },
]

export const initialActions: ActionItem[] = [
  { text: 'Send security documentation to Tom before procurement kickoff', done: true },
  { text: 'Set up Markdown export matching Acme Monday digest template', done: false },
  { text: 'Share export template with pilot group by Friday', done: false },
]

export const demoTranscript: TranscriptSegment[] = [
  {
    initials: 'TR',
    speaker: 'Tom Reyes — Acme',
    time: '00:41',
    start: 41,
    end: 62,
    text: 'Thanks for making time. Before we get into the roadmap, I want to flag that our security team has questions about where the meeting audio ends up.',
  },
  {
    initials: 'ME',
    speaker: 'You',
    time: '01:02',
    start: 62,
    end: 94,
    text: "Short answer: nowhere. Everything you're hearing transcribed right now runs on this laptop — the model, the audio, the notes. There's no account and no server.",
  },
  {
    initials: 'TR',
    speaker: 'Tom Reyes — Acme',
    time: '01:34',
    start: 94,
    end: 130,
    text: "If that holds up in review, we can move the pilot from 20 seats to the full 200 by Q3. Send over the security documentation and we'll start procurement.",
  },
  {
    initials: 'PS',
    speaker: 'Priya Shah',
    time: '02:10',
    start: 130,
    end: 146,
    text: 'One ask from our side — the pilot group wants the summaries in the Monday digest format. Can the export match that template?',
  },
  {
    initials: 'ME',
    speaker: 'You',
    time: '02:26',
    start: 146,
    end: 170,
    text: "Yes — Markdown export is templated, I'll set one up and share it with the pilot group before Friday.",
  },
]

export const sttModels: SttModelInfo[] = [
  {
    id: 'small',
    name: 'Whisper small',
    desc: '466 MB · 62× realtime · good for meetings',
    sub: 'Recommended for this Mac',
    subOn: 'Installed · in use',
  },
  {
    id: 'medium',
    name: 'Whisper medium',
    desc: '1.5 GB · 21× realtime · better accents & jargon',
    sub: 'Installed',
    subOn: 'Installed · in use',
  },
  {
    id: 'large',
    name: 'Whisper large-v3',
    desc: '3.1 GB · 6× realtime · maximum accuracy',
    sub: 'Not downloaded · 3.1 GB',
    subOn: 'Installed · in use',
  },
]

export const demoMarkdown = `# Client call — Acme

**Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4

## Summary

Acme is ready to expand the pilot from 20 to 200 seats in Q3, contingent
on security review of the on-device architecture. Their pilot group also
needs summary exports in their Monday digest format before Friday.

## Decisions

- Pilot expands to 200 seats in Q3 if security review passes.
- Exports will match Acme's Monday digest template.

## Action items

- [x] Send security documentation to Tom before procurement kickoff
- [ ] Set up Markdown export matching Acme Monday digest template
- [ ] Share export template with pilot group by Friday

## Transcript

**Tom Reyes — Acme** (00:41)
Thanks for making time. Before we get into the roadmap, I want to flag
that our security team has questions about where the meeting audio ends up.

**You** (01:02)
Short answer: nowhere. Everything you're hearing transcribed right now runs
on this laptop — the model, the audio, the notes. There's no account and
no server.

**Tom Reyes — Acme** (01:34) ★ highlight
If that holds up in review, we can move the pilot from 20 seats to the
full 200 by Q3. Send over the security documentation and we'll start
procurement.

**Priya Shah** (02:10)
One ask from our side — the pilot group wants the summaries in the Monday
digest format. Can the export match that template?

**You** (02:26)
Yes — Markdown export is templated, I'll set one up and share it with the
pilot group before Friday.`
