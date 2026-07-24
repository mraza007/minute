# Minute

Minute is a fully offline meeting notetaker. It records audio, transcribes it on-device with Whisper, and produces summaries using a local LLM — no audio or text ever leaves the machine. Built with Tauri 2 and React.

## Status

Stage 3 complete: records, live-transcribes, and summarizes meetings fully
on-device — summaries, decisions, and action items are generated in-process
by a local Qwen3.5 model. Stage 4 next: ask-your-notes, playback, search,
polish.

## Development

```bash
npm install
npm run tauri dev
npm test          # frontend tests (vitest)
npm run test:rust # Rust backend tests (cargo test)
```

## Known debt

- CSP is currently `null` in `src-tauri/tauri.conf.json` — tighten before Stage 4 release.
- Google Fonts dependency (Instrument Sans) to be removed once fonts are bundled locally.
- The chunk dedupe midpoint rule can drop up to ~1s of text straddling a chunk
  boundary (documented and `log::debug!`'d in `stt.rs`).
- The LLM stays resident in memory after the first summary (~2.6 GB) —
  unload-after-idle is deferred.
- `summaryStatus`/`summaryError` records accumulate unbounded per session
  (`deleteNote` doesn't prune them).
- `useAppState` is ~650 lines — extract a `useNoteDetail` hook in Stage 4.
