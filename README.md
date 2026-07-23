# Minute

Minute is a fully offline meeting notetaker. It records audio, transcribes it on-device with Whisper, and produces summaries using a local LLM — no audio or text ever leaves the machine. Built with Tauri 2 and React.

## Status

Stage 2 complete: records real audio, transcribes it live on-device with Whisper,
and persists notes locally as plain folders (audio + transcript + metadata).
Stage 3 (summaries via a local LLM) is next.

## Development

```bash
npm install
npm run tauri dev
npm test          # frontend tests (vitest)
npm run test:rust # Rust backend tests (cargo test)
```

## Known debt

- `set_settings`/`get_settings` backend not built yet — sttModel selection and
  the two Settings toggles are frontend-local only.
- `NoteView` takes the whole `AppState` blob instead of narrow props like its
  siblings — refactor before Stage 3 adds summary state to it.
- Transcript cache is an unbounded per-session `Map` — add an LRU cap later.
- CSP is currently `null` in `src-tauri/tauri.conf.json` — tighten before Stage 4 release.
- Google Fonts dependency (Instrument Sans) to be removed once fonts are bundled locally.
- The chunk dedupe midpoint rule can drop up to ~1s of text straddling a chunk
  boundary (documented and `log::debug!`'d in `stt.rs`).
