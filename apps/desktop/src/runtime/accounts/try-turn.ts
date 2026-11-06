// One tiny real turn on exactly one account (B-051 L6, `accounts.try`): "does it answer?" – the first
// run's "Works – ChatGPT answered in 2.1 s". One tool-less, session-less helper turn like
// decision/engine-runner.ts runOnce (cwd <temp>/helper, every native approval denied, no tools) on the
// cheapest model the catalog lists for that account (relCost, then tier; a fresh sign-in the catalog has
// not listed yet: the models its engine lists for it), system TRY_SYSTEM, input TRY_INPUT, at most 60 s.
// Any non-empty answer counts. A failure says what it says about the account through accounts/failure.ts
// like an agent turn's (cooling, needs_login with the one sign-in to-do, error), so the account's state
// follows; the answer names the reason in plain words (missing, signed_out, plan, limit, error).
// Owns: the model pick for this check, the one turn and its mapping to AccountTry.
// Never: routing (no policy, setting or catalog outcome changes, no failover to another account),
// tools, sessions, or the account's e-mail or plan details in a message.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Account, Effort, EngineId, ModelInfo } from '../../shared/model/providers.ts';
import type { AccountService, Clock, EngineRegistry, ModelCatalog, NotificationService, Paths } from '../contracts.ts';
import type { EngineEvent, EngineModel, EngineTurnResult } from '../engines/types.ts';
import type { AccountTry } from '../../shared/api/methods-providers.ts';
import { accountFailure, recordAccountFailure } from './failure.ts';
import { engineFor } from './candidates.ts';
import { CLAUDE_FREE_PLAN } from './cli.ts';
import { PROVIDER_LABELS } from './service-shape.ts';
import { HELPER_DIR } from '../decision/engine-runner.ts';
import { SYSTEM_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';

export const TRY_SYSTEM = 'I am a connection check.';
export const TRY_INPUT = 'Reply with the single word OK.';
export const TRY_TIMEOUT_MS = 60_000;

export interface TryDeps {
  engines: Pick<EngineRegistry, 'get'>;
  catalog: Pick<ModelCatalog, 'list'>;
  /** markLimited/markUnavailable: the failure's consequence (failure.ts); updateLimits: limits the engine reports during the turn. */
  accounts: Pick<AccountService, 'get' | 'markLimited' | 'markUnavailable' | 'updateLimits'>;
  paths: Pick<Paths, 'temp'>;
  clock: Clock;
  /** The "Sign in to …" to-do when no sign-in work is attached (failure.ts). */
  notifications?: Pick<NotificationService, 'notify'>;
  timeoutMs?: number;
  mkdir?: (dir: string) => Promise<void>;
}

/** The model the check runs on: catalog id, provider model id, engine and a light effort. */
export interface TryTarget { id: string; model: string; engine: EngineId; effort: Effort }

const TIERS: Record<ModelInfo['tier'], number> = { local: 0, small: 1, strong: 2, frontier: 3 };
/** Lightest first ('low' before 'none': every engine that knows efforts accepts it). */
const LIGHT: readonly Effort[] = ['low', 'none', 'medium', 'high', 'xhigh', 'max'];
/** Texts of a plan that does not include this CLI or model (not a used-up limit). */
const PLAN_TEXT = /\b(?:upgrade (?:your (?:plan|subscription|account)|to (?:a )?(?:pro|max|plus|team|business|enterprise|paid))|(?:pro|max|plus|team|business|enterprise) (?:plan|subscription)|free (?:plan|tier)|subscription (?:is )?required|(?:plan|subscription) (?:does not|doesn't) (?:include|support|allow)|not (?:available|included|supported) (?:on|in|with|for) your (?:plan|subscription|account))\b/i;
/** A CLI that must be updated ("requires a newer version … upgrade to the latest app or CLI") – no plan matter (review B-051). */
const VERSION_TEXT = /\b(?:newer|latest|outdated|supported) version\b|\bversion (?:is )?(?:too old|no longer supported|out of date)\b/i;
const MESSAGE_CHARS = 200;

const fail = (reason: Extract<AccountTry, { ok: false }>['reason'], message: string): AccountTry => ({ ok: false, reason, message });
const firstLine = (text: string | undefined): string => (text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, MESSAGE_CHARS) ?? '';

export function lightEffort(efforts: readonly Effort[], fallback?: Effort): Effort {
  return efforts.length ? LIGHT.find((effort) => efforts.includes(effort)) ?? efforts[0] : fallback ?? 'low';
}

/** Cheapest first: relative cost (unknown last), then tier, then id. */
function cheaper(a: Pick<ModelInfo, 'relCost' | 'tier' | 'id'>, b: Pick<ModelInfo, 'relCost' | 'tier' | 'id'>): number {
  return (a.relCost ?? Number.POSITIVE_INFINITY) - (b.relCost ?? Number.POSITIVE_INFINITY) || TIERS[a.tier] - TIERS[b.tier] || a.id.localeCompare(b.id);
}

/** A general model (no media function, decision or embedding specialist). */
const chats = (model: ModelInfo) => !model.functions?.length && model.strengths['cheap-chat'] !== -1;

/** The cheapest model the catalog lists for this account; else the cheapest its engine lists for it now. */
export async function pickTarget(deps: Pick<TryDeps, 'catalog' | 'engines'>, account: Account): Promise<TryTarget | undefined> {
  const catalog = deps.catalog.list();
  const own = catalog.filter((model) => model.provider === account.provider && model.accounts.includes(account.id) && chats(model)).sort(cheaper)[0];
  if (own) return { id: own.id, model: own.model, engine: own.engine, effort: lightEffort(own.efforts, own.defaultEffort) };
  const engine = engineFor(account.provider);
  if (!engine) return undefined;
  const listed: EngineModel[] = await deps.engines.get(engine).listModels(account).catch(() => []);
  const known = new Map(catalog.map((model) => [model.id, model]));
  const options = listed.filter((model) => !model.hidden).map((model) => ({ model, info: known.get(`${account.provider}:${model.model}`) }))
    .filter((option) => !option.info || chats(option.info));
  options.sort((a, b) => (a.info && b.info ? cheaper(a.info, b.info) : a.info ? -1 : b.info ? 1 : 0));
  const pick = options[0];
  if (!pick) return undefined;
  return { id: `${account.provider}:${pick.model.model}`, model: pick.model.model, engine, effort: lightEffort(pick.model.efforts, pick.model.defaultEffort) };
}

/** Runs the check turn on account `id`; never throws for the account's own failures. */
export async function tryAccount(deps: TryDeps, id: string): Promise<AccountTry> {
  const account = deps.accounts.get(id);
  if (!account) return fail('error', 'This account does not exist.');
  if (!account.enabled || account.state === 'disabled') return fail('error', 'This account is switched off.');
  // B-051 L5: the status check found a Claude Free sign-in – no turn can change that.
  if (account.provider === 'claude' && account.state === 'error' && account.plan?.trim().toLowerCase() === 'free') return fail('plan', CLAUDE_FREE_PLAN);
  const label = PROVIDER_LABELS[account.provider] ?? account.label;
  const target = await pickTarget(deps, account);
  if (!target) return fail('error', `No model of ${label} is known yet – try again in a moment.`);
  const timeoutMs = deps.timeoutMs ?? TRY_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const onEvent = (event: EngineEvent) => {
    if (event.type !== 'limits') return;
    try { deps.accounts.updateLimits(account.id, event.limits); } catch { /* bookkeeping only */ }
  };
  const started = deps.clock.now();
  let result: EngineTurnResult;
  try {
    const cwd = path.join(deps.paths.temp, HELPER_DIR);
    await (deps.mkdir ?? ((dir: string) => mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined)))(cwd); // temp is scratch: the folder may be gone
    result = await deps.engines.get(target.engine).run({
      runId: newId('run', deps.clock.now()), agentId: SYSTEM_ID, account, model: target.model, effort: target.effort,
      system: { stable: TRY_SYSTEM, volatile: '' }, input: [{ type: 'text', text: TRY_INPUT }],
      tools: [], callTool: async () => ({ content: [{ type: 'text', text: 'No tools in this call.' }], isError: true }),
      cwd, readOnly: true, onEvent, signal,
    });
  } catch (error) {
    // An engine that throws instead of answering: its own words when they are user-safe.
    const data = error instanceof WorkforceError ? error.toData() : undefined;
    result = { text: '', stop: 'error', error: data ?? { code: 'internal', message: 'The test turn could not start.' } };
  }
  const ms = Math.max(0, deps.clock.now() - started);
  if (result.stop === 'done' && result.text.trim()) return { ok: true, ms, model: target.id };
  if (signal.aborted) return fail('error', `${label} did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s – try again in a moment.`);
  if (result.stop === 'done') return fail('error', `${label} answered with nothing – try again in a moment.`);
  return explain(deps, account, label, target.model, result);
}

/** Why the turn failed, in plain words – after recording what it says about the account. */
function explain(deps: TryDeps, account: Account, label: string, model: string, result: EngineTurnResult): AccountTry {
  const kind = accountFailure(result);
  const message = firstLine(result.error?.message);
  if ((kind === undefined || kind === 'overload') && PLAN_TEXT.test(message) && !/\blimit/i.test(message) && !VERSION_TEXT.test(message)) {
    try { deps.accounts.markUnavailable(account.id, 'error'); } catch { /* bookkeeping only */ }
    return fail('plan', account.provider === 'claude' ? CLAUDE_FREE_PLAN : message);
  }
  if (kind) { try { recordAccountFailure(deps, account, model, result); } catch { /* bookkeeping only: the answer still says why */ } }
  if (kind === 'missing' || (kind === 'overload' && /\bis not installed\b/i.test(message))) return fail('missing', kind === 'missing' ? `${label} is not installed.` : message);
  if (kind === 'signed_out') return fail('signed_out', account.auth === 'cli' ? 'Sign-in needed' : 'The API key was not accepted');
  if (kind === 'limit') return fail('limit', limitMessage(deps, account.id, result));
  return fail('error', message || `${label} did not answer – try again in a moment.`);
}

/** "Plan limit reached – free again at 14:00" when the reset is known (the provider's hint, else the used-up windows' reset). */
export function limitMessage(deps: Pick<TryDeps, 'accounts' | 'clock'>, id: string, result: Pick<EngineTurnResult, 'error'>): string {
  const now = deps.clock.now();
  const hint = result.error?.retryAfterMs;
  let at = hint !== undefined && hint > 0 ? now + hint : undefined;
  if (at === undefined) {
    const resets = (deps.accounts.get(id)?.limits?.windows ?? [])
      .filter((window) => window.usedPercent >= 100 && window.resetsAt !== undefined && window.resetsAt > now).map((window) => window.resetsAt!);
    if (resets.length) at = Math.max(...resets);
  }
  if (at === undefined) return 'Plan limit reached';
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return at - now < 24 * 3_600_000 ? `Plan limit reached – free again at ${time}` : `Plan limit reached – free again on ${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}
