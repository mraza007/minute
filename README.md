# Minute

Minute is a fully offline meeting notetaker. It records audio, transcribes it on-device with Whisper, and produces summaries using a local LLM — no audio or text ever leaves the machine. Built with Tauri 2 and React.

## Status

Stage 4 complete: Minute now ships as a bundled `.app` that runs both models
standalone (no `cargo`/dev environment needed), with real audio playback and
seek-from-transcript, a ⌘K search palette, per-note ask-your-notes with
timestamp citations, a 30-day audio-deletion sweep, dark mode that follows
macOS appearance, and an LLM idle-unload janitor plus virtualized transcripts
for long meetings. The encryption toggle was replaced with an honest note
about FileVault. The app is feature-complete for personal use.

## Development

```bash
npm install
npm run tauri dev
npm test          # frontend tests (vitest)
npm run test:rust # Rust backend tests (cargo test)
```

## Known debt

- The chunk dedupe midpoint rule can drop up to ~1s of text straddling a chunk
  boundary (documented and `log::debug!`'d in `stt.rs`).
- CSP's `media-src` entries (asset protocol, for playback) still want a
  manual runtime check.
- Speaker diarization/rename and cross-note retrieval (ask across every
  note, not just the open one) are both future work.
- whisper-rs 0.16.0's log trampoline has a known upstream UB edge case on a
  null text pointer from whisper.cpp — tracked, not fixable from this repo.
