// Starting an agent's own browser: playwright-core (imported lazily on first use) launches the
// persistent Chrome/Edge profile with a real window that sits off-screen – never headless (sites
// treat headless browsers as bots, and the window must exist for the person to take over), but
// not on the person's screen either. The person watches it in the live view (view.ts) and
// can bring the window onto the screen from there (Show window).
// Owns: launch options, the off-screen position and window size, launch error texts.
// Never: keeps sessions (service.ts), touches the person's own browser profile, or launches headless.

import { WorkforceError } from '../../shared/errors.ts';
import type { BrowserChannel } from './channel.ts';
import type { ContextLike } from './page.ts';

export interface LaunchOptions {
  channel: BrowserChannel;
  headless: boolean;
  viewport: null;
  acceptDownloads: boolean;
  args: string[];
}

export type Launcher = (profileDir: string, options: LaunchOptions) => Promise<ContextLike>;

/** Where an agent's browser window lives while the person does not look at it: outside every display. */
export const OFF_SCREEN = { left: -32000, top: -32000 } as const;
/** Window size (the page viewport follows it: `viewport: null`). */
export const WINDOW_SIZE = { width: 1280, height: 860 } as const;
/** Where Show window puts it (top left of the primary display). */
export const ON_SCREEN = { left: 40, top: 40 } as const;

/** Options for one agent browser: a real window (headless: false), off-screen, downloads on. */
export function launchOptions(channel: BrowserChannel): LaunchOptions {
  return {
    channel, headless: false, viewport: null, acceptDownloads: true,
    args: [
      '--no-first-run', '--no-default-browser-check',
      `--window-position=${OFF_SCREEN.left},${OFF_SCREEN.top}`, `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
    ],
  };
}

export const defaultLauncher: Launcher = async (dir, options) => {
  const playwright = await import('playwright-core');
  return await playwright.chromium.launchPersistentContext(dir, options) as unknown as ContextLike;
};

/** A short, person-readable error for a failed launch (the raw message goes to the log only). */
export function launchError(message: string, channel: BrowserChannel): WorkforceError {
  if (/already (running|in use)|ProcessSingleton|user data directory is already in use/i.test(message)) {
    return new WorkforceError('conflict', 'This agent\'s browser profile is already open in another window or app. Close it and try again.');
  }
  return new WorkforceError('unavailable', `The browser (${channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}) could not start.`);
}
