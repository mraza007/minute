# Minute UI/UX implementation plan

This backlog turns the UI review into small, verifiable releases. It follows
Minute's existing design direction: calm paper-and-ink surfaces, transcript-led
hierarchy, one oxide recording accent, honest states, and macOS-native behavior.

## Milestone 1 — Recording clarity and polish

Goal: a user can glance at the recording view and immediately understand what
is being captured, whether transcription is healthy, and which actions are
available.

- [x] Show the backend-confirmed microphone name during a recording.
- [x] Distinguish microphone-only capture from microphone + system audio.
- [x] Add a recording details rail for source, transcription, and privacy state.
- [x] Standardize control height, press feedback, disabled state, and motion
      timing.
- [x] Give the live waveform a clear paused state without adding visual noise.
- [x] Gently reveal newly transcribed lines and preserve reduced-motion support.
- [x] Add subtle transcript-edge affordances and keep "Jump to latest" readable.
- [x] Remove non-functional recording actions until their workflow exists.
- [x] Polish note-row hover/selection behavior and expose truncated titles.
- [x] Verify the recording experience in light, dark, and minimum-width layouts.
- [x] Add a dedicated visual regression check for reduced-motion mode.

## Milestone 2 — Pre-recording confidence

Goal: before pressing record, the user knows exactly what Minute will capture.

- [x] Replace the immediate-start action with a compact preflight sheet.
- [x] Identify the real current macOS default microphone on every preflight.
- [x] Add a microphone selector for choosing a non-default input.
- [x] Add a live input level meter with silence and clipping feedback.
- [x] Show system-audio permission and availability before recording starts.
- [x] Explain that capture sources are fixed for the duration of a recording.
- [x] Present transcription modes as Fast, Balanced, and Most accurate, with the
      underlying model name as secondary detail.
- [x] Detect this Mac’s processor and memory, then label each downloadable
      model as Recommended, Good fit, Near memory limit, Below minimum, or Not
      supported without inventing benchmark results.
- [x] Remember the last valid capture setup without hiding device changes.

## Milestone 3 — Active recording confidence

Goal: the recording view remains useful and trustworthy throughout a meeting.

- [x] Detect and explain prolonged silence, clipping, and device disconnection.
- [x] Show transcription lag or backlog when text falls behind audio.
- [x] Make the working title editable while recording.
- [x] Implement timestamped markers with a label and keyboard shortcut.
- [x] Provide recovery guidance without stopping audio capture when transcription
      fails.
- [x] Allow the recording details rail to collapse on smaller windows.
- [x] Add keyboard shortcuts and visible hints for stop and pause/resume.
- [x] Add a keyboard shortcut and visible hint for markers once markers exist.

## Milestone 4 — Processing and note handoff

Goal: stopping a recording feels continuous; users never wonder whether their
audio or transcript was saved.

- [x] Replace the abrupt view switch with explicit Saving audio, Finalizing
      transcript, and Preparing notes states.
- [x] Keep source and duration metadata visible while processing.
- [x] Land on a useful post-recording overview with Summary, Decisions, Action
      items, Transcript, Ask, and Export.
- [x] Keep partially available content usable if summarization fails.
- [x] Provide honest retry and recovery actions for every failed processing
      stage.

## Milestone 5 — Library and transcript navigation

Goal: notes remain easy to find and scan as the local library grows.

- [x] Add pinned, recording status, source, and date filters.
- [x] Improve empty-library and no-search-result states with relevant next
      actions.
- [x] Add a compact/collapsible sidebar mode for narrow windows.
- [x] Strengthen the relationship between transcript timestamps and playback.
- [x] Add speaker rename, speaker filter, and keyboard navigation.
- [x] Preserve scroll position and selection when moving between notes.

## Milestone 6 — Real-device reliability

Goal: Minute remains trustworthy through long meetings and imperfect hardware
conditions, not only the happy path.

- [ ] Run and record a real-device test matrix for permission denial, microphone
      disconnect/reconnect, sleep/wake, and low-disk conditions.
- [x] Add a multi-hour recording soak test covering waveform, transcript, memory,
      and finalization behavior.
- [x] Simulate audio writer, model worker, and post-processing failures in the
      automated app flow.
- [x] Add a privacy-safe diagnostics export for support and bug reports.
- [x] Verify recovery copy and actions against every automated backend failure
      class.

The real-device matrix and evidence template live in
`docs/qa/RELIABILITY_MATRIX.md`. Native microphone denial now passes, and
low-disk failure has deterministic persistence/recovery coverage. Removable
microphone, physical sleep/wake, constrained-volume, and overnight rows remain
pending until the required hardware or unattended test window is available.

## Milestone 7 — Accessibility and alternate input

Goal: every core workflow is understandable and operable without relying on
pointer input, color, or motion.

- [x] Add automated accessibility checks for the library, recording preflight,
      active recording, note overview, transcript, settings, and onboarding.
- [x] Complete a keyboard-only pass with visible focus and logical focus return.
- [x] Complete a VoiceOver pass and resolve landmark, name, state, and live-region
      issues.
- [x] Verify contrast, increased text size, and reduced-motion behavior in both
      appearances.
- [x] Document the supported application shortcuts in an in-app reference.

## Milestone 8 — Editing and meeting cleanup

Goal: users can correct and refine meeting structure without leaving Minute.

- [x] Edit and delete persisted markers from the post-recording overview.
- [x] Add new markers to a completed recording at the current playback time.
- [x] Merge speakers and provide an undo path for speaker renames.
- [x] Remember user-confirmed speaker names for later transcript turns when
      reliable matching data exists.
- [x] Add undo feedback for destructive note-cleanup actions.

## Milestone 9 — Library scale and organization

Goal: large local libraries remain manageable without turning Minute into a
dashboard.

- [x] Add explicit sort options for newest, oldest, duration, and title.
- [x] Add bulk export and recoverable bulk deletion.
- [x] Validate whether lightweight tags or folders improve retrieval before
      implementing either.
- [x] Add per-note storage details and clearer audio-retention controls.
- [x] Measure search and rendering performance against a large synthetic library.

## Milestone 10 — Release readiness

Goal: each release is reproducible, reviewable, and safe to install.

- [x] Add screenshot-diff regression checks for light, dark, reduced-motion, and
      minimum-width layouts.
- [x] Run frontend, Rust, accessibility, and visual checks in CI.
- [ ] Complete macOS signing, notarization, packaging, and updater validation.
- [x] Finalize first-run privacy copy and permission explanations.
- [x] Add a release checklist covering migration compatibility and rollback.

Ad-hoc Apple Silicon and Intel bundles now build with per-binary architecture
verification, and a private-build workflow produces checksummed artifacts.
Final public-release validation stays open until Apple Developer Program
credentials, an updater signing key and HTTPS endpoint, clean-Mac install
targets, a physical Intel launch, and previous-version update/rollback runs are
available.

## Definition of done for each milestone

- Behavior has focused component tests.
- Keyboard focus, labels, hit targets, contrast, and reduced motion are checked.
- Light and dark appearances are visually inspected at standard and narrow
  window sizes.
- No placeholder action appears interactive.
- Copy states what Minute actually knows; no decorative or fake status data.
