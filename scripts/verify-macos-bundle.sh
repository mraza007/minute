#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: verify-macos-bundle.sh APP_PATH EXPECTED_ARCH [require-team]}"
expected_arch="${2:?usage: verify-macos-bundle.sh APP_PATH EXPECTED_ARCH [require-team]}"
trust_mode="${3:-adhoc}"

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

signature="$(codesign -dv --verbose=4 "$app_path" 2>&1)"
if [[ "$trust_mode" == "require-team" ]] && grep -q 'TeamIdentifier=not set' <<<"$signature"; then
  echo "bundle verification: production bundle has no Apple team identifier" >&2
  exit 1
fi

echo "bundle verification: pass ($expected_arch, $trust_mode) — $app_path"
