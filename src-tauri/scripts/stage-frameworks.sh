#!/usr/bin/env bash
# Stages the ggml/llama dylibs produced by llama-cpp-2's `dynamic-link`
# feature (ODR fix vs whisper-rs's vendored ggml, fc9bbdb) into a stable
# path that tauri.conf.json's `bundle.macOS.frameworks` can reference.
#
# Why this exists: llama-cpp-sys-2's build script writes the dylibs under
# target/<profile>/build/llama-cpp-sys-2-<HASH>/out/lib/, and the <HASH>
# changes across rebuilds (feature/profile changes, cargo cache state) —
# not a path tauri.conf.json can hardcode. Cargo also copies/symlinks the
# same dylibs directly into target/<profile>/ next to the app binary
# (needed for `cargo run`/`cargo test` to resolve them via cargo's own
# DYLD search path injection), so we copy from there instead of the hashed
# build dir.
#
# Each dylib is written out under its Mach-O install-name basename (e.g.
# "libggml-base.0.dylib", not the on-disk "libggml-base.0.13.1.dylib"),
# because that install-name basename is exactly what the app binary's
# @rpath references resolve at launch — see .cargo/config.toml for the
# LC_RPATH that points at Contents/Frameworks (where tauri copies this
# staging dir's contents).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src_tauri_dir="$(dirname "$script_dir")"
dest="$src_tauri_dir/frameworks"

profile="debug"
if [[ "${TAURI_ENV_DEBUG:-}" == "false" ]]; then
  profile="release"
fi
lib_dir="$src_tauri_dir/target/$profile"

if [[ ! -d "$lib_dir" ]]; then
  echo "stage-frameworks: $lib_dir not found (cargo build should already have run)" >&2
  exit 1
fi

rm -rf "$dest"
mkdir -p "$dest"

shopt -s nullglob
copied=()
for f in "$lib_dir"/libggml*.dylib "$lib_dir"/libllama*.dylib; do
  # Only real files carry a meaningful install name; the unversioned/
  # major-only symlinks cargo also drops in target/<profile>/ resolve to
  # the same content and would just duplicate an entry.
  [[ -L "$f" ]] && continue

  install_name="$(otool -D "$f" | tail -n 1)"
  case "$install_name" in
    @rpath/*)
      target_name="${install_name#@rpath/}"
      ;;
    *)
      echo "stage-frameworks: $f has non-@rpath install name '$install_name' — refusing to guess a bundle-safe name" >&2
      exit 1
      ;;
  esac

  cp "$f" "$dest/$target_name"
  copied+=("$target_name")
done

expected=(
  "libggml-base.0.dylib"
  "libggml-cpu.0.dylib"
  "libggml-metal.0.dylib"
  "libggml.0.dylib"
  "libllama-common.0.dylib"
  "libllama.0.dylib"
)

staged_sorted="$(printf '%s\n' "${copied[@]}" | sort)"
expected_sorted="$(printf '%s\n' "${expected[@]}" | sort)"
if [[ "$staged_sorted" != "$expected_sorted" ]]; then
  echo "stage-frameworks: staged dylib set changed from what tauri.conf.json's bundle.macOS.frameworks expects." >&2
  echo "  staged:   $(printf '%s ' "${copied[@]}")" >&2
  echo "  expected: $(printf '%s ' "${expected[@]}")" >&2
  echo "  Update both this list and tauri.conf.json's frameworks array together." >&2
  exit 1
fi

echo "stage-frameworks: staged ${#copied[@]} dylib(s) into $dest"
