// electron-updater 6.8.9 BaseUpdater leaves quitAndInstallCalled true after an asynchronous
// NSIS spawn failure (doInstall returns before spawnLog rejects). Its queued quit is guarded
// by DesktopUpdates; release the latch too, so the next explicit retry really starts the installer.
// Owns: that pinned-library recovery only. Never: spawns, retries automatically or bypasses OS policy.
import type { Updater } from './update-service.ts';

export function allowInstallerRetry(updater: Updater): void {
  const base = updater as Updater & { quitAndInstallCalled?: boolean };
  const reset = () => {
    if (base.quitAndInstallCalled === true) base.quitAndInstallCalled = false;
  };
  updater.resetInstallAttempt = reset;
  updater.on('error', reset);
}
