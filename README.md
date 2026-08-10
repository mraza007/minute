<div align="center">

# Minute

**Meeting notes that never leave your Mac.**

![platform](https://img.shields.io/badge/platform-macOS-black)
![version](https://img.shields.io/badge/version-1.8.1-c8412a)

<a href="https://www.producthunt.com/products/minute-4?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-minute-4" target="_blank" rel="noopener noreferrer"><img alt="Minute - Meeting notes that never leave your Mac | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1213983&amp;theme=light&amp;t=1785901198362"></a>

![Minute — meeting overview with summary, decisions, action items, markers, and local ask](screenshots/hero.png)

**[⬇ Download Minute 1.8.1 for Apple Silicon](https://github.com/mraza007/minute/releases/download/v1.8.1/Minute-1.8.1-arm64.zip)**

Using an Intel Mac? [Download the Intel build](https://github.com/mraza007/minute/releases/download/v1.8.1/Minute-1.8.1-x86_64.zip).

</div>

Minute is a fully offline meeting notetaker for macOS. It records audio,
transcribes it live with Whisper, labels who spoke, and turns the
transcript into a summary, decisions, and action items with a local LLM —
all of it running on-device, in-process, with Metal acceleration. No
account, no cloud, no server. The only network traffic Minute ever makes
is an optional model download and — unless you turn it off — a periodic
check against GitHub for a newer version of the app itself. Neither one
carries anything about you or your notes.

## Why

Most meeting notetakers are a microphone hooked up to somebody else's
server. Minute is a notebook: it writes to a folder on your disk, in plain
text and WAV, and asks nothing of the network to work. Turn off Wi-Fi and
record a meeting — it transcribes, summarizes, and answers questions about
it exactly the same as it does online, because it never used the network in
the first place.

## Meeting detection, without a permission prompt

When another app starts using your microphone — Zoom, Teams, Webex, Slack,
FaceTime, Discord, or a browser call — Minute notices and offers a quiet
pill above whatever you're looking at: one click starts recording, one
click (or 12 seconds of silence) dismisses it. It's off by default; turn
it on in Settings.

This is the honest version of what that pill is doing: it checks whether
the default microphone is in use and which apps are currently running —
both things any app on the system can already see, neither one requiring
a permission dialog. It never opens the microphone itself and never
listens to audio to decide whether to show up. Turn the toggle off and
the detector thread stops existing, not just stops firing.

![Minute — the meeting-detected pill, one click from recording](screenshots/popup.png)

## Recording, transcribed as it happens

Before recording, Minute shows exactly what it will capture: the real current
microphone, a live input meter, system-audio availability, and a transcription
mode with an honest fit label for this Mac. Capture sources stay visible
throughout the meeting, so there is never any ambiguity about where the input
is coming from.

![Minute — recording preflight with microphone, input level, system audio, and model fit](screenshots/preflight.png)

Once recording starts, Whisper transcribes in real time, grouped by speaker
and scrolling live as the meeting runs. Rename the working title, pause and
resume, or add timestamped markers with `⌘⇧M`. Minute calls out prolonged
silence, clipping, a disconnected input, or transcription lag without hiding
the audio capture that is still safe.

Turn on **Capture system audio** in Settings and a recording captures both
sides of the call — your microphone and what your Mac is playing — so the
other participants land in the transcript too, not just you. It needs
macOS 13 or later and Screen Recording permission (the one system prompt
this whole feature ever triggers); say no, or run an older macOS, and
recording still works exactly as before, mic-only. And speakers are fine:
when system audio is part of the mix, the microphone runs through macOS's
own voice processing — the same echo canceller FaceTime uses — so what
your Mac plays doesn't land in the recording a second time as speaker
bleed through the mic.

Forget to hit stop and Minute notices. After 10 minutes with nothing
audible on either source it warns with a 10-minute countdown, then stops
and transcribes on its own, exactly as if you'd clicked Stop — a
forgotten recording becomes a normal note instead of an 18-hour WAV of an
empty room. Any sound cancels the countdown; "Keep recording" silences it
for that recording; a Settings toggle turns the whole behavior off.
Relatedly, Whisper's habit of transcribing dead air as stray punctuation
is filtered as it happens, so quiet stretches don't fill transcripts with
"." lines.

![Minute — a live recording with source, health, transcript, and marker details](screenshots/recording.png)

## Who said what

Turn on **Detect speakers** (Settings → Recording) and every recording's
turns get labeled by voice — Speaker 1, Speaker 2, and so on — ready for
the rename and merge tools below. Detection runs entirely on-device
through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): pyannote
segmentation finds the speech turns, 3D-Speaker CAM++ voice embeddings
tell the voices apart, two small models (~34 MB total) downloaded once
when you enable it. It runs after transcription and before the summary,
so summaries refer to real speakers.

It works on existing notes too — a "Detect speakers" button in the
transcript toolbar runs the same pass on any note that still has its
audio. Automatic speaker counting is strongest on clear call audio; when
it gets the count wrong, re-run it with the exact number of speakers and
it's very accurate. Names you've confirmed stick: a speaker you renamed
keeps that name across re-runs.

Minute can also remember the people you meet with. Turn on **Remember
named speakers** (Settings → Speakers) and renaming a speaker saves that
voice locally; the next recording that contains a matching voice gets a
suggestion — "Speaker 2 sounds like Sarah" — you confirm with one click
or dismiss. Confirmations sharpen the profile over time. Voice profiles
are opt-in, stored in your library folder, listed in Settings with a
delete button each, and — like everything else — never leave your Mac.

## A summary you can act on

Once a note is transcribed, a local LLM turns it into a short summary,
a list of decisions, and action items you can check off without leaving the
note. The post-recording overview keeps source, duration, speakers, transcript
turns, and markers together. Every generated field comes from the local
transcript and can be regenerated without uploading the meeting.

Summaries are yours to shape: pick a length (short / standard / detailed),
add standing custom instructions ("write it in German", "focus on
engineering decisions"), and let the context window size itself to this
Mac's memory — or pin it yourself. All of it in Settings, all applied to
the next summary you generate. **Detailed** adds a section-by-section
breakdown of every topic discussed, on top of the usual decisions and
follow-ups.

A note you never named takes its title from the meeting itself once the
summary lands — no more libraries of "New recording". And asking for a
second summary while one is already running queues it instead of turning
you away; it starts on its own when the engine frees up.

## Ask your notes, with receipts

Ask a plain-language question about a meeting — "what did we decide about
the launch date?" — and Minute answers from the transcript, with inline
`[mm:ss]` citations you can click to jump straight to that moment in the
recording. It's a conversation with your own notes, not a chatbot guessing
from a summary.

![Minute — ask-your-notes answering with clickable timestamp citations](screenshots/ask.png)

## Find anything, instantly

⌘K searches titles and full transcript text across your whole library,
with matches highlighted and playback ready to seek straight to the moment
someone said the thing you're looking for.

For larger libraries, notes can be pinned, filtered by recording status,
source, or date, and sorted by newest, oldest, duration, or title. Multi-select
supports bulk export and recoverable deletion, while per-note storage details
make audio retention visible instead of mysterious. Recordings don't have to
stay heavyweight either: an optional storage setting converts audio older
than 7, 14, or 30 days from WAV to compact AAC — still playable, still
seekable from the transcript, at a fraction of the disk space.

![Minute — the ⌘K search palette showing title and transcript hits](screenshots/search.png)

## Clean up without losing work

Rename speakers, filter the transcript by speaker, or merge duplicate speaker
identities with an exact undo path — the manual half of the speaker story,
for when detection gets a label wrong or you'd rather see "Sam" than
"Speaker 2". Markers remain editable after recording, deleted notes move
into local recovery, and destructive cleanup always offers Undo.

## Dark mode that still feels like paper

Minute follows macOS's appearance setting. The dark theme isn't an inverted
light theme — it's its own warm, ink-on-dark-paper palette, built to the
same calm, analog feel as the light one.

![Minute — note view in dark mode](screenshots/dark.png)

## Models sized to your Mac

Whisper (small / medium / large-v3-turbo) for transcription and a choice of
local LLMs (Qwen3.5-4B, Qwen3.5-9B, Gemma 4 E4B, and LFM2-2.6B-Transcript —
a 1.6 GB model fine-tuned specifically for meeting notes) for summarization
— pick what fits your hardware and disk budget, or let Minute suggest a pair based
on the detected architecture, memory, and CPU cores. Every choice is labeled
**Recommended**, **Good fit**, **Near memory limit**, **Below minimum**, or
**Not supported** without pretending to have benchmarked hardware it has not.
The two small speaker-detection models ride along the same catalog,
fetched only when you enable that feature. Everything downloads once, runs
entirely offline after that, and can be removed just as easily.

![Minute — the model manager, showing installed and available models](screenshots/models.png)

## How it works

Minute is a [Tauri 2](https://tauri.app) app: a React 19 + TypeScript
frontend around a Rust backend that runs [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
[llama.cpp](https://github.com/ggml-org/llama.cpp), and
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (speaker detection)
in-process, with Metal acceleration on Apple Silicon — no sidecar process,
no local server, no localhost port. The frontend talks to the backend over
Tauri's IPC; the backend talks to the inference engines as linked
libraries.

Each note is a plain folder on disk, human-readable and yours regardless of
whether Minute is still installed:

```
~/Library/Application Support/dev.minute.app/notes/<note-id>/
├── audio.wav         # the recording (deleted automatically after 30 days, if enabled)
├── transcript.json   # timestamped, speaker-labeled segments
├── summary.json      # summary, decisions, action items
└── note.md           # everything above, rendered as one Markdown file
```

Models live alongside them, in a shared `models/` directory, downloaded once
and reused across every note. `hardware_info` reads your Mac's RAM and chip
to recommend a Whisper + LLM pair that fits comfortably — nothing is forced,
every model in the catalog stays choosable, download size and RAM
requirements shown up front.

## Privacy

**Nothing leaves this machine.** Concretely, not as a slogan:

- Minute's [CSP](src-tauri/tauri.conf.json) has no network origin at all —
  `default-src 'self'`, no exceptions. The only asset-loading rule is the
  Tauri asset protocol serving your own note audio back to the player.
- Fonts (Instrument Sans) ship bundled in the app, not fetched from Google
  Fonts or any other CDN.
- Transcription and summarization run as linked libraries in the same
  process as the app itself — there is no local server, no localhost port,
  nothing to inspect in a network tab, because there's no network activity
  to inspect.
- Turn off Wi-Fi before a meeting. Record, transcribe, summarize, ask
  questions about it. Nothing about that flow behaves any differently
  offline, because it's never anything but offline.
- The two deliberate exceptions, both your choice: model downloads (only
  when you pick one) and the automatic update check (on by default, one
  HTTPS request to GitHub for release metadata — never anything about you
  or your notes — with a Settings toggle that turns it off entirely).
- A privacy-safe diagnostics export records app, model, source, storage, and
  recovery state without including the recording or transcript.

## Requirements

- macOS 11 or later; macOS 13 or later for system-audio capture.
- Apple Silicon is the tested and recommended target. A separate Intel build
  is produced and architecture-verified, but launch and transcription on
  physical Intel hardware remain a release-validation item.
- Model availability depends on architecture and memory. Minute shows the
  compatibility result before download.
- About 3 GB of free disk space for the default Whisper small + Qwen3.5-4B
  pair, plus space for retained recordings.

## Install

Grab the architecture-appropriate ZIP above, unzip it, and drag `Minute.app`
into Applications. On first launch, macOS asks for microphone access when you
start your first recording. System-audio capture additionally asks for Screen
Recording access on macOS 13 or later.

That's the last install you do by hand: Minute checks for new releases and
offers a one-click **Update & restart** in Settings. Updates are
cryptographically signed and verified against a key baked into the app —
nothing installs without your click.

You can also build Minute from source:

```bash
git clone https://github.com/mraza007/minute.git
cd minute
npm ci
npm run tauri build
```

## Development

```bash
npm install
npm run tauri dev   # run the app with hot reload
npm test            # frontend tests (vitest)
npm run test:rust   # Rust backend tests (cargo test)
npm run lint        # oxlint
npm run verify      # lint + frontend + build + Rust + release metadata
npm run test:soak   # multi-hour logical recording soak
npm run test:scale  # large synthetic library performance
npm run test:visual # screenshot regression suite
```

## Roadmap

Honestly, in rough priority order:

- **Real-device release matrix** — removable-microphone disconnect/reconnect,
  physical sleep/wake, constrained-volume failure, and overnight finalization.
- **Cross-note ask** — ask-your-notes currently answers from one note's
  transcript at a time; asking across your whole library is the natural
  next step.
- **More models** — the catalog grows as good on-device options do; nothing
  about the architecture is tied to the current lineup.
- **Calendar-aware nudges** — meeting detection currently reacts to the mic
  going hot in a known app; reading your calendar to know a meeting's name
  and attendees ahead of time is scoped but parked for a later release.
- **Per-app audio taps** — system audio currently captures the whole
  machine's output; Apple's newer CATap API would let capture target a
  single app's audio instead, once it's broadly available to build against.

## License

[MIT](LICENSE). The bundled `llama-cpp-2` sources in `src-tauri/vendor/` retain their upstream MIT/Apache-2.0 licensing; model weights downloaded in-app carry their own licenses (Whisper: MIT; Qwen: Apache-2.0; Gemma: Gemma Terms of Use; pyannote segmentation-3.0: MIT; 3D-Speaker CAM++: Apache-2.0).
