#!/usr/bin/env bash
# One-off repair for issue #17: the v1.6.0 updater tarballs on GitHub contain
# AppleDouble `._*` entries (macOS tar copyfile mode), and the installed app's
# updater dies with "failed to unpack `._Minute.app`". This re-signs the
# repaired tarballs (same app bytes, metadata entries stripped), regenerates
# latest.json, and replaces the release assets. Safe to delete after v1.6.1.
set -euo pipefail

repaired_dir="${1:?usage: repair-v1.6.0-updater-assets.sh <dir with repaired Minute-1.6.0-*.app.tar.gz>}"
updater_key="${MINUTE_UPDATER_KEY:-$HOME/.tauri/minute-updater.key}"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$updater_key")"

for arch in arm64 x86_64; do
  artifact="$repaired_dir/Minute-1.6.0-$arch.app.tar.gz"
  python3 - "$artifact" <<'EOF'
import sys, tarfile
bad = [n for n in tarfile.open(sys.argv[1]).getnames() if n.rpartition("/")[2].startswith("._")]
if bad:
    sys.exit(f"refusing to ship {sys.argv[1]}: still contains {bad}")
EOF
  npm run tauri signer sign -- --password "" "$artifact" >/dev/null
  test -s "$artifact.sig"
done

python3 - "$repaired_dir" <<'EOF'
import base64, json, sys, urllib.request
d = sys.argv[1]
url = "https://github.com/mraza007/minute/releases/latest/download/latest.json"
manifest = json.load(urllib.request.urlopen(url))
for arch, plat in (("arm64", "darwin-aarch64"), ("x86_64", "darwin-x86_64")):
    with open(f"{d}/Minute-1.6.0-{arch}.app.tar.gz.sig", "rb") as f:
        manifest["platforms"][plat]["signature"] = f.read().decode()
with open(f"{d}/latest.json", "w") as f:
    json.dump(manifest, f, indent=2)
print("latest.json regenerated")
EOF

gh release upload v1.6.0 --repo mraza007/minute --clobber \
  "$repaired_dir/Minute-1.6.0-arm64.app.tar.gz" \
  "$repaired_dir/Minute-1.6.0-arm64.app.tar.gz.sig" \
  "$repaired_dir/Minute-1.6.0-x86_64.app.tar.gz" \
  "$repaired_dir/Minute-1.6.0-x86_64.app.tar.gz.sig" \
  "$repaired_dir/latest.json"
echo "repair complete: v1.6.0 updater assets replaced"
