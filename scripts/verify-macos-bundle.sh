#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: verify-macos-bundle.sh APP_PATH EXPECTED_ARCH [require-team [EXPECTED_TEAM_ID]]}"
expected_arch="${2:?usage: verify-macos-bundle.sh APP_PATH EXPECTED_ARCH [require-team [EXPECTED_TEAM_ID]]}"
trust_mode="${3:-adhoc}"
expected_team_id="${4:-}"

if [[ "$expected_arch" == "aarch64" ]]; then
  expected_arch="arm64"
fi

if [[ ! -d "$app_path" ]]; then
  echo "bundle verification: app not found: $app_path" >&2
  exit 1
fi

binaries=("$app_path/Contents/MacOS/app")
while IFS= read -r framework; do
  binaries+=("$framework")
done < <(find "$app_path/Contents/Frameworks" -type f -name '*.dylib' -print | sort)

for binary in "${binaries[@]}"; do
  if ! lipo "$binary" -verify_arch "$expected_arch" >/dev/null 2>&1; then
    echo "bundle verification: $(basename "$binary") is $(lipo -archs "$binary"), expected $expected_arch" >&2
    exit 1
  fi
done

codesign --verify --deep --strict --verbose=2 "$app_path"

entitlements="$(codesign -d --entitlements :- "$app_path" 2>/dev/null || true)"
if ! grep -q 'com.apple.security.device.audio-input' <<<"$entitlements"; then
  echo "bundle verification: app lacks com.apple.security.device.audio-input; the hardened runtime denies the microphone without ever prompting" >&2
  exit 1
fi

if [[ "$trust_mode" == "require-team" ]]; then
  for binary in "${binaries[@]}"; do
    signature="$(codesign -dv --verbose=4 "$binary" 2>&1)"

    if grep -q 'TeamIdentifier=not set' <<<"$signature"; then
      echo "bundle verification: production binary has no Apple team identifier: $binary" >&2
      exit 1
    fi
    if ! grep -q 'Authority=Developer ID Application:' <<<"$signature"; then
      echo "bundle verification: production binary is not signed with Developer ID Application: $binary" >&2
      exit 1
    fi
    if ! grep -Eq '^Timestamp=|^Signed Time=' <<<"$signature"; then
      echo "bundle verification: production binary has no secure timestamp: $binary" >&2
      exit 1
    fi
    if [[ "$binary" == "$app_path/Contents/MacOS/app" ]] && ! grep -Eq '^Runtime Version=|flags=.*runtime' <<<"$signature"; then
      echo "bundle verification: main executable does not use hardened runtime" >&2
      exit 1
    fi
    if [[ -n "$expected_team_id" ]] && ! grep -q "TeamIdentifier=$expected_team_id" <<<"$signature"; then
      echo "bundle verification: $(basename "$binary") is not signed by expected team $expected_team_id" >&2
      exit 1
    fi
  done

  if grep -q 'com.apple.security.cs.disable-library-validation' <<<"$entitlements"; then
    echo "bundle verification: production app disables library validation" >&2
    exit 1
  fi
  if grep -q 'com.apple.security.get-task-allow' <<<"$entitlements"; then
    echo "bundle verification: production app enables get-task-allow" >&2
    exit 1
  fi
fi

echo "bundle verification: pass ($expected_arch, $trust_mode${expected_team_id:+, team $expected_team_id}) — $app_path"
