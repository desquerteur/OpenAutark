#!/usr/bin/env bash
# Owns: a private, checksum-pinned Node runtime for release tools on Linux/macOS.
# Never: installs app dependencies, builds product code, or edits shell/system settings.
set -euo pipefail

mode=${1:---check}
if [[ $# -gt 1 || ! "$mode" =~ ^--(check|install)$ ]]; then
  printf 'Usage: bash node-runtime.sh [--check|--install]\n' >&2
  exit 2
fi

version=24.22.2
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform=linux-x64; extension=tar.xz
    checksum=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;;
  Darwin-arm64)
    platform=darwin-arm64; extension=tar.gz
    checksum=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a ;;
  Darwin-x86_64)
    platform=darwin-x64; extension=tar.gz
    checksum=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
  *) printf 'Supported hosts: Linux x64, macOS arm64/x64.\n' >&2; exit 2 ;;
esac

tools=${XDG_DATA_HOME:-$HOME/.local/share}/workforce-release
target=$tools/node-v$version-$platform
archive=node-v$version-$platform.$extension
if [[ "$tools" != /* ]]; then
  printf 'The tools directory must be an absolute path.\n' >&2; exit 2
fi

verify_runtime() {
  [[ -x "$target/bin/node" && -f "$target/bin/npm" ]] || return 1
  [[ "$("$target/bin/node" --version)" == "v$version" ]]
}

if ! verify_runtime; then
  if [[ "$mode" != --install ]]; then
    printf 'Missing private Node %s (%s). Run with --install.\n' "$version" "$platform" >&2
    exit 1
  fi
  if [[ -e "$target" || -L "$target" ]]; then
    printf 'An incomplete runtime already exists; refusing to overwrite it: %s\n' "$target" >&2
    exit 1
  fi
  for tool in curl tar; do command -v "$tool" >/dev/null; done
  if [[ "$platform" == linux-* ]]; then command -v xz >/dev/null; fi
  mkdir -p "$tools"
  stage=$(mktemp -d "$tools/.node-XXXXXXXX")
  cleanup() {
    if [[ -n "${stage:-}" && "$stage" == "$tools"/.node-* ]]; then rm -rf -- "$stage"; fi
  }
  trap cleanup EXIT
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 600 --retry 2 \
    "https://nodejs.org/dist/v$version/$archive" --output "$stage/$archive"
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$stage/$archive"); actual=${actual%% *}
  else
    actual=$(shasum -a 256 "$stage/$archive"); actual=${actual%% *}
  fi
  if [[ "$actual" != "$checksum" ]]; then
    printf 'Node archive checksum mismatch; nothing installed.\n' >&2; exit 1
  fi
  tar -xf "$stage/$archive" -C "$stage"
  [[ -x "$stage/node-v$version-$platform/bin/node" ]]
  mv "$stage/node-v$version-$platform" "$target"
  verify_runtime
  printf 'Verified Node archive SHA-256: %s\n' "$checksum"
fi

if [[ "$mode" == --install ]]; then
  # Explicit opt-in activation; no .profile/.bashrc or global Node changes.
  printf 'export PATH=%q/bin:"$PATH"\n' "$target" > "$tools/env.sh"
fi
export PATH="$target/bin:$PATH"
printf 'Node: %s\n' "$(node --version)"
printf 'npm: %s\n' "$(npm --version)"
printf 'Runtime: %s\n' "$target"
printf 'Activate: source %q\n' "$tools/env.sh"
