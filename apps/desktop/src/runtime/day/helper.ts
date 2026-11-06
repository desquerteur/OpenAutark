// The helper model My day's morning briefing asks for its few sentences (day/briefing.ts): the engines' structured
// runner on a small, fast route (decision/engine-runner.ts), one per runtime. None when no model is available – the
// briefing then shows its count line only.
// Owns: finding that runner. Never: decides what is asked.

import type { RuntimeServices } from '../contracts.ts';
import { createEngineRunner } from '../decision/engine-runner.ts';
import type { StructuredRunner } from '../decision/types.ts';

export type HelperDeps = Pick<RuntimeServices, 'clock'>
  & Partial<Pick<RuntimeServices, 'settings' | 'engines' | 'router' | 'accounts' | 'catalog' | 'paths' | 'notifications'>>
  & {
    /** Tests and headless setups: the helper to ask (false = none); absent = the engines' structured runner. */
    splitHelper?: StructuredRunner | false;
  };

const HELPER_TIMEOUT_MS = 90_000;
const runners = new WeakMap<object, StructuredRunner>();

/** The helper to ask, or undefined when there is none. */
export function helperOf(s: HelperDeps): StructuredRunner | undefined {
  if (s.splitHelper === false) return undefined;
  if (s.splitHelper) return s.splitHelper;
  try {
    if (!s.engines || !s.router || !s.accounts || !s.catalog || !s.paths || !s.catalog.list().some((model) => model.available)) return undefined;
  } catch {
    return undefined;
  }
  let runner = runners.get(s);
  if (!runner) {
    runner = createEngineRunner({
      engines: s.engines, router: s.router, accounts: s.accounts, catalog: s.catalog, paths: s.paths, clock: s.clock,
      notifications: s.notifications, timeoutMs: HELPER_TIMEOUT_MS,
    });
    runners.set(s, runner);
  }
  return runner;
}
