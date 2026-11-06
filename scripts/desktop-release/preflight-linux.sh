#!/usr/bin/env bash
# Owns: environment-only checks for the prepared Linux release workstation.
# Never: reads product source, installs dependencies, starts Electron, or builds packages.
set -euo pipefail
[[ $# -eq 0 ]] || { printf 'Usage: bash preflight-linux.sh\n' >&2; exit 2; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$here/node-runtime.sh" --check
source "${XDG_DATA_HOME:-$HOME/.local/share}/workforce-release/env.sh"
bash "$here/linux-packages.sh" --check
[[ "$(node -p 'process.platform + "/" + process.arch')" == linux/x64 ]]
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(":memory:");
  if (db.prepare("SELECT 42 AS value").get().value !== 42) process.exit(1);
  db.close(); console.log("Native Linux Node and in-memory SQLite: OK");
'
xvfb-run --auto-servernum sh -c 'test -n "$DISPLAY"'
printf 'Headless X display: OK\n'
dbus-run-session -- sh -c 'test -n "$DBUS_SESSION_BUS_ADDRESS"'
printf 'Session D-Bus: OK\n'
if [[ -c /dev/fuse && -r /dev/fuse && -w /dev/fuse ]]; then
  printf 'FUSE device access: available (no AppImage mounted).\n'
else
  printf 'NOTE: FUSE device unavailable; real AppImage mounting remains unverified.\n'
fi
if unshare --user --map-root-user true 2>/dev/null; then
  printf 'User namespaces: available. Electron sandbox still needs a real package test.\n'
else
  printf 'NOTE: User namespaces restricted here; inspect sandbox compatibility at package testing.\n'
fi
printf 'Environment checks completed. No product build, install, or publication performed.\n'
