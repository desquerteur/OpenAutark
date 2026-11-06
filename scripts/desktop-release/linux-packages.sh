#!/usr/bin/env bash
# Owns: Ubuntu 24.04 packages for a future x64 AppImage build and window checks.
# Never: builds an app, changes security policy, or installs the conflicting fuse package.
set -euo pipefail

mode=${1:---check}
if [[ $# -gt 1 || ! "$mode" =~ ^--(check|install)$ ]]; then
  printf 'Usage: bash linux-packages.sh [--check|--install]\n' >&2; exit 2
fi
[[ "$(uname -s)-$(uname -m)" == Linux-x86_64 ]] || { printf 'Linux x64 required.\n' >&2; exit 2; }
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || {
  printf 'This package list is checked for Ubuntu 24.04 only.\n' >&2; exit 2;
}

packages=(
  ca-certificates curl xz-utils unzip git python3 build-essential pkg-config
  file desktop-file-utils zsync libfuse2t64 xvfb xauth dbus-x11 fonts-liberation
  libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcairo2 libcups2t64
  libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 libnss3
  libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6
  libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6
)
missing=()
for package in "${packages[@]}"; do
  state=$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)
  [[ "$state" == 'install ok installed' ]] || missing+=("$package")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'Missing packages: %s\n' "${missing[*]}"
  if [[ "$mode" != --install ]]; then exit 1; fi
  [[ $EUID -eq 0 ]] || { printf 'Run package installation as root.\n' >&2; exit 1; }
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends "${missing[@]}"
fi
printf 'Ubuntu AppImage prerequisites: %s packages installed.\n' "${#packages[@]}"
