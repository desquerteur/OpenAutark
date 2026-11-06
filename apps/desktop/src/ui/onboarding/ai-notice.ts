// Home's "no AI" notice: after the first run while no model can answer (first-run-model.ts noUsableModel), Home's
// band says "No AI is connected yet – your team can't start." with [Connect] – Settings at its Models group. A status,
// not an offer: no Dismiss; it goes as soon as a model can answer.
// Owns: this notice (aiNotice is pure) and its registration (shell/StatusLine.tsx registerShellNotices, once per app start).
// Never: shows away from Home, before the snapshots are in, during the first run, or where this connection may not
// read the accounts.

import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import type { Settings } from '../../shared/model/system.ts';
import { navigate } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { accounts, loaded, models, route, settings } from '../lib/store.ts';
import { NOTICE_PRIORITY, registerNotice, type Notice } from '../shell/notices.ts';
import { noUsableModel } from './first-run-model.ts';

export const AI_NOTICE_ID = 'no-ai';
export const AI_NOTICE_TEXT = "No AI is connected yet – your team can't start.";

export interface AiNoticeInput {
  onboarding: Settings['onboarding'] | undefined;
  /** The route is Home. */
  home: boolean;
  /** The snapshots are loaded (before that the account list is empty, not "nothing connected"). */
  loaded: boolean;
  /** This connection may read the accounts (the owner's window). */
  readable: boolean;
  models: readonly ModelInfo[];
  accounts: readonly Account[];
}

/** The band line while no model can answer after the first run, or null. */
export function aiNotice(input: AiNoticeInput, connect: () => void): Notice | null {
  if (!input.home || !input.loaded || !input.readable || input.onboarding?.step !== 'done') return null;
  if (!noUsableModel(input.models, input.accounts)) return null;
  return {
    id: AI_NOTICE_ID, tone: 'warn', priority: NOTICE_PRIORITY.setup,
    text: AI_NOTICE_TEXT,
    actions: [{ label: 'Connect', run: connect }],
  };
}

/** Registers the provider (once per app start); returns the function that removes it. */
export function registerAiNotice(): () => void {
  return registerNotice(() => aiNotice({
    onboarding: settings.value?.onboarding,
    home: route.value.view === 'home',
    loaded: loaded.value,
    readable: can('accounts.list'),
    models: models.value,
    accounts: accounts.value,
  }, () => navigate({ view: 'settings', section: 'models' })));
}
