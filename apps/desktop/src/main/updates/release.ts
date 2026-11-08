// Release locations (GitHub releases repo used by electron-updater and the manual download). From 0.3.3 (B-078) the
// public home is teydra/OpenAutark; this build (AF-019) is the fork desquerteur/OpenAutark, which builds its own
// releases (.github/workflows/build-desktop.yml) – package.json build.publish names the same repo for the packaged feed.
// The person can switch the source in Settings › Updates (source.ts); every address here takes that repository.
// Owns: stable asset names per platform. Never: network access.

/** This build's default update source (package.json build.publish says the same). */
export const RELEASE_REPOSITORY = 'desquerteur/OpenAutark';
/** The upstream project's releases (selectable in Settings › Updates). */
export const UPSTREAM_REPOSITORY = 'teydra/OpenAutark';
export const RELEASE_URL = releasesURL(RELEASE_REPOSITORY);

export function releasesURL(repository: string = RELEASE_REPOSITORY): string {
  return `https://github.com/${repository}/releases`;
}

export function downloadName(platform: string, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'autark-windows-x64.exe';
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return 'autark-mac-universal.dmg';
  if (platform === 'linux' && arch === 'x64') return 'autark-linux-x64.AppImage';
  return null;
}

export function downloadURL(platform: string, arch: string, repository: string = RELEASE_REPOSITORY): string | null {
  const name = downloadName(platform, arch);
  return name ? `${releasesURL(repository)}/latest/download/${name}` : null;
}
