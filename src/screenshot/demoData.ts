// Curated marketing fixture data for the screenshot harness (see
// src/screenshot/mockIpc.ts). Deliberately separate from src/data/demo.ts
// (that file is component-test-fixtures-only, see its own header) — this
// one exists purely to make Minute's real UI look like a genuinely-used app
// for Product Hunt captures, not to back any test.

import type {
  Hardware,
  ModelStatus,
  NoteMeta,
  Recommendation,
  SearchHit,
  Settings,
  StorageStats,
  StoredSegment,
  SummaryDoc,
} from '../ipc/types'

const HOUR = 3_600_000
const DAY = 86_400_000

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString()
}

function isoDaysAgo(days: number, hour = 10): string {
  const d = new Date(Date.now() - days * DAY)
  d.setUTCHours(hour, 0, 0, 0)
  return d.toISOString()
}

export const AURORA_NOTE_ID = 'note-aurora'
export const PRICING_NOTE_ID = 'note-pricing-workshop'
export const Q3_NOTE_ID = 'note-q3-kickoff'
export const ALLHANDS_NOTE_ID = 'note-allhands-july'
export const SAM_NOTE_ID = 'note-sam-1on1'
export const ONBOARDING_REVIEW_NOTE_ID = 'note-onboarding-review'

/** Sidebar note library — 6 notes across Today / Yesterday / Last week, newest first. */
export const NOTES: NoteMeta[] = [
  {
    id: AURORA_NOTE_ID,
    title: 'Aurora launch sync',
    createdAt: isoHoursAgo(2),
    durationSec: 1680,
    model: 'whisper-small',
    status: 'ready',
    speakers: 3,
    audioDeleted: false,
    sources: ['mic'],
    pinned: true,
    markers: [
      { seconds: 472, label: 'Launch date decision' },
      { seconds: 1100, label: 'Illustrations follow-up' },
      { seconds: 1390, label: 'Telemetry rollout' },
    ],
  },
  {
    id: SAM_NOTE_ID,
    title: '1:1 with Sam',
    createdAt: isoHoursAgo(6),
    durationSec: 1320,
    model: 'whisper-small',
    status: 'transcribed',
    speakers: 2,
    audioDeleted: false,
    sources: ['mic'],
  },
  {
    id: ONBOARDING_REVIEW_NOTE_ID,
    title: 'Design review — onboarding flow',
    createdAt: isoDaysAgo(1, 15),
    durationSec: 1920,
    model: 'whisper-small',
    status: 'ready',
    speakers: 4,
    audioDeleted: false,
    sources: ['mic'],
  },
  {
    id: Q3_NOTE_ID,
    title: 'Q3 planning kickoff',
    createdAt: isoDaysAgo(1, 9),
    durationSec: 3060,
    model: 'whisper-medium',
    status: 'transcribed',
    speakers: 5,
    audioDeleted: false,
    sources: ['mic'],
  },
  {
    id: PRICING_NOTE_ID,
    title: 'Pricing workshop — enterprise tiers',
    createdAt: isoDaysAgo(4, 13),
    durationSec: 2460,
    model: 'whisper-small',
    status: 'ready',
    speakers: 3,
    audioDeleted: false,
    sources: ['mic'],
  },
  {
    id: ALLHANDS_NOTE_ID,
    title: 'All-hands — July',
    createdAt: isoDaysAgo(6, 11),
    durationSec: 3720,
    model: 'whisper-medium',
    status: 'transcribed',
    speakers: 6,
    audioDeleted: false,
    sources: ['mic'],
  },
]

/** Full transcript for the Aurora launch sync — the note behind hero.png / ask.png. */
export const AURORA_TRANSCRIPT: StoredSegment[] = [
  { speaker: 'You', start: 8, end: 28, text: "Let's start — Aurora's the async-transcription pipeline rewrite, right? Where are we against next Friday?" },
  { speaker: 'Marcus Chen — Eng', start: 34, end: 64, text: "Load testing's clean up to 40 concurrent streams. Past that we start dropping frames on the M1 baseline, so I want one more pass before we call it." },
  { speaker: 'Priya Shah — Design', start: 72, end: 96, text: 'On my side, the onboarding redesign is in review. Two of the five screens still need empty-state illustrations, but nothing blocks engineering.' },
  { speaker: 'You', start: 160, end: 172, text: 'If load testing slips, does the 14th still hold?' },
  { speaker: 'Marcus Chen — Eng', start: 185, end: 214, text: "If I get Thursday to finish the pass, yes. If not, I'd rather push three days than ship something that stutters on real hardware." },
  { speaker: 'Priya Shah — Design', start: 435, end: 460, text: 'Can we scope the illustrations down to three screens for launch and backfill the rest after? That buys me two days.' },
  { speaker: 'You', start: 472, end: 502, text: "Works for me. Let's lock the 14th — Marcus gets Thursday for load testing. If it's still red Wednesday night, we push to the 17th, no later." },
  { speaker: 'Marcus Chen — Eng', start: 872, end: 892, text: "Fair. I'll post results in #aurora by end of day Thursday either way." },
  { speaker: 'You', start: 1100, end: 1122, text: "Priya, can you get the three trimmed illustrations to review by Wednesday morning so we're not doing sign-off day-of?" },
  { speaker: 'Priya Shah — Design', start: 1124, end: 1148, text: "Yep, Wednesday morning. I'll flag the two backfilled screens as known follow-ups in the release notes." },
  { speaker: 'Marcus Chen — Eng', start: 1390, end: 1416, text: "One more thing — I want frame-drop telemetry behind a flag for the first week, just so we're not flying blind if support tickets come in." },
  { speaker: 'You', start: 1421, end: 1444, text: "Good call. Ship it behind the existing debug flag rather than a new one — one less thing to remember to turn off." },
  { speaker: 'You', start: 1625, end: 1660, text: "Okay — the 14th it is, with the 17th as the real fallback if Thursday's numbers are still red. I'll write this up and send it around." },
]

export const AURORA_SUMMARY: SummaryDoc = {
  summary:
    "Aurora's transcription pipeline holds to the original date if Thursday's load-testing pass comes back clean above 40 concurrent streams; if not, launch slips three days rather than ship on unverified hardware. Design trims the onboarding illustration set to the three screens directly in the launch path and backfills the rest after launch. Engineering adds frame-drop telemetry behind the existing debug flag for the first week to catch regressions early.",
  decisions: [
    'Launch date holds at the 14th, with the 17th as the hard fallback if Thursday’s load-testing numbers are still red.',
    'Onboarding illustrations ship for 3 of 5 screens at launch; the remaining 2 backfill after, noted in release notes.',
    'Frame-drop telemetry ships behind the existing debug flag rather than a new one.',
  ],
  actionItems: [
    { text: 'Finish the load-testing pass above 40 concurrent streams and post results in #aurora by Thursday EOD', done: false },
    { text: 'Deliver the three trimmed onboarding illustrations for review by Wednesday morning', done: false },
    { text: 'Wire frame-drop telemetry behind the existing debug flag', done: true },
    { text: 'Draft the launch-date decision recap and send to the team', done: false },
  ],
}

export const AURORA_MARKDOWN = `# Aurora launch sync

**Date:** ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · **Duration:** 28 min · **Speakers:** 3

## Summary

${AURORA_SUMMARY.summary}

## Decisions

${AURORA_SUMMARY.decisions.map(d => `- ${d}`).join('\n')}

## Action items

${AURORA_SUMMARY.actionItems.map(a => `- [${a.done ? 'x' : ' '}] ${a.text}`).join('\n')}

## Transcript

${AURORA_TRANSCRIPT.map(s => `**${s.speaker}** (${formatTs(s.start)})\n${s.text}`).join('\n\n')}
`

function formatTs(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60)
  const ss = Math.floor(totalSeconds % 60)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** Ask-your-notes demo Q&A, emitted (in this order) as `ask-answer` events — the second one lands on top since history is newest-first. */
export const AURORA_ASK_ENTRIES: { question: string; answer: string }[] = [
  {
    question: "What's blocking the illustration work?",
    answer:
      'Two of five onboarding screens still need empty-state illustrations. Priya scoped it down to the three screens directly in the launch path [07:15] and will backfill the rest after launch.',
  },
  {
    question: 'What did we decide about the launch date?',
    answer:
      "The 14th holds if Thursday's load-testing pass comes back clean above 40 concurrent streams [03:05]. If it's still failing Wednesday night, the team pushes to the 17th as the fallback [07:52] rather than ship on unverified hardware.",
  },
]

/** A minimal, still-valid `get_note` fallback for every sidebar note besides Aurora — never actually fetched by the default screenshot flows, but kept honest in case a future scenario selects one. */
export function fallbackTranscriptFor(id: string): StoredSegment[] {
  switch (id) {
    case Q3_NOTE_ID:
      return [
        { speaker: 'You', start: 12, end: 34, text: 'Kicking off Q3 — three themes: onboarding, pricing, and reliability.' },
        { speaker: 'Dana Osei — Sales', start: 245, end: 268, text: "Before we lock scope, I'd like us to revisit the enterprise pricing tiers before the Q3 board deck goes out." },
      ]
    case PRICING_NOTE_ID:
      return [
        { speaker: 'You', start: 20, end: 48, text: 'Today is just the tiers — Starter, Team, Enterprise. Nothing about billing infra yet.' },
        { speaker: 'Dana Osei — Sales', start: 512, end: 540, text: 'Three tiers instead of five — Starter, Team, and Enterprise — and simplify the seat-based pricing entirely.' },
      ]
    case ALLHANDS_NOTE_ID:
      return [
        { speaker: 'You', start: 30, end: 58, text: 'Welcome to the July all-hands — quick wins, then open floor.' },
        {
          speaker: 'Support — Jamie',
          start: 1830,
          end: 1862,
          text: 'One thing from the queue: support asked about grandfathering existing customers into the old pricing before the new tiers roll out.',
        },
      ]
    case SAM_NOTE_ID:
      return [
        { speaker: 'You', start: 15, end: 40, text: "How's the roadmap review going on your end?" },
        {
          speaker: 'Sam Whitfield',
          start: 390,
          end: 418,
          text: "One thing — I think the new pricing page copy undersells the on-device story compared to competitors.",
        },
      ]
    case ONBOARDING_REVIEW_NOTE_ID:
      return [
        { speaker: 'You', start: 10, end: 30, text: 'Walking through the new onboarding flow end to end today.' },
        { speaker: 'Jordan Lee — Design', start: 88, end: 120, text: 'First screen is just the value prop — one line, no video, no carousel.' },
      ]
    default:
      return []
  }
}

/** Model catalog — mirrors src-tauri/catalog.json's real entries, with install state set per scenario by mockIpc.ts. */
export const CATALOG: Omit<ModelStatus, 'state'>[] = [
  {
    id: 'whisper-small',
    kind: 'stt',
    displayName: 'Whisper small',
    desc: '466 MB · 62× realtime · good for meetings',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987',
    sizeBytes: 487_601_967,
    minRamGb: 0,
    requiresAppleSilicon: false,
  },
  {
    id: 'whisper-medium',
    kind: 'stt',
    displayName: 'Whisper medium',
    desc: '1.5 GB · 21× realtime · better accents & jargon',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c15620',
    sizeBytes: 1_533_763_059,
    minRamGb: 16,
    requiresAppleSilicon: false,
  },
  {
    id: 'whisper-large-v3-turbo',
    kind: 'stt',
    displayName: 'Whisper large-v3-turbo',
    desc: '1.6 GB · 6× realtime · maximum accuracy',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc6',
    sizeBytes: 1_624_555_275,
    minRamGb: 16,
    requiresAppleSilicon: true,
  },
  {
    id: 'qwen3.5-4b',
    kind: 'llm',
    displayName: 'Qwen3.5-4B',
    desc: '2.6 GB · Q4_K_M · fast default summarizer',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a',
    sizeBytes: 2_740_937_888,
    minRamGb: 8,
    requiresAppleSilicon: false,
  },
  {
    id: 'qwen3.5-9b',
    kind: 'llm',
    displayName: 'Qwen3.5-9B',
    desc: '5.7 GB · Q4_K_M · quality tier summarizer',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e',
    sizeBytes: 5_680_522_464,
    minRamGb: 16,
    requiresAppleSilicon: false,
  },
  {
    id: 'gemma-4-e4b',
    kind: 'llm',
    displayName: 'Gemma 4 E4B',
    desc: '5.3 GB · Q4_K_M · best at summarization',
    url: 'https://huggingface.co/lmstudio-community/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf',
    sha256: '0ffb122c8b6921f13cbc34186e052524d0b5803b17f4867b7197a561400b377',
    sizeBytes: 5_335_291_936,
    minRamGb: 16,
    requiresAppleSilicon: false,
  },
]

export const HARDWARE: Hardware = { totalRamGb: 36, appleSilicon: true, cores: 12 }
export const RECOMMENDATION: Recommendation = { stt: 'whisper-large-v3-turbo', llm: 'qwen3.5-9b' }
export const SETTINGS: Settings = {
  sttModel: 'whisper-small',
  llmModel: 'qwen3.5-4b',
  deleteAudioAfter30d: true,
  meetingDetection: false,
  captureSystemAudio: false,
  libraryRoot: null,
  llmContextTokens: null,
  summaryStyle: 'standard',
  summaryInstructions: '',
  autoUpdateCheck: true,
}
export const STORAGE: StorageStats = { modelsBytes: 4_762_339_000, audioBytes: 612_400_000, notesBytes: 18_200_000 }

/** Search-palette demo hits for the `?state=palette` capture — query "pricing". */
export const PRICING_SEARCH_HITS: SearchHit[] = [
  { noteId: PRICING_NOTE_ID, title: 'Pricing workshop — enterprise tiers', snippet: '', segmentStart: null, kind: 'title' },
  {
    noteId: PRICING_NOTE_ID,
    title: 'Pricing workshop — enterprise tiers',
    snippet: 'three tiers instead of five — Starter, Team, and Enterprise — and simplify the seat-based pricing entirely',
    segmentStart: 512,
    kind: 'transcript',
  },
  {
    noteId: Q3_NOTE_ID,
    title: 'Q3 planning kickoff',
    snippet: "revisit the enterprise pricing tiers before the Q3 board deck goes out",
    segmentStart: 245,
    kind: 'transcript',
  },
  {
    noteId: ALLHANDS_NOTE_ID,
    title: 'All-hands — July',
    snippet: 'support asked about grandfathering existing customers into the old pricing before the new tiers roll out',
    segmentStart: 1830,
    kind: 'transcript',
  },
  {
    noteId: SAM_NOTE_ID,
    title: '1:1 with Sam',
    snippet: "Sam's worried the new pricing page copy undersells the on-device story compared to competitors",
    segmentStart: 390,
    kind: 'transcript',
  },
]

/** Live-recording demo dialogue for `?state=recording` — one entry per speaker turn, emitted as individual `transcript-segment` events (each becomes its own group, since the adapter only merges consecutive same-speaker segments). */
export const RECORDING_LIVE_TURNS: { speaker: string; start: number; end: number; text: string }[] = [
  { speaker: 'You', start: 12, end: 27, text: "Let's walk through the new onboarding flow — Jordan, take us from the top?" },
  {
    speaker: 'Jordan Lee — Design',
    start: 28,
    end: 58,
    text: 'Sure. First screen is just the value prop — one line, no video, no carousel. We tested three versions and the plain version had the highest continue rate.',
  },
  { speaker: 'Alex Rivera — PM', start: 75, end: 92, text: "What about permissions? Mic access is the one people bail on." },
  {
    speaker: 'Jordan Lee — Design',
    start: 100,
    end: 128,
    text: "We moved it to right before the first recording instead of during onboarding. Nobody asks for it in the abstract — you ask when it's obviously needed.",
  },
  {
    speaker: 'You',
    start: 242,
    end: 268,
    text: "That matches what we saw in the support tickets — half the drop-off complaints were 'why does this need my microphone' with no context.",
  },
  { speaker: 'Alex Rivera — PM', start: 390, end: 410, text: "Any read yet on the model-download step? That's still the longest part of onboarding." },
  {
    speaker: 'Jordan Lee — Design',
    start: 535,
    end: 566,
    text: "We added a progress state that explains what's happening — 'Downloading Whisper small, this runs the transcription, it only happens once.' Early testers stopped asking support what it was doing.",
  },
  { speaker: 'You', start: 680, end: 704, text: "Good. Let's ship this version and watch the funnel for a week before touching the permissions copy again." },
  { speaker: 'Alex Rivera — PM', start: 750, end: 767, text: 'Agreed — I\'ll get it into the next build.' },
]

export const RECORDING_ELAPSED_SECONDS = 767 // 12:47
export const RECORDING_NOTE_ID = 'note-recording-live'
