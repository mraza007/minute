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
# What actually gets staged is driven by the app binary's own LC_LOAD_DYLIB
# list (via `otool -L`), not a glob of target/<profile>/*.dylib. A glob
# would also catch stale dylibs left over in target/<profile>/ from a
# previous build under different Cargo features (cargo never prunes those,
# it just stops referencing them) — e.g. this is exactly how a prior build
# of this app under llama-cpp-2's default features left a stray, non-
# portable libllama-common.*.dylib sitting in target/debug/ even after
# switching to the trimmed feature set below; a naive glob would have
# silently re-staged it. Reading the binary's actual dependencies makes
# staging match reality regardless of build history.
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
bin="$lib_dir/app"

if [[ ! -x "$bin" ]]; then
  echo "stage-frameworks: $bin not found (cargo build should already have run)" >&2
  exit 1
fi

# The @rpath-relative dylib basenames the app binary actually depends on.
needed_names="$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | grep '^@rpath/' | sed 's#^@rpath/##' | sort -u)"

if [[ -z "$needed_names" ]]; then
  echo "stage-frameworks: $bin has no @rpath dependencies — dynamic-link feature not active?" >&2
  exit 1
fi

rm -rf "$dest"
mkdir -p "$dest"

shopt -s nullglob
copied=()
while IFS= read -r name; do
  [[ -z "$name" ]] && continue

  found=""
  for f in "$lib_dir"/*.dylib; do
    [[ -L "$f" ]] && continue # skip symlinks, only real files have a meaningful install name
    install_name="$(otool -D "$f" | tail -n 1)"
    if [[ "$install_name" == "@rpath/$name" ]]; then
      found="$f"
      break
    fi
  done

  if [[ -z "$found" ]]; then
    echo "stage-frameworks: app binary needs @rpath/$name but no matching dylib (install name @rpath/$name) found in $lib_dir" >&2
    exit 1
  fi

  cp "$found" "$dest/$name"
  copied+=("$name")
done <<< "$needed_names"

# Portability guard: fail loudly if anything staged pulls in a dependency
# by absolute path outside the system (i.e. not /usr/lib or
# /System/Library/Frameworks). This is exactly the bug class that put
# libllama-common's absolute /opt/homebrew/opt/openssl@3 dependency into
# the bundle in the first place — a bundle carrying that would launch fine
# on this machine and fail on any other Mac without that exact Homebrew
# layout.
non_system_deps=""
for name in "${copied[@]}"; do
  while IFS= read -r dep; do
    case "$dep" in
      @rpath/*|/usr/lib/*|/System/Library/Frameworks/*) ;;
      /*)
        non_system_deps+="  $name -> $dep"$'\n'
        ;;
    esac
  done < <(otool -L "$dest/$name" | tail -n +2 | awk '{print $1}')
done

if [[ -n "$non_system_deps" ]]; then
  echo "stage-frameworks: staged dylib(s) depend on non-system absolute paths — these won't exist on other machines:" >&2
  echo -n "$non_system_deps" >&2
  exit 1
fi

expected=(
  "libggml-base.0.dylib"
  "libggml-cpu.0.dylib"
  "libggml-metal.0.dylib"
  "libggml.0.dylib"
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
