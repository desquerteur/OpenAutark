// The person steers an agent's browser from the live view (view.ts): switch tab (it becomes the agent's active tab
// and comes to the front – Chrome only paints the front tab), open a URL, back / forward / reload, or move the real
// window onto this PC's screen and back off-screen (launch.ts). Each step counts as use and makes the agent's next
// look at that tab a whole snapshot; while the window is shown the browser does not close for being idle.
// Owns: those steps on an open ViewSession. Never: opens a browser.

import { WorkforceError } from '../../shared/errors.ts';
import type { BrowserSteer } from '../../shared/model/browser.ts';
import type { Logger } from '../contracts.ts';
import type { ViewSession } from './sessions.ts';
import { normaliseUrl, perform, translateError, type PageLike } from './page.ts';
import { OFF_SCREEN, ON_SCREEN } from './launch.ts';

export const NO_LIVE = 'This browser cannot be shown live.';

/** Runs one steering step. */
export async function steerBrowser(agentId: string, view: ViewSession, input: BrowserSteer, log?: Logger): Promise<void> {
  const page = input.tab ? view.tabs.find((entry) => entry.tab === input.tab)?.page : view.active;
  if (!page) throw new WorkforceError('not_found', input.tab ? 'That tab is closed.' : 'No tab is open.');
  if (input.window) return moveWindow(agentId, view, page, input.window, log);
  view.steer(page);
  try {
    if (input.tab) await page.bringToFront().catch(() => undefined);
    if (input.url) await page.goto(normaliseUrl(input.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    else if (input.action) await perform(page, { action: input.action, timeoutMs: 15_000 });
  } catch (error) {
    throw translateError(error, undefined);
  }
}

async function moveWindow(agentId: string, view: ViewSession, page: PageLike, where: 'show' | 'hide', log?: Logger): Promise<void> {
  if (!view.context.newCDPSession) throw new WorkforceError('unavailable', NO_LIVE);
  const cdp = await view.context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget') as { windowId: number };
    // A maximised or minimised window cannot be moved: make it normal first.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: where === 'show' ? { ...ON_SCREEN } : { ...OFF_SCREEN } });
    view.onScreen(where === 'show');
    view.steer(page);
    if (where === 'show') await page.bringToFront().catch(() => undefined);
  } catch (error) {
    log?.debug('browser window move failed', { agentId, error: String(error).split('\n')[0] });
    throw new WorkforceError('unavailable', 'The browser window could not be moved.');
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
