# Minute release checklist

## Data and migration

- [ ] Back up a library from the previous release.
- [ ] Open it in the candidate and verify legacy metadata defaults.
- [ ] Create, record, finalize, rename, merge, export, delete, and restore a note.
- [ ] Downgrade using the backup and confirm the rollback procedure.

## Quality gates

- [ ] `npm ci`
- [ ] `npm run verify`
- [ ] `npm run test:soak`
- [ ] `npm run test:scale`
- [ ] `npm run test:visual`
- [ ] Real-device reliability matrix completed.
- [ ] Keyboard, VoiceOver, contrast, 200% zoom, and reduced-motion matrix completed.

## Packaging

- [ ] Versions match in package.json, Cargo.toml, and tauri.conf.json.
- [ ] Release notes include data-model or permission-copy changes.
- [x] Apple Silicon and Intel ad-hoc bundles build with matching nested architectures.
- [ ] Apple Silicon and Intel production-signed bundles build.
- [ ] Nested frameworks pass strict code-sign verification.
- [ ] Notarization is accepted and stapled.
- [ ] Gatekeeper assessment passes on a clean Mac.
- [ ] Microphone and Screen Recording prompts show the intended copy.

## Update and rollback

- [ ] Previous release updates to the candidate through the signed updater.
- [ ] Interrupted update leaves the previous version launchable.
- [ ] Rollback artifact and library-backup instructions are available.
- [ ] Draft GitHub release artifacts and checksums are reviewed before publish.

## Distribution decision

- [ ] Public release: Apple Developer Program membership, Developer ID,
      notarization, stapling, and clean-Mac Gatekeeper pass are available.
- [x] Private fallback: ad-hoc Apple Silicon/Intel workflow, architecture
      verification, ZIP artifacts, and SHA-256 checksums are available.
- [ ] Private recipients are warned that manual Gatekeeper override is required
      and that the build is not notarized.
