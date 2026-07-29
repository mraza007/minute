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
  echo "  Create it with the command documented in docs/release/SIGNING_NOTARIZATION.md." >&2
  exit 1
fi

export APPLE_SIGNING_IDENTITY="$signing_identity"
export APPLE_TEAM_ID="$team_id"
unset APPLE_ID APPLE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

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
shasum -a 256 "$artifact" > "$artifact.sha256"

echo "release build: signed, notarized, stapled, and Gatekeeper accepted — $artifact"
