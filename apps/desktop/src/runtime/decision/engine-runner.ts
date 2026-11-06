// StructuredRunner over the real engines: routes a clean-context, tool-less turn to the
// cheapest suitable model (category 'cheap-chat', economy) and returns its (structured) answer.
// Up to 'strong' first; when nothing in that band is usable (e.g. only frontier models are
// connected, or all their accounts are limited) the economy pick of any tier. Used by the LLM
// decision fallback, the verifier and compaction.
// The model is the Decisions use (settings.json routing.decision; "auto" = the helper default below) – the router's
// Settings use pin (routing/pins.ts), falling back to the cheap pick with a reason when it is not usable.
// MM10: createListener – the same one-shot turn with one recording (media.listen) on a model
// that hears audio (caps.audioIn; while the catalog does not say, a known listening family).
// Recordings go through the compatible chat adapter (input_audio): compatible models, and
// OpenAI API models, whose API speaks the same chat completions. B-058 G7: a plan CLI model whose
// catalog entry says it hears audio (caps.audioIn – Codex inputModalities, an ACP agent's audio
// capability) listens on its own engine (Codex localAudio, ACP audio blocks); no name guess there.
// Every other model is excluded from the route, and `avoid` keeps accounts out. Pay-per-use accounts listen only with
// `allowPaid` (media.listen: listenOptions says whether the route may pick one); without it they are excluded and a routed one is refused before the
// call, also one that became usable while the router worked. Category 'cheap-chat' (economy)
// until routing knows 'audio-analysis' (models/priors.ts CATEGORIES).
// SG: without an explicit choice the router prefers the helper default (routing/helper-default.ts:
// a Codex plan's small model at low effort); a caller's `effort` reaches it as an effort-only
// request (RouteRequest.previous asked 'effort'), and the answer says which effort ran and which
// efforts the model supports (so a retry at a higher effort is skipped when it would be the same).
// Every helper turn works in a folder of its own, <temp>/helper (HELPER_DIR, made again when the
// scratch folder lost it), so whatever an engine writes there never lands at the temp root, where
// uploads, opened copies and the CLIs' status probes live.
// A helper call that fails because of its account (limit, unavailable – accounts/failure.ts, the same rule
// as agent turns) records that on the account like an agent turn does (cooling, needs_login with the one
// sign-in to-do, error), so the router and later helper calls skip it, and goes once to another account.
// One time limit (`timeoutMs`) covers both attempts and the caller's signal cuts both; the account's
// limits the engine reports during a call are kept (updateLimits).
// A caller's deadline (`deadlineMs`) is part of the call's time limit: the call ends when it passes.
// What a call used goes to `onUsage` and with its answer as the engine reported it: all input, the cached part of it, the output.
// B-078 D14: a caller's `temperature` goes with the engine turn; an engine that takes one honours it, the others ignore it.
// Owns: the synthetic runtime agent, the one-shot engine call, its one failover and which models can listen.
// Never: tools, sessions, approvals (every native approval is denied), the agent's own context,
// a recording sent to a model that cannot hear it, or to a pay-per-use account without allowPaid.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Agent } from '../../shared/model/org.ts';
import type { Account, Effort, EngineId, ModelInfo, RouteDecision } from '../../shared/model/providers.ts';
import type { AccountService, Clock, EngineRegistry, ModelCatalog, NotificationService, Paths, RouteRequest, Router, SettingsService } from '../contracts.ts';
import type { EngineEvent, EngineTurnResult, TurnInputItem } from '../engines/types.ts';
import { accountFailure, recordAccountFailure } from '../accounts/failure.ts';
import { chargeOf } from '../models/pricing.ts';
import { GENERAL_MODE } from '../modes/service.ts';
import { SYSTEM_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { failure } from '../tools/types.ts';
import type { StructuredRunner } from './types.ts';

/** The runtime itself as a routing subject (economy; never above 'strong' unless `anyTier`). */
export function runtimeAgent(now: number, anyTier = false): Agent {
  const band = anyTier ? { costMode: 'economy' as const } : { costMode: 'economy' as const, ceilingTier: 'strong' as const };
  return {
    id: SYSTEM_ID, name: 'Runtime', role: 'runtime helper', avatar: { kind: 'initials', value: 'R' }, instructions: '',
    mode: 'general', skills: [], modelPolicy: band,
    status: 'idle', createdBy: SYSTEM_ID, createdAt: now, updatedAt: now,
  };
}

/** Cheap/strong band first; nothing usable there → the best-value (economy) model of any tier. */
export async function routeHelper(deps: Pick<EngineRunnerDeps, 'router' | 'clock'>, purpose: string, extra: Pick<RouteRequest, 'needs' | 'exclude'>, effort?: Effort): Promise<RouteDecision> {
  const request = (anyTier: boolean): RouteRequest => ({
    agent: runtimeAgent(deps.clock.now(), anyTier),
    mode: { ...GENERAL_MODE, category: 'cheap-chat' },
    text: purpose,
    ...(effort ? { previous: { modelId: '', effort, explicit: true, asked: 'effort' as const } } : {}),
    ...extra,
  });
  try {
    return await deps.router.route(request(false));
  } catch (error) {
    if (!(error instanceof WorkforceError) || error.code !== 'unavailable') throw error;
    return deps.router.route(request(true));
  }
}

export interface EngineRunnerDeps {
  engines: EngineRegistry;
  router: Router;
  /** markLimited/markUnavailable: a failed attempt's account consequence; updateLimits: limits reported during a call. */
  accounts: Pick<AccountService, 'get' | 'markLimited' | 'markUnavailable' | 'updateLimits'>;
  catalog: Pick<ModelCatalog, 'get'>;
  paths: Pick<Paths, 'temp'>;
  clock: Clock;
  /** One time limit for the whole call, a failover's second attempt included (default 90 s). */
  timeoutMs?: number;
  /** The "Sign in to …" to-do when a helper call finds a plan signed out (accounts/failure.ts); missing = the state alone shows it. */
  notifications?: Pick<NotificationService, 'notify'>;
  /** What an attempt used, for who books it (the subconscious's runs: the spend journal). */
  onUsage?: (entry: { account: Account; route: RouteDecision; usage: NonNullable<EngineTurnResult['usage']> }) => void;
}

/** The folder below temp that helper turns work in (never the temp root). */
export const HELPER_DIR = 'helper';

/** The signal of one helper call: its time limit (`timeoutMs`, default 90 s, or the caller's shorter `deadlineMs`) and the caller's own signal. */
function callSignal(deps: Pick<EngineRunnerDeps, 'timeoutMs'>, signal: AbortSignal | undefined, deadlineMs?: number): AbortSignal {
  const limit = Math.min(deps.timeoutMs ?? 90_000, deadlineMs !== undefined && deadlineMs > 0 ? deadlineMs : Infinity);
  const timeout = AbortSignal.timeout(Math.max(1, Math.round(limit)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** One tool-less, session-less engine turn on a routed account and model. */
async function runOnce(deps: Pick<EngineRunnerDeps, 'engines' | 'paths' | 'clock'>, engine: EngineId, target: { account: Account; model: string; effort: Effort },
  turn: { system: string; input: TurnInputItem[]; schema?: Record<string, unknown>; signal: AbortSignal; onEvent?: (event: EngineEvent) => void; temperature?: number }): Promise<EngineTurnResult> {
  const cwd = path.join(deps.paths.temp, HELPER_DIR);
  await mkdir(cwd, { recursive: true, mode: 0o700 }); // temp is scratch: the folder may be gone
  return deps.engines.get(engine).run({
    runId: newId('run', deps.clock.now()),
    agentId: SYSTEM_ID,
    ...target,
    system: { stable: turn.system, volatile: '' },
    input: turn.input,
    tools: [],
    callTool: async () => failure('No tools in this call.'),
    cwd,
    outputSchema: turn.schema,
    readOnly: true,
    onEvent: turn.onEvent ?? (() => {}),
    signal: turn.signal,
    ...temperatureOf(turn.temperature), // B-078 D14: an engine that takes a temperature reads it, the others ignore the field
  });
}

/** `{ temperature }` for a finite value in 0–2, else nothing. */
function temperatureOf(value: number | undefined): Record<string, number> {
  return typeof value === 'number' && Number.isFinite(value) ? { temperature: Math.max(0, Math.min(2, value)) } : {};
}

export function createEngineRunner(deps: EngineRunnerDeps): StructuredRunner {
  return async ({ purpose, system, prompt, schema, signal, effort, deadlineMs, temperature }) => {
    const cut = callSignal(deps, signal, deadlineMs); // one time limit for both attempts
    const needs = schema ? { structured: true } : undefined;
    const attempt = async (route: RouteDecision) => {
      const account = deps.accounts.get(route.accountId);
      const model = deps.catalog.get(route.modelId);
      if (!account || !model) throw new Error('structured runner: routed account/model vanished');
      const onEvent = (event: EngineEvent) => {
        if (event.type !== 'limits') return;
        try { deps.accounts.updateLimits(account.id, event.limits); } catch { /* bookkeeping only */ }
      };
      const result = await runOnce(deps, route.engine, { account, model: model.model, effort: route.effort }, { system, input: [{ type: 'text', text: prompt }], schema, signal: cut, onEvent, temperature });
      // What the attempt says about its account counts like an agent turn's, so the router skips that account next.
      if (result.usage) { try { deps.onUsage?.({ account, route, usage: result.usage }); } catch { /* bookkeeping only */ } }
      const failed = accountFailure(result) !== undefined;
      if (failed) { try { recordAccountFailure(deps, account, model.model, result); } catch { /* bookkeeping only: the call's own error still reaches the caller */ } }
      return { route, model, result, failed };
    };
    let done = await attempt(await routeHelper(deps, purpose, { needs }, effort));
    // One failover like an agent turn's: a used-up or unreachable account goes once to another one, within the same time limit.
    if (done.failed && !cut.aborted) {
      const other = await routeHelper(deps, purpose, { needs, exclude: [done.route.accountId] }, effort).catch(() => undefined);
      if (other && other.accountId !== done.route.accountId && !cut.aborted) done = await attempt(other);
    }
    const { route, model, result } = done;
    if (result.stop !== 'done') throw new Error(`structured runner: ${result.error?.message ?? result.stop}`);
    return { text: result.text, structured: result.structured, by: route.modelId, effort: route.effort, efforts: model.efforts, ...(result.usage ? { usage: result.usage } : {}) };
  };
}

// ------------------------------------------------------------------ listening (MM10)

export const NO_LISTENER = 'No connected model can listen to recordings. Connect one that hears audio in Settings › Models – for example Gemini (a Google API key or OpenRouter) or GPT-4o audio (an OpenAI API key); a local server works when its model hears audio.';
export const PAID_OFF = 'Listening now needs a pay-per-use account, and pay-per-use fallback is off here.';

/** Engines whose models reach the compatible chat adapter (OpenAI: the same chat completions API). */
const LISTEN_ENGINES: ReadonlySet<EngineId> = new Set(['compatible', 'openai']);
/** B-058 G7: plan CLI engines that send a recording themselves – only for a model the catalog says hears audio. */
const OWN_AUDIO_ENGINES: ReadonlySet<EngineId> = new Set(['codex', 'acp']);

/** Families that hear audio through chat completions, for models whose catalog entry has no audioIn flag. */
const KNOWN_LISTENERS = /(?:^|[/:])(?:gpt-4o(?:-mini)?-audio|gpt-audio|gemini-(?![\w.-]*(?:embed|tts|image|live|omni|nano-banana))|voxtral|qwen[\w.-]*omni|phi-4-multimodal)/i;

/** Can this model hear a recording (input_audio, or its CLI engine's own audio input)? Media function specialists (FN1) never chat. */
export function hearsAudio(model: Pick<ModelInfo, 'engine' | 'model' | 'caps' | 'functions'>): boolean {
  if (model.functions?.length) return false;
  if (OWN_AUDIO_ENGINES.has(model.engine)) return model.caps.audioIn === true;
  if (!LISTEN_ENGINES.has(model.engine)) return false;
  return model.caps.audioIn ?? KNOWN_LISTENERS.test(model.model);
}

/** The engine a listening turn runs on: the CLI's own for Codex/ACP models, else the compatible chat adapter. */
export function listenEngine(model: Pick<ModelInfo, 'engine'>): EngineId {
  return OWN_AUDIO_ENGINES.has(model.engine) ? model.engine : 'compatible';
}

export interface ListenerDeps extends Omit<EngineRunnerDeps, 'accounts' | 'catalog'> {
  accounts: Pick<AccountService, 'get' | 'candidates'>;
  catalog: Pick<ModelCatalog, 'get' | 'list'>;
  settings: Pick<SettingsService, 'get'>;
}

export interface ListenOptions {
  /** Connected models that can hear a recording. */
  models: ModelInfo[];
  /** Pay-per-use accounts that can run one of them. */
  paid: Account[];
  /** A free (local) or plan account can run one of them. */
  free: boolean;
  /** The route may pick one of `paid`: Settings allow the paid spill-over, or nothing else can listen (routing/pool.ts). */
  mayPay: boolean;
}

/** What listening can run on right now (cheap: no network). */
export function listenOptions(deps: Pick<ListenerDeps, 'accounts' | 'catalog' | 'settings'>): ListenOptions {
  const models = deps.catalog.list().filter((model) => model.available && hearsAudio(model));
  const paid = new Map<string, Account>();
  let free = false;
  for (const model of models) {
    for (const account of deps.accounts.candidates(model.engine, model.model)) {
      if (account.provider !== model.provider || (model.accounts.length && !model.accounts.includes(account.id))) continue;
      if (chargeOf(account) === 'paid') paid.set(account.id, account);
      else free = true;
    }
  }
  let allowPaid = false;
  try { allowPaid = deps.settings.get().routing.allowPaidFallback; } catch { allowPaid = false; }
  return { models, paid: [...paid.values()], free, mayPay: paid.size > 0 && (allowPaid || !free) };
}

export interface ListenInput {
  audio: { path: string; name: string; mime: string };
  system: string;
  prompt: string;
  /**
   * A pay-per-use account may listen (listenOptions mayPay). Without it
   * they are kept out of the route, and a route to one (an account that became usable while the
   * router worked) is refused with PAID_OFF before anything is sent.
   */
  allowPaid: boolean;
  /** Account ids the turn may not use. */
  avoid?: readonly string[];
  signal?: AbortSignal;
}

export interface Heard {
  text: string;
  modelId: string;
  /** The turn ran on a pay-per-use account (models/pricing.ts chargeOf). */
  paid: boolean;
  /** The provider's own price of the turn (OpenRouter), when it reported one. */
  costUsd?: number;
}

export type Listener = (input: ListenInput) => Promise<Heard>;

/**
 * One listening turn. Fails with a user-safe WorkforceError: NO_LISTENER without a model,
 * PAID_OFF when only a pay-per-use account could listen and `allowPaid` is not set, the
 * router's reason when none can run now, or the engine's error with details { modelId, paid,
 * billed } – billed: the provider reported tokens, so a paid turn was charged.
 */
export function createListener(deps: ListenerDeps): Listener {
  return async ({ audio, system, prompt, allowPaid, avoid = [], signal }) => {
    const options = listenOptions(deps);
    const hearing = new Set(options.models.map((model) => model.id));
    if (!hearing.size) throw new WorkforceError('unavailable', NO_LISTENER, { details: { setup: true } });
    const keepOut = allowPaid ? avoid : [...avoid, ...options.paid.map((account) => account.id)];
    const exclude = [...deps.catalog.list().filter((model) => !hearing.has(model.id)).map((model) => model.id), ...keepOut];
    const route = await routeHelper(deps, 'listen', { exclude });
    const account = deps.accounts.get(route.accountId);
    const model = deps.catalog.get(route.modelId);
    if (!account || !model || !hearing.has(model.id)) throw new WorkforceError('unavailable', NO_LISTENER);
    const paid = chargeOf(account) === 'paid';
    if (paid && !allowPaid) throw new WorkforceError('unavailable', PAID_OFF, { details: { modelId: model.id, paid: false, billed: false } });
    const result = await runOnce(deps, listenEngine(model), { account, model: model.model, effort: route.effort }, {
      system, input: [{ type: 'text', text: prompt }, { type: 'audio', ...audio }], signal: callSignal(deps, signal),
    });
    const costUsd = result.usage?.costUsd;
    if (result.stop !== 'done') {
      const billed = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0) > 0;
      const code = result.stop === 'interrupted' ? 'cancelled' : result.error?.code ?? 'internal';
      throw new WorkforceError(code, result.error?.message ?? 'The model could not listen to the recording.', {
        retryAfterMs: result.error?.retryAfterMs, details: { modelId: model.id, paid, billed, ...(costUsd !== undefined ? { costUsd } : {}) },
      });
    }
    return { text: result.text, modelId: model.id, paid, ...(costUsd !== undefined ? { costUsd } : {}) };
  };
}
