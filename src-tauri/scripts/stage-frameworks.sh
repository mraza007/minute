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
expected_arch="${TAURI_ENV_ARCH:-}"
if [[ "$expected_arch" == "aarch64" ]]; then
  expected_arch="arm64"
fi

# Cargo writes native builds to target/<profile> and explicit --target builds
# to target/<triple>/<profile>. Tauri exposes the architecture to
# beforeBundleCommand, but does not consistently expose the full target triple
# there. Include every explicit macOS target directory, then pick the newest
# candidate matching the requested architecture so a stale build for a
# different target can never supply the bundle's executable or dylibs.
candidate_dirs=()
if [[ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]]; then
  candidate_dirs+=("$src_tauri_dir/target/${TAURI_ENV_TARGET_TRIPLE}/$profile")
fi
for candidate in "$src_tauri_dir"/target/*-apple-darwin/"$profile"; do
  [[ -d "$candidate" ]] || continue
  candidate_dirs+=("$candidate")
done
candidate_dirs+=("$src_tauri_dir/target/$profile")

lib_dir=""
for candidate in "${candidate_dirs[@]}"; do
  candidate_bin="$candidate/app"
  [[ -x "$candidate_bin" ]] || continue
  if [[ -n "$expected_arch" ]] && ! lipo "$candidate_bin" -verify_arch "$expected_arch" >/dev/null 2>&1; then
    continue
  fi
  if [[ -z "$lib_dir" || "$candidate_bin" -nt "$lib_dir/app" ]]; then
    lib_dir="$candidate"
  fi
done

if [[ -z "$lib_dir" ]]; then
  echo "stage-frameworks: no freshly built app matched architecture ${expected_arch:-<unknown>}" >&2
  exit 1
fi
bin="$lib_dir/app"

if [[ ! -x "$bin" ]]; then
  echo "stage-frameworks: $bin not found (cargo build should already have run)" >&2
  exit 1
fi

# Guard: the app binary itself must carry the LC_RPATH that makes its
# @rpath/*.dylib references resolvable at launch (added via
# `-Wl,-rpath,@executable_path/../Frameworks` in .cargo/config.toml's
# target rustflags). A RUSTFLAGS env var set anywhere in the build
# environment (e.g. `-D warnings` in CI) *replaces* — does not merge with —
# .cargo/config.toml's target rustflags, silently dropping this -rpath
# flag; the compile and bundle both still succeed, but the shipped app
# fails to load its dylibs at launch on any machine. Catch that here
# instead of at a user's launch.
if ! otool -l "$bin" | grep -qF 'path @executable_path/../Frameworks'; then
  echo "stage-frameworks: $bin has no LC_RPATH for @executable_path/../Frameworks." >&2
  echo "  This binary won't be able to load its @rpath dylibs after bundling." >&2
  echo "  Likely cause: a RUSTFLAGS env var (e.g. -D warnings in CI) replaced" >&2
  echo "  .cargo/config.toml's target rustflags instead of merging with them," >&2
  echo "  silently dropping the -Wl,-rpath,@executable_path/../Frameworks flag." >&2
  echo "  Rebuild without an overriding RUSTFLAGS, or fold it into the" >&2
  echo "  [target.*.rustflags] array in .cargo/config.toml instead." >&2
  exit 1
fi

# The @rpath-relative dylib basenames the app binary actually depends on.
# The `{ grep ... || true; }` guards against `set -o pipefail` treating a
# legitimate zero-matches result (e.g. dynamic-link feature not active) as
# a pipeline failure — under `set -e` that would abort the script on this
# line before the explicit empty-check below ever gets to print its
# diagnostic.
needed_names="$(otool -L "$bin" | tail -n +2 | awk '{print $1}' | { grep '^@rpath/' || true; } | sed 's#^@rpath/##' | sort -u)"

if [[ -z "$needed_names" ]]; then
  echo "stage-frameworks: $bin has no @rpath dependencies — dynamic-link feature not active?" >&2
  exit 1
fi

rm -rf "$dest"
mkdir -p "$dest"

copied=()
while IFS= read -r name; do
  [[ -z "$name" ]] && continue

  # Resolve the exact symlink cargo drops in target/<profile>/ for this
  # dylib (e.g. libggml-base.0.dylib -> libggml-base.0.13.1.dylib) rather
  # than scanning every *.dylib for a matching install name: cargo
  # recreates that symlink fresh on every build, so it always points at
  # the current version, whereas a glob scan picks whichever real file
  # happens to sort first — if a ggml version bump ever leaves an old
  # fully-versioned file behind alongside the new one (both sharing the
  # same @rpath install name), glob order rather than recency decides
  # which one ships.
  link="$lib_dir/$name"
  if [[ ! -e "$link" ]]; then
    echo "stage-frameworks: app binary needs @rpath/$name but $link doesn't exist" >&2
    exit 1
  fi

  resolved="$(readlink -f "$link" 2>/dev/null || true)"
  if [[ -z "$resolved" || ! -f "$resolved" ]]; then
    echo "stage-frameworks: $link's symlink target is missing or invalid (resolved to '${resolved:-<empty>}')" >&2
    exit 1
  fi

  cp "$resolved" "$dest/$name"

  # A strict signature does not prove a nested binary matches the app's
  # architecture. In particular, an Intel cross-build can otherwise bundle
  # stale Apple Silicon dylibs from target/debug and still pass codesign.
  while IFS= read -r arch; do
    [[ -z "$arch" ]] && continue
    if ! lipo "$dest/$name" -verify_arch "$arch" >/dev/null 2>&1; then
      echo "stage-frameworks: $name does not contain required app architecture $arch" >&2
      echo "  app:   $(lipo -archs "$bin")" >&2
      echo "  dylib: $(lipo -archs "$dest/$name")" >&2
      exit 1
    fi
  done < <(lipo -archs "$bin" | tr ' ' '\n')

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

echo "stage-frameworks: staged ${#copied[@]} dylib(s) from ${lib_dir#"$src_tauri_dir/"} into $dest"
