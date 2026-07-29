# Minute release checklist

## Data and migration

- [ ] Back up a library from the previous release.
- [ ] Open it in the candidate and verify legacy metadata defaults.
- [ ] Create, record, finalize, rename, merge, export, delete, and restore a note.
- [ ] Downgrade using the backup and confirm the rollback procedure.

## Quality gates

- [x] `npm ci`
- [x] `npm run verify`
- [x] `npm run test:soak`
- [x] `npm run test:scale`
- [x] `npm run test:visual`
- [ ] Real-device reliability matrix completed.
- [ ] Keyboard, VoiceOver, contrast, 200% zoom, and reduced-motion matrix completed.

## Packaging

- [x] Versions match in package.json, Cargo.toml, and tauri.conf.json.
- [x] Release notes include data-model or permission-copy changes.
- [x] Developer ID Application identity is installed and recognized locally.
- [x] Production flavor pins Team ID `HL7N7FULXS`, hardened runtime, and
      release-safe entitlements.
- [x] Apple Silicon and Intel ad-hoc bundles build with matching nested architectures.
- [x] Apple Silicon and Intel production-signed bundles build.
- [x] Nested frameworks pass strict code-sign verification.
- [x] Notarization is accepted and stapled.
- [ ] Gatekeeper assessment passes on a clean Mac.
- [ ] Microphone and Screen Recording prompts show the intended copy.

## Update and rollback

- [ ] Previous release updates to the candidate through the signed updater.
- [ ] Interrupted update leaves the previous version launchable.
- [ ] Rollback artifact and library-backup instructions are available.
- [x] GitHub release artifacts and checksums are reviewed before publish.

## Distribution decision

- [x] Public release: Apple Developer Program membership, Developer ID,
      notarization, stapling, local Gatekeeper assessment, architecture-specific
      ZIP artifacts, and SHA-256 checksums are available.
- [x] Retire the ad-hoc private beta releases after Minute 1.0 is public.
