// The decision protocol ("System One") as a connection of settings.json: an entry with protocol "decision" answers the
// typed questions of the Decisions use, asked at POST <url>/systemone with its key (TypeSafe Jev, Liquid d1-ultra,
// OpenRouter, Baseten, a local Ollama or llama.cpp server – the address says who, no table of vendors):
//   request  {model, state:"<context>", questions:{q:{type:'choice', instructions, criteria:{label: description}}
//                                                  | {type:'score', instructions, criteria:[levels, lowest first]}
//                                                  | {type:'noul', instructions}}}
//   response {model, answers:{q:{type, choice, confidence, probabilities:{label: p}}
//                              | {type, score /* level index */, confidence, legend, probabilities}
//                              | {type, noul /* 0..1 */}}, usage}
// routing.decision "<id>:<model>" names the connection; on "auto" the first one with a listed model answers. A connection
// that fails rests a minute (doubling up to ten) while the next backend answers; the caller ending a call does not count.
// Protocol as the TypeSafe docs and OpenRouter's reference gave it on 28.10.2026; no live call has been made with a key.
// Owns: the backend, its request and answer mapping, and accounts.try for such a connection. Never: sends the key to
// another address or follows a redirect with it, or stores anything.

import type { AccountTry } from '../../shared/api/methods-providers.ts';
import type { DecisionRequest, DecisionResult, RuntimeServices } from '../contracts.ts';
import { useValue, USE_AUTO } from '../../shared/model/models-uses.ts';
import { entryModels } from '../../shared/model/provider-entries.ts';
import { DECISION_PROVIDER, type Account } from '../../shared/model/providers.ts';
import type { DecisionBackend } from './types.ts';
import { levelsOf, num, optionLabels, optionOf, stateText, unitScore } from './wire.ts';

export const BACK_OFF_MS = 60_000;
export const MAX_BACK_OFF_MS = 10 * 60_000;
const CALL_MS = 8_000;
const LOCAL_CALL_MS = 20_000;
/** Baseten alone wants its own word before the key. */
const API_KEY_SCHEME = /(^|\.)baseten\.co$/i;

type Services = Pick<RuntimeServices, 'accounts' | 'settings'>;
type FetchFn = typeof fetch;

export function toRequest(model: string, request: DecisionRequest): Record<string, unknown> {
  const type = request.type === 'predicate' ? 'noul' : request.type;
  const question: Record<string, unknown> = { type, instructions: request.question };
  if (request.type === 'choice') question.criteria = Object.fromEntries(optionLabels(request.options ?? []).map((entry) => [entry.label, entry.description]));
  if (request.type === 'score') question.criteria = levelsOf();
  return { model, state: stateText(request), questions: { q: question } };
}

export function fromResponse(body: unknown, request: DecisionRequest, by: string): DecisionResult {
  const answers = (body as { answers?: Record<string, Record<string, unknown>> } | undefined)?.answers;
  const answer = (answers && typeof answers === 'object' && !Array.isArray(answers) ? answers.q ?? Object.values(answers)[0] : undefined) ?? {};
  const probabilities = answer.probabilities as Record<string, number> | number[] | undefined;
  if (request.type === 'choice') {
    const labels = optionLabels(request.options ?? []);
    let label = answer.choice as unknown;
    if (typeof label === 'number') label = labels[label]?.label;
    let confidence = num(answer.confidence);
    if (confidence === undefined && probabilities && typeof label === 'string') {
      confidence = Array.isArray(probabilities) ? num(probabilities[labels.findIndex((entry) => entry.label === label)]) : num(probabilities[label]);
    }
    return { choice: typeof label === 'string' ? optionOf(labels, label) : undefined, confidence: confidence ?? 0.5, by };
  }
  if (request.type === 'predicate') {
    const raw = answer.noul ?? answer.value ?? answer.answer;
    const p = typeof raw === 'boolean' ? (raw ? 1 : 0) : num(raw);
    if (p === undefined) return { confidence: 0, by };
    return { value: p >= 0.5, confidence: num(answer.confidence) ?? Math.max(p, 1 - p), by };
  }
  const score = unitScore(answer.score, levelsOf().length);
  return { score, confidence: score === undefined ? 0 : num(answer.confidence) ?? 0.6, by };
}

const usable = (account: Account): boolean => account.provider === DECISION_PROVIDER && account.enabled && account.state !== 'needs_login' && account.state !== 'disabled';

/** The connection and model that answer decisions now; undefined: none (another backend answers). */
export function decisionConnection(s: Services): { account: Account; model: string } | undefined {
  const settings = s.settings.get();
  const value = useValue(settings.routing, 'decision');
  const accounts = s.accounts.list().filter(usable);
  if (value !== USE_AUTO) {
    const at = value.indexOf(':');
    const account = at > 0 ? accounts.find((entry) => entry.id === value.slice(0, at)) : undefined;
    return account ? { account, model: value.slice(at + 1) } : undefined;
  }
  for (const account of accounts) {
    const model = entryModels(settings.providers?.[account.id])[0];
    if (model) return { account, model: model.id };
  }
  return undefined;
}

/** One call of the protocol on `account`. Throws on anything that is no answer. */
export async function askConnection(account: Account, model: string, key: string | undefined, request: DecisionRequest, signal: AbortSignal, fetchFn: FetchFn = fetch): Promise<DecisionResult> {
  const base = (account.baseUrl ?? '').replace(/\/+$/, '');
  const url = base.endsWith('/systemone') ? base : `${base}/systemone`;
  const local = /^http:/i.test(url);
  const scheme = API_KEY_SCHEME.test(new URL(url).hostname) ? 'Api-Key' : 'Bearer';
  const response = await fetchFn(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(local ? LOCAL_CALL_MS : CALL_MS)]),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `${scheme} ${key}` } : {}) },
    body: JSON.stringify(toRequest(model, request)),
  });
  if (!response.ok) throw new Error(`${account.label}: the decision server answered HTTP ${response.status}`);
  return fromResponse(await response.json(), request, `${account.id}:${model}`);
}

/** An own failure counts; the caller's deadline or stop does not (a time limit of the call itself does). */
const failedItself = (signal: AbortSignal): boolean => !signal.aborted || (signal.reason as { name?: unknown } | null | undefined)?.name === 'TimeoutError';

export class SystemOneBackend implements DecisionBackend {
  readonly id = 'systemone';
  private readonly services: () => Services;
  private readonly fetchFn?: FetchFn;
  private readonly now: () => number;
  private readonly rest = new Map<string, { until: number; failures: number }>();

  constructor(options: { services: () => Services; fetch?: FetchFn; now?: () => number }) {
    this.services = options.services;
    this.fetchFn = options.fetch;
    this.now = options.now ?? Date.now;
  }

  available(): boolean {
    let chosen: ReturnType<typeof decisionConnection>;
    try { chosen = decisionConnection(this.services()); } catch { return false; }
    return chosen !== undefined && this.now() >= (this.rest.get(chosen.account.id)?.until ?? 0);
  }

  async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
    const s = this.services();
    const chosen = decisionConnection(s);
    if (!chosen) throw new Error('no decision connection');
    const { account, model } = chosen;
    try {
      const result = await askConnection(account, model, await s.accounts.apiKey(account.id), request, signal, this.fetchFn);
      this.rest.delete(account.id);
      return result;
    } catch (error) {
      if (failedItself(signal)) {
        const failures = (this.rest.get(account.id)?.failures ?? 0) + 1;
        this.rest.set(account.id, { failures, until: this.now() + Math.min(BACK_OFF_MS * 2 ** (failures - 1), MAX_BACK_OFF_MS) });
      }
      throw error;
    }
  }
}

/** accounts.try on a decision connection: one tiny real question. */
export async function tryDecisionConnection(s: Services, account: Account, fetchFn?: FetchFn): Promise<AccountTry> {
  const settings = s.settings.get();
  const value = useValue(settings.routing, 'decision');
  const model = value.startsWith(`${account.id}:`) ? value.slice(account.id.length + 1) : entryModels(settings.providers?.[account.id])[0]?.id;
  if (!model) return { ok: false, reason: 'error', message: `${account.label} has no model yet: list one under its models in settings.json, or name it in routing.decision.` };
  const started = Date.now();
  const question: DecisionRequest = { purpose: 'other', type: 'predicate', question: 'Is one plus one two?' };
  try {
    const answer = await askConnection(account, model, await s.accounts.apiKey(account.id), question, AbortSignal.timeout(CALL_MS), fetchFn);
    if (typeof answer.value !== 'boolean') return { ok: false, reason: 'error', message: `${account.label} answered, but not with what the decision protocol describes.` };
    return { ok: true, ms: Date.now() - started, model: `${account.id}:${model}` };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message.slice(0, 200) : `${account.label} did not answer.` };
  }
}
