// Which installed browser the agents' own profiles run in (Playwright `channel`), and where
// each agent's persistent profile lives. Uses the installed Chrome or Edge – no 150 MB browser
// download.
// Owns: install-path probing per OS and the profile directory rule.
// Never: launches anything or touches the person's own browser profile.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { WorkforceError } from '../../shared/errors.ts';

export type BrowserChannel = 'chrome' | 'msedge';

export interface ChannelEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
}

export function defaultChannelEnv(): ChannelEnv {
  return { platform: process.platform, env: process.env, exists: (file) => { try { return existsSync(file); } catch { return false; } } };
}

/** Executable locations Playwright's channels use (stable builds only). */
export function channelCandidates(channel: BrowserChannel, env: ChannelEnv): string[] {
  const e = env.env;
  if (env.platform === 'win32') {
    const roots = [e.LOCALAPPDATA, e.PROGRAMFILES ?? e.ProgramFiles, e['PROGRAMFILES(X86)'] ?? e['ProgramFiles(x86)']].filter((root): root is string => Boolean(root));
    const relative = channel === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    return roots.map((root) => path.win32.join(root, ...relative));
  }
  if (env.platform === 'darwin') {
    return channel === 'chrome'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  return channel === 'chrome'
    ? ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    : ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
}

/** Chrome when installed, else Edge (always present on Windows 10/11). */
export function detectChannel(env: ChannelEnv = defaultChannelEnv()): BrowserChannel {
  for (const channel of ['chrome', 'msedge'] as const) {
    if (channelCandidates(channel, env).some((file) => env.exists(file))) return channel;
  }
  throw new WorkforceError('unavailable', 'No Google Chrome or Microsoft Edge installation was found. Install one of them so agents can use their own browser.');
}

/** <data>/browser-profiles/<agentId>: one persistent profile (cookies, logins) per agent. */
export function profileDir(dataDir: string, agentId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new WorkforceError('bad_request', 'Invalid agent id for a browser profile.');
  return path.join(dataDir, 'browser-profiles', agentId);
}
