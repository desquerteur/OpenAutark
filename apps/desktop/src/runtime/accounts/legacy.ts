// The one-time move of accounts from before the one model system (01.11.2026): a 'decision' account (a hosted
// decision vendor key, or a local decision server) becomes a normal connection – the named API service of its host
// (OpenRouter, …), else an OpenAI-compatible address on that host (<origin>/v1), a local one an Ollama or
// compatible local server –, keeping its key, its place and its on/off; its models then come from the provider's
// model list like any other. An 'artificial-analysis' account (model data only, no models) is removed; its key stays in
// the vault. Runs at every start, so it is done once: afterwards no such row exists.
// Owns: these rewrites. Never: reads or moves a key value, or touches any other account.

import type { Db } from '../db/database.ts';
import type { Logger } from '../contracts.ts';
import type { Account, ProviderId } from '../../shared/model/providers.ts';
import { hostOf, serviceAt } from '../../shared/model/providers-connect.ts';
import { AccountRepo } from './repo.ts';

const OLD_PROVIDERS: ReadonlySet<string> = new Set(['decision', 'artificial-analysis']);
/** A decision account without an address was TypeSafe Jev's (the only hosted vendor before B-048). */
const TYPESAFE = 'https://api.typesafe.ai';
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/;

/** The normal connection an old decision account becomes. */
export function decisionConnection(account: Pick<Account, 'baseUrl' | 'auth' | 'label'>): Pick<Account, 'provider' | 'baseUrl' | 'label' | 'auth'> {
  const address = account.baseUrl?.trim() || TYPESAFE;
  const host = hostOf(address) ?? 'api.typesafe.ai';
  const origin = /^https?:\/\/[^/?#]+/i.exec(address)?.[0] ?? TYPESAFE;
  const named = serviceAt(address);
  const own = account.label.trim() && !/decision/i.test(account.label) ? account.label.trim() : undefined;
  if (named) return { provider: named.provider, baseUrl: named.provider === 'compatible' ? named.base : undefined, label: own ?? named.name, auth: account.auth };
  if (LOCAL_HOST.test(host)) {
    const provider: ProviderId = host.endsWith(':11434') ? 'ollama' : 'compatible';
    return { provider, baseUrl: `${origin}/v1`, label: own ?? (provider === 'ollama' ? 'Ollama' : host), auth: account.auth === 'api_key' ? 'api_key' : 'local' };
  }
  return { provider: 'compatible', baseUrl: `${origin}/v1`, label: own ?? host, auth: account.auth };
}

/** Rewrites the old accounts; returns how many changed. */
export function migrateOldAccounts(db: Db, log?: Logger): number {
  const repo = new AccountRepo(db);
  let changed = 0;
  for (const account of repo.list()) {
    const provider = account.provider as string;
    if (!OLD_PROVIDERS.has(provider)) continue;
    if (provider === 'artificial-analysis') repo.remove(account.id);
    else repo.save({ ...account, ...decisionConnection(account), state: account.enabled ? 'unknown' : 'disabled', limits: undefined, coolingUntil: undefined });
    changed++;
  }
  if (changed) log?.info('older decision and model data accounts moved to normal connections', { accounts: changed });
  return changed;
}
