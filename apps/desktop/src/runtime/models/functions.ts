// Function models: which catalog model and account serve a media function (speech to text, text
// to speech, image, video, music) – the one resolver every consumer uses (transcription today,
// media generation later).
// Owns: the rule "the Settings choice (the use routing.<fn>, shared/model/models-uses.ts) while it is still available, else
// the first available specialist" (shared/model/providers.ts functionCandidates) plus the account
// pick: healthy accounts of that model, free/local ones before pay-per-use keys. Without a choice
// the router's money rule applies too: specialists reachable on a free connection (local runtime,
// plan, keyless server) come before API keys, and API keys are skipped entirely while a free one
// exists and routing.allowPaidFallback is off. A Settings choice keeps its (possibly paid) account.
// Never: routes chat turns (the router does), reads keys, or picks a general chat model.

import type { RuntimeServices } from '../contracts.ts';
import { functionCandidates, type Account, type ModelFunction, type ModelInfo, type ProviderId } from '../../shared/model/providers.ts';
import { chargeOf } from './pricing.ts';
import { USE_AUTO, USE_OFF, useValue } from '../../shared/model/models-uses.ts';

export interface FunctionModel {
  modelId: string;
  accountId: string;
  provider: ProviderId;
  /** Provider model id sent to the endpoint (e.g. "whisper-1"). */
  model: string;
  /** 'settings' = the person's choice; 'auto' = first available specialist. */
  source: 'settings' | 'auto';
}

export interface FunctionStatus {
  choice?: FunctionModel;
  /** The stored choice (routing.<fn>), when there is one. */
  setting?: string;
  /** A choice is stored but not usable right now (unavailable or not a model for this function). */
  settingUnavailable: boolean;
  /** routing.<fn> === 'off'. */
  off: boolean;
}

type Services = Pick<RuntimeServices, 'catalog' | 'accounts' | 'settings'>;

/** Pay-per-use connection (API key, key from the environment, CLI signed in with an API key); local runtimes and plans are free at the margin. */
const paid = (account: Account) => chargeOf(account) === 'paid';

/** Healthy accounts that can run this catalog model, free ones first (stable within each group). */
function accountsFor(s: Services, model: ModelInfo): Account[] {
  let candidates: Account[];
  try { candidates = s.accounts.candidates(model.engine, model.model); } catch { return []; }
  const usable = candidates.filter((account) => account.provider === model.provider && (!model.accounts.length || model.accounts.includes(account.id)));
  return [...usable.filter((account) => !paid(account)), ...usable.filter(paid)];
}

type Reachable = { model: ModelInfo; source: 'settings' | 'auto'; accounts: Account[] };

/** Automatic candidates under the money rule: free connections first, API keys only as spill-over. */
function autoOrder(candidates: Reachable[], allowPaid: boolean): Reachable[] {
  let pool = candidates;
  if (!allowPaid && pool.some((entry) => entry.accounts.some((account) => !paid(account)))) {
    pool = pool.map((entry) => ({ ...entry, accounts: entry.accounts.filter((account) => !paid(account)) })).filter((entry) => entry.accounts.length > 0);
  }
  // accountsFor lists free accounts first, so accounts[0] is paid only when the model has no free one.
  return [...pool.filter((entry) => !paid(entry.accounts[0])), ...pool.filter((entry) => paid(entry.accounts[0]))];
}

/** Resolution with the reasons a caller needs for a clear message. */
export function functionStatus(s: Services, fn: ModelFunction): FunctionStatus {
  const routing = s.settings.get().routing;
  const value = useValue(routing, fn);
  const off = value === USE_OFF;
  const setting = value === USE_AUTO ? undefined : value;
  let models: ModelInfo[];
  try { models = s.catalog.list(); } catch { models = []; }
  const reachable: Reachable[] = functionCandidates(fn, setting, models)
    .map((candidate) => ({ ...candidate, accounts: accountsFor(s, candidate.model) }))
    .filter((candidate) => candidate.accounts.length > 0);
  const chosen = reachable.find((candidate) => candidate.source === 'settings');
  const pick = chosen ?? autoOrder(reachable.filter((candidate) => candidate.source === 'auto'), Boolean(routing.allowPaidFallback))[0];
  const choice: FunctionModel | undefined = pick
    ? { modelId: pick.model.id, accountId: pick.accounts[0].id, provider: pick.model.provider, model: pick.model.model, source: pick.source }
    : undefined;
  return { choice, setting, settingUnavailable: Boolean(setting) && !off && !chosen, off };
}

/** Model and account for a media function, or undefined when none is connected (or it is off). */
export function functionModel(s: Services, fn: ModelFunction): FunctionModel | undefined {
  return functionStatus(s, fn).choice;
}
