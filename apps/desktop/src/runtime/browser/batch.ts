// browser.batch in an agent's own browser: the steps of one batch on one tab, one after another with Playwright's own
// waiting, no fixed pause between them; stops at the first failing step or when `stop` says why (the person took the
// browser over). A step with `secretId` gets the stored value at fill time. service.ts takes the one snapshot afterwards.
// Owns: the step loop. Never: takes snapshots or opens pages.

import type { MotionStyle } from '../../shared/model/pointer-motion.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { PointerMove } from './motion.ts';
import { hostOf, perform, translateError, type BrowserAction, type BrowserTarget, type PageLike } from './page.ts';

/** One step of browser.batch (`secretId`: fill or type a stored secret). */
export interface BatchStep { action: BrowserAction; target?: BrowserTarget; value?: string; secretId?: string; values?: string[]; key?: string; files?: string[]; amount?: number }

export interface StepRun {
  done: number;
  /** Why step `done + 1` failed (the batch stopped there). */
  failure?: string;
  points: Array<PointerMove & { tab: string }>;
}

export interface StepOptions {
  tab: string;
  motion: MotionStyle;
  timeoutMs: number;
  /** An upload path checked to be inside the workspace. */
  file(path: string): string;
  /** A stored secret's value for the page's host. */
  secret?(id: string, host: string): Promise<string>;
  /** A reason to stop before the next step, if any. */
  stop(): string | undefined;
}

export async function runSteps(page: PageLike, steps: readonly BatchStep[], options: StepOptions): Promise<StepRun> {
  const points: StepRun['points'] = [];
  let done = 0;
  for (const step of steps) {
    try {
      const reason = options.stop();
      if (reason) throw new WorkforceError('conflict', reason);
      if (page.isClosed()) throw new WorkforceError('not_found', 'The tab closed.');
      let value = step.value;
      if (step.secretId) {
        if (!options.secret) throw new WorkforceError('unavailable', 'Stored secrets cannot be filled here.');
        if (step.action !== 'fill' && step.action !== 'type') throw new WorkforceError('bad_request', 'A stored secret is used with fill or type.');
        value = await options.secret(step.secretId, hostOf(page.url()));
      }
      const files = step.files?.map((file) => options.file(file));
      const point = await perform(page, { ...step, value, files, timeoutMs: options.timeoutMs, motion: options.motion });
      if (point) points.push({ ...point, tab: options.tab });
      done++;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    } catch (error) {
      return { done, failure: translateError(error, step.target).message, points };
    }
  }
  return { done, points };
}
