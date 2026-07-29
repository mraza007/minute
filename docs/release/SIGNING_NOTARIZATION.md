# macOS signing, notarization, and updates

Minute's development build uses `bundle.macOS.signingIdentity: "-"`. Production
builds merge `src-tauri/tauri.release.conf.json`, which pins the Developer ID
identity, enables hardened runtime explicitly, and replaces the development
entitlements with `Entitlements.release.plist`.

The release flavor is deliberately separate. Development builds need
`com.apple.security.cs.disable-library-validation` because their bundled
llama/ggml libraries have ad-hoc identities. Production builds sign the main
executable and every bundled library with Team ID `HL7N7FULXS`, so they keep
library validation enabled.

Tauri updater signatures are a separate cryptographic system and do not require
an Apple account. They also do not replace Developer ID or notarization. Minute
does not enable updater artifacts yet because there is no protected updater
private key or stable HTTPS endpoint. Generate and store that key before
enabling `createUpdaterArtifacts`; never commit it or rely on it as a
Gatekeeper bypass.

Required secrets in the GitHub `release` environment:

- `APPLE_CERTIFICATE`: base64 Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`: app-specific password
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` once
  updater artifacts are enabled

`APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID` are intentionally not secrets.
The release config pins `Developer ID Application: Muhammad Raza
(HL7N7FULXS)`, and the workflow sets the public Team ID directly. The workflow
generates a fresh ephemeral keychain password on every run.

Never commit the `.cer`, CSR, `.p12`, `.p8`, passwords, or base64 certificate
text. Those extensions are ignored by Git.

Validation sequence:

1. Import the certificate into an ephemeral CI keychain.
2. Build both Apple Silicon and Intel artifacts with `tauri-apps/tauri-action`.
3. Verify nested frameworks and the app with `codesign --verify --deep --strict`,
   and verify every Mach-O carries the expected Team ID, Developer ID
   authority, and secure timestamp.
4. Submit with `xcrun notarytool`, wait for acceptance, and staple the ticket.
5. Run `spctl --assess --type execute --verbose` on the stapled app.
6. Install on a clean supported Mac and verify microphone and Screen Recording
   permission copy.
7. Enable updater artifacts only after a public key and stable HTTPS endpoint
   are available. Never place the updater private key in the repository.
8. Publish a draft release first, install it, test update from the previous
   version, then promote it.

The workflow validates metadata without secrets on every PR. It fails before a
build when any required release secret is missing.

## Local release build

The local release command uses the installed Developer ID identity and a
Keychain-backed `notarytool` profile. First create an Apple app-specific
password at **account.apple.com → Sign-In and Security → App-Specific
Passwords**. Then store it without putting the password in shell history:

```bash
xcrun notarytool store-credentials minute-notary \
  --apple-id "your Apple Account email" \
  --team-id "HL7N7FULXS"
```

`notarytool` prompts securely for the app-specific password and validates it
with Apple before storing it in Keychain. Once that succeeds:

```bash
npm run build:macos:release
```

Do not put the password in a repository file, command argument, or shell
profile. The command builds the host architecture by default. Set
`MINUTE_MACOS_TARGET` to
`aarch64-apple-darwin` or `x86_64-apple-darwin` when validating a specific
target. Set `MINUTE_NOTARY_PROFILE` only if you used a different profile name.
A successful run verifies the signed bundle, submits a temporary ZIP to Apple,
waits for acceptance, staples the ticket, runs Gatekeeper, and emits a final
ZIP plus SHA-256 checksum.

The signing identity is installed and locally verified:

```text
Developer ID Application: Muhammad Raza (HL7N7FULXS)
```

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

## Minute 1.0 release validation — July 29, 2026

Status: **Production signing and notarization pass**

- Installed and verified `Developer ID Application: Muhammad Raza
  (HL7N7FULXS)`.
- Built separate Apple Silicon and Intel release-flavor applications.
- Signed the main executable and all five llama/ggml dylibs with the same
  Developer ID identity and secure timestamps.
- Verified both bundles with strict code-sign checks, the expected
  architectures, Team ID `HL7N7FULXS`, and hardened runtime.
- Removed the development-only library-validation exception from production
  entitlements.
- Launched the signed Apple Silicon build successfully with production library
  validation enabled.
- Apple accepted both Minute 1.0 notarization submissions:
  - Apple Silicon: `60e69d55-78f9-4cf7-b8fa-bb632aad41da`
  - Intel: `df0aa212-aeb1-447c-b699-ffde03b597c1`
- Stapled and validated both tickets, then received `source=Notarized Developer
  ID` from Gatekeeper for both architecture-specific apps.
- Produced and checksum-verified `Minute-1.0.0-arm64.zip` and
  `Minute-1.0.0-x86_64.zip` release artifacts.

Remaining automation and validation work includes a clean-Mac Gatekeeper and
microphone-permission test, GitHub release secrets before using the CI workflow,
an updater key and endpoint, and update/rollback tests. Physical Intel launch
validation also remains pending.
