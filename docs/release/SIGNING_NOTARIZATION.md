# macOS signing, notarization, and updates

Minute's unsigned development build uses `bundle.macOS.signingIdentity: "-"`.
Production releases must override that identity in CI and must not commit
certificate material.

## If you do not have an Apple account or Developer Program membership

There is no technical workaround that produces the same public-install trust.
Developer ID certificates are issued through the Apple Developer Program, and
Apple notarizes Developer-ID-signed software. Without those credentials Minute
can still be built and ad-hoc signed for development or direct private sharing,
but Gatekeeper will identify it as coming from an unidentified developer and a
clean Mac will require a manual user override.

Use the **Ad-hoc private macOS build** workflow for that private track. It:

- builds separate Apple Silicon and Intel apps;
- checks the main executable and every bundled dylib for the intended
  architecture;
- validates the ad-hoc code signature; and
- uploads a ZIP plus SHA-256 checksum.

This private track is not a production substitute: it cannot pass
notarization, stapling, or an ordinary clean-Mac Gatekeeper assessment.

Tauri updater signatures are a separate cryptographic system and do not require
an Apple account. They also do not replace Developer ID or notarization. Minute
does not enable updater artifacts yet because there is no protected updater
private key or stable HTTPS endpoint. Generate and store that key before
enabling `createUpdaterArtifacts`; never commit it or rely on it as a
Gatekeeper bypass.

Required GitHub secrets:

- `APPLE_CERTIFICATE`: base64 Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` once
  updater artifacts are enabled

Validation sequence:

1. Import the certificate into an ephemeral CI keychain.
2. Build both Apple Silicon and Intel artifacts with `tauri-apps/tauri-action`.
3. Verify nested frameworks and the app with `codesign --verify --deep --strict`.
4. Submit with `xcrun notarytool`, wait for acceptance, and staple the ticket.
5. Run `spctl --assess --type execute --verbose` on the stapled app.
6. Install on a clean supported Mac and verify microphone and Screen Recording
   permission copy.
7. Enable updater artifacts only after a public key and stable HTTPS endpoint
   are available. Never place the updater private key in the repository.
8. Publish a draft release first, install it, test update from the previous
   version, then promote it.

The workflow validates metadata without secrets on every PR. A signed,
notarized release remains blocked until the secrets and clean-Mac validation
environment exist.

## Local packaging preflight — July 27, 2026

Status: **Development bundle pass; production trust pending**

- Built an isolated Apple Silicon `.app` with all five llama/ggml dynamic
  libraries staged in `Contents/Frameworks`.
- `codesign --verify --deep --strict --verbose=2` validated the app executable,
  nested frameworks, sealed resources, and designated requirement.
- The local bundle correctly reports `arm64`, hardened runtime, and an ad-hoc
  signature. It intentionally has no Team Identifier and therefore cannot pass
  Gatekeeper or notarization.
- `spctl --assess` did not accept the ad-hoc bundle, which is the expected
  pre-release result rather than a packaging regression.
- The release workflow now repeats strict code-sign verification, stapler
  validation, and Gatekeeper assessment on each signed architecture before the
  draft release can finish.

## Intel packaging validation — July 28, 2026

Status: **Cross-build pass; physical Intel launch pending**

- Installed the `x86_64-apple-darwin` Rust target and completed both `cargo
  check` and a full ad-hoc `.app` build.
- Found and fixed an architecture-staging defect: the original hook read
  `target/debug` even during an Intel build, so the x86_64 executable was
  bundled with arm64 llama/ggml dylibs. Strict code-sign verification did not
  detect that mismatch.
- The staging hook now uses `TAURI_ENV_TARGET_TRIPLE` and fails unless every
  nested dylib contains every architecture in the app executable.
- Rebuilt and verified the executable plus all five dylibs as x86_64, then
  passed `codesign --verify --deep --strict`.
- Launch, microphone permission, and transcription on physical Intel hardware
  remain pending because this host is Apple Silicon.

Production completion still requires Apple Developer Program credentials, the
updater key and endpoint, a notarization response from Apple, and install/update
tests on clean Apple Silicon and Intel Macs.
