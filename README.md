<div align="center">

# Minute

**Meeting notes that never leave your Mac.**

![platform](https://img.shields.io/badge/platform-macOS-black)
![version](https://img.shields.io/badge/version-1.0.0-c8412a)

![Minute meeting overview](screenshots/hero.png)

**[Download for Apple Silicon](https://github.com/mraza007/minute/releases/download/v1.0.0/Minute-1.0.0-arm64.zip)**

[Download for Intel](https://github.com/mraza007/minute/releases/download/v1.0.0/Minute-1.0.0-x86_64.zip)

</div>

Minute is an offline meeting notetaker for macOS. It records audio, transcribes
with Whisper, and turns the transcript into a summary, decisions, and action
items using local models.

No account, cloud service, or server is required. Models download once and run
on your Mac after that.

## Features

- Live microphone transcription
- Optional system-audio capture on macOS 13 or later
- Local summaries, decisions, and action items
- Questions answered from the transcript with timestamp citations
- Speaker names, markers, search, filters, and bulk export
- Plain local files for recordings, transcripts, and notes

## Install

Download the build for your Mac, unzip it, and drag `Minute.app` into
Applications. Minute asks for microphone access when you start your first
recording. System-audio capture also needs Screen Recording access.

## Requirements

- macOS 11 or later
- macOS 13 or later for system-audio capture
- About 3 GB of free space for the default transcription and summary models

Apple Silicon is the tested and recommended target. An Intel build is also
available.

## Build from source

```bash
git clone https://github.com/mraza007/minute.git
cd minute
npm ci
npm run tauri build
```

Run the development build with:

```bash
npm run tauri dev
```

## Development

```bash
npm test
npm run test:rust
npm run lint
npm run verify
```

Minute uses Tauri, React, TypeScript, Rust, whisper.cpp, and llama.cpp.

## License

[MIT](LICENSE)
