# Minute

Minute is a fully offline meeting notetaker. It records audio, transcribes it on-device with Whisper, and produces summaries using a local LLM — no audio or text ever leaves the machine. Built with Tauri 2 and React.

## Development

```bash
npm install
npm run tauri dev
npm test          # frontend tests (vitest)
npm run test:rust # Rust backend tests (cargo test)
```

## Known debt

- CSP is currently `null` in `src-tauri/tauri.conf.json` — tighten before Stage 4 release.
- Google Fonts dependency to be removed once fonts are bundled locally.
