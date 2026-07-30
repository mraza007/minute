#!/usr/bin/env bash
set -euo pipefail

signing_identity="Developer ID Application: Muhammad Raza (HL7N7FULXS)"
team_id="HL7N7FULXS"
notary_profile="${MINUTE_NOTARY_PROFILE:-minute-notary}"
target="${MINUTE_MACOS_TARGET:-}"

if [[ -z "$target" ]]; then
  case "$(uname -m)" in
    arm64) target="aarch64-apple-darwin" ;;
    x86_64) target="x86_64-apple-darwin" ;;
    *)
      echo "release build: unsupported host architecture $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

case "$target" in
  aarch64-apple-darwin) expected_arch="arm64" ;;
  x86_64-apple-darwin) expected_arch="x86_64" ;;
  *)
    echo "release build: unsupported target $target" >&2
    exit 1
    ;;
esac

if ! security find-identity -v -p codesigning | grep -Fq "\"$signing_identity\""; then
  echo "release build: signing identity is not available in the login keychain:" >&2
  echo "  $signing_identity" >&2
  exit 1
fi

if ! xcrun notarytool history --keychain-profile "$notary_profile" --output-format json >/dev/null; then
  echo "release build: notarization profile '$notary_profile' is missing or invalid." >&2
  echo "  Create it with: xcrun notarytool store-credentials '$notary_profile'" >&2
  exit 1
fi

export APPLE_SIGNING_IDENTITY="$signing_identity"
export APPLE_TEAM_ID="$team_id"
unset APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

# Updater signing key (issue #4): tauri's bundler requires it whenever
# createUpdaterArtifacts is on, and the post-staple updater archive below is
# signed with it too. Never committed — lives with the developer.
updater_key="${MINUTE_UPDATER_KEY:-$HOME/.tauri/minute-updater.key}"
if [[ ! -f "$updater_key" ]]; then
  echo "release build: updater signing key not found at $updater_key" >&2
  echo "  Generate one with: npm run tauri signer generate -- -w ~/.tauri/minute-updater.key" >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$updater_key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

npm run tauri build -- \
  --target "$target" \
  --bundles app \
  --config src-tauri/tauri.release.conf.json

app_path="src-tauri/target/$target/release/bundle/macos/Minute.app"
bash scripts/verify-macos-bundle.sh "$app_path" "$expected_arch" require-team "$team_id"

submission_archive="$temporary_dir/Minute.zip"
ditto -c -k --keepParent "$app_path" "$submission_archive"
xcrun notarytool submit "$submission_archive" \
  --keychain-profile "$notary_profile" \
  --wait

xcrun stapler staple "$app_path"
xcrun stapler validate "$app_path"
spctl --assess --type execute --verbose=4 "$app_path"

version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
artifact="src-tauri/target/$target/release/bundle/macos/Minute-$version-$expected_arch.zip"
ditto -c -k --keepParent "$app_path" "$artifact"
artifact_dir="$(dirname "$artifact")"
artifact_name="$(basename "$artifact")"
(
  cd "$artifact_dir"
  shasum -a 256 "$artifact_name" > "$artifact_name.sha256"
)

# Updater archive (issue #4): rebuilt HERE, from the stapled app, rather
# than keeping the one `tauri build` produced — that one was archived
# before notarization/stapling. Signed with the updater key; the .sig is
# what latest.json carries and the installed app verifies against its
# baked-in public key.
updater_artifact="$artifact_dir/Minute-$version-$expected_arch.app.tar.gz"
tar -czf "$updater_artifact" -C "$artifact_dir" "Minute.app"
npm run tauri signer sign -- -f "$updater_key" --password "" "$updater_artifact" >/dev/null
if [[ ! -s "$updater_artifact.sig" ]]; then
  echo "release build: updater signature was not produced for $updater_artifact" >&2
  exit 1
fi

echo "release build: signed, notarized, stapled, and Gatekeeper accepted — $artifact"
echo "release build: updater archive signed — $updater_artifact"
