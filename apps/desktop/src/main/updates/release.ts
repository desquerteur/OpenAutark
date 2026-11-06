// Release locations (GitHub releases repo used by electron-updater and the manual download). From 0.3.3 (B-078) the
// one public home is teydra/OpenAutark; package.json build.publish names the same repo for the packaged feed. The former
// feed repo carries the bridge release 0.3.3 for installs up to 0.3.2.
// Owns: stable asset names per platform. Never: network access.

export const RELEASE_REPOSITORY = 'teydra/OpenAutark';
export const RELEASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;

export function downloadName(platform: string, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'autark-windows-x64.exe';
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return 'autark-mac-universal.dmg';
  if (platform === 'linux' && arch === 'x64') return 'autark-linux-x64.AppImage';
  return null;
}

export function downloadURL(platform: string, arch: string): string | null {
  const name = downloadName(platform, arch);
  return name ? `${RELEASE_URL}/latest/download/${name}` : null;
}
