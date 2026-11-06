#!/usr/bin/env bash
# Owns: macOS tool availability and optional signing prerequisite checks.
# Never: reads signing keys, imports certificates, contacts Apple, or builds product code.
set -euo pipefail
mode=${1:---tools}
if [[ $# -gt 1 || ! "$mode" =~ ^--(tools|signing)$ ]]; then
  printf 'Usage: bash preflight-macos.sh [--tools|--signing]\n' >&2; exit 2
fi
[[ "$(uname -s)" == Darwin ]] || { printf 'A real macOS host is required.\n' >&2; exit 2; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$here/node-runtime.sh" --check
source "${XDG_DATA_HOME:-$HOME/.local/share}/workforce-release/env.sh"
for tool in git codesign security hdiutil ditto; do command -v "$tool" >/dev/null; done
xcode-select -p >/dev/null
for tool in clang lipo notarytool stapler; do xcrun --find "$tool" >/dev/null; done
[[ "$(node -p 'process.platform')" == darwin ]]
printf 'macOS build and notarization tools: available.\n'
if [[ "$mode" == --signing ]]; then
  identities=$(security find-identity -v -p codesigning)
  if ! grep -q '"Developer ID Application:' <<< "$identities"; then
    printf 'No valid Developer ID Application identity with a private key in the keychain.\n' >&2
    exit 1
  fi
  # Check presence only; never read or print key contents or account values.
  [[ -n "${APPLE_API_KEY:-}" && -r "$APPLE_API_KEY" ]] || {
    printf 'APPLE_API_KEY must point to the protected notarization key file.\n' >&2; exit 1;
  }
  [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]] || {
    printf 'APPLE_API_KEY_ID and APPLE_API_ISSUER must be configured securely.\n' >&2; exit 1;
  }
  printf 'Signing prerequisites present. Apple authentication and signing are not yet tested.\n'
fi
printf 'No product build, certificate change, Apple submission, or publication performed.\n'
