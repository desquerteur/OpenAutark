// Where main finds the shipped app files and the per-user data, and the AppInfo for the runtime.
// Owns: the build output layout (scripts/build.mjs: app/main.cjs, app/preload.cjs,
// app/runtime.mjs, app/ui/**) relative to the app root, and the userData layout main touches.
// Never: imports electron (index.ts passes app.getAppPath()/getPath values in), creates files.

import path from 'node:path';
import type { AppInfo } from '../shared/api/host-bridge.ts';

export interface AppPaths {
  /** Directory holding package.json, app/, resources/, assets/ (app.asar when packaged). */
  root: string;
  preload: string;
  runtime: string;
  ui: string;
  sandboxLib: string; // app/ui/sandbox (wf.js)
  icon: string;
  data: string; // userData
  blobs: string; // content-addressed files written by the runtime
  logs: string;
  windowState: string;
}

export interface PathInput {
  appPath: string; // app.getAppPath()
  userData: string; // app.getPath('userData')
}

export function appPaths(input: PathInput): AppPaths {
  const root = path.resolve(input.appPath);
  const data = path.resolve(input.userData);
  const build = path.join(root, 'app');
  return {
    root,
    preload: path.join(build, 'preload.cjs'),
    runtime: path.join(build, 'runtime.mjs'),
    ui: path.join(build, 'ui'),
    sandboxLib: path.join(build, 'ui', 'sandbox'),
    icon: path.join(root, 'assets', 'icon.png'),
    data,
    blobs: path.join(data, 'blobs'),
    logs: path.join(data, 'logs'),
    windowState: path.join(data, 'window-state.json'),
  };
}

export interface AppInfoInput {
  version: string;
  packaged: boolean;
  paths: AppPaths;
  executable: string; // process.execPath
  companies?: AppInfo['companies']; // B-072: where the companies live (main/companies.ts); none in a test profile
}

/**
 * AppInfo for the runtime's `init` message. `resourcesDir` is the app root (app.asar when
 * packaged): the runtime reads `<resourcesDir>/resources/**` (skills, modes, prompts, computer
 * helper) and `<resourcesDir>/app/ui` (PWA files). Files that external processes must execute
 * (resources/**\/*.ps1) are unpacked next to the archive (app.asar.unpacked) by electron-builder.
 */
export function appInfo(input: AppInfoInput): AppInfo {
  return {
    version: input.version,
    packaged: input.packaged,
    resourcesDir: input.paths.root,
    dataDir: input.paths.data,
    executable: input.executable,
    ...(input.companies ? { companies: input.companies } : {}),
  };
}

/**
 * Command-line flags main understands. `--background`: start with tray and runtime, no window;
 * `--launcher` (B-044): started by the OS launcher – launcher.ts decides at once whether to go on;
 * `--restarted`: the Windows task's start after an unexpected close handed over to this one (its notice).
 */
export function launchFlags(argv: readonly string[]): { background: boolean; launcher: boolean; restarted: boolean } {
  return { background: argv.includes('--background'), launcher: argv.includes('--launcher'), restarted: argv.includes('--restarted') };
}
