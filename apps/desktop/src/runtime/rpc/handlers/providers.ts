// RPC handlers: provider accounts (list/detect/add/update/login/logout/remove/install), usage,
// the model catalog (list/recent/refresh/status), model policies (agent, chat+agent, global),
// routing previews (with the chat's return choice like a turn, agents/next-route.ts) and the
// efforts a model supports.
// Owns: param checks and scope rules for these methods. B-078 ("alles vom Handy"): accounts.* are open to the owner's
// phone with 'settings' on a secure transport (the app's loopback tunnel; a plain LAN browser stays without them) – plans,
// API keys and sign-ins from the phone; a CLI sign-in a phone starts opens its page as a tab in this PC's own browser pane
// (global), which the phone mirrors and works in, so the provider's callback lands on this PC. Catalog refreshes stay
// owner-only; phones with 'chat' read usage, models, recent models, efforts, policies and the
// catalog status; 'manage' sets policies and previews routing – except the global cost mode and default model
// (Settings.routing.costMode and the Work use routing.work), which only the owner sets.
// accounts.useReset (a Codex reset, after the person confirmed) and accounts.test (an API endpoint's or a
// local server's models before adding it; the key is used for that call only) are owner only.
// accounts.add and accounts.test take `apiKey` typed or as a handle secret://<id> of the catalog (accounts/connect.ts).
// models.uses (owner, read-only): what each model use resolves to right now (models/uses.ts).
// B-051: accounts.try (one tiny real turn on one account, accounts/try-turn.ts – owner only) and the sign-in
// page an `accounts.add`/`accounts.login` hands back (never logged here).
// Never: business logic, and never echoes or logs API keys –
// `accounts.add` hands the key straight to the account service, which stores it encrypted (an
// environment key arrives as its variable's name only).

import { WorkforceError } from '../../../shared/errors.ts';
import { GLOBAL_SPACE } from '../../../shared/api/workspace-browser.ts';
import { DECISION_PROVIDER, ENV_KEY_PROVIDERS, type ModelPolicy, type ProviderId } from '../../../shared/model/providers.ts';
import { tryDecisionConnection } from '../../decision/systemone.ts';
import { bad, id, input, notFound, obj, oneOf, onlyKeys, optBool, optId, optNum, optOneOf, optStrings, optText, text, type Obj } from '../params.ts';
import { scopeHas } from '../table.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { returnChoice } from '../../agents/next-route.ts';
import { tryAccount } from '../../accounts/try-turn.ts';
import { modelUses } from '../../models/uses.ts';

const CHAT = { capability: 'chat' } as const;
/** accounts.*: the owner, and the owner's phone on a secure transport. */
const ACCOUNTS = { capability: 'settings', secure: true } as const;
const MANAGE = { capability: 'manage' } as const;

const PROVIDERS: readonly ProviderId[] = [
  'codex', 'claude', 'openai', 'anthropic', 'openrouter', 'google', 'xai', 'deepseek',
  'ollama', 'lmstudio', 'llamacpp', 'vllm', 'compatible',
  'gemini-cli', 'copilot', 'kimi-cli', // PR8 (B-044: Kimi Code): plan CLIs on the ACP engine
  'groq', 'elevenlabs', 'fal', // B-058
  'decision-api',
];
/** B-044: providers an endpoint test can reach (the HTTP engines' providers – the API form's and the local servers' "Test"). */
const TESTABLE: readonly ProviderId[] = ['openai', 'anthropic', 'openrouter', 'google', 'xai', 'deepseek', 'groq', 'compatible', 'ollama', 'lmstudio', 'llamacpp', 'vllm'];
const INSTALLABLE = ['claude', 'codex'] as const;
const ENV_KEY_NAMES: readonly string[] = Object.keys(ENV_KEY_PROVIDERS);
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const TIERS = ['local', 'small', 'strong', 'frontier'] as const;
const COST_MODES = ['economy', 'balanced', 'best'] as const;
/** Model ids look like `codex:gpt-6.1-sol` or `openrouter:anthropic/claude-…`. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/;
/** Runs a routing preview reads for the choice to return to (agents/turn-prepare.ts RETURN_WINDOW). */
const PREVIEW_RUNS = 50;

function modelId(o: Obj, key: string): string {
  const value = text(o, key, { max: 200 });
  if (!MODEL_ID.test(value)) bad(key, 'a model id');
  return value;
}

function optModelIds(o: Obj, key: string): string[] | undefined {
  const values = optStrings(o, key, { maxItems: 50, max: 200 });
  if (values?.some((value) => !MODEL_ID.test(value))) bad(key, 'a list of model ids');
  return values;
}

function baseUrlOf(o: Obj): string | undefined {
  const value = optText(o, 'baseUrl', { max: 2048 });
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return bad('baseUrl', 'an http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('baseUrl', 'an http(s) URL');
  return value;
}

/** Only known policy fields; tier bounds must be ordered. */
export function policyOf(o: Obj): ModelPolicy {
  onlyKeys(o, ['pin', 'effort', 'floorTier', 'ceilingTier', 'costMode', 'prefer', 'avoid'], 'policy');
  const policy: ModelPolicy = {};
  if (o.pin !== undefined && o.pin !== null) policy.pin = modelId(o, 'pin');
  const effort = optOneOf(o, 'effort', EFFORTS);
  if (effort) policy.effort = effort;
  const floorTier = optOneOf(o, 'floorTier', TIERS);
  if (floorTier) policy.floorTier = floorTier;
  const ceilingTier = optOneOf(o, 'ceilingTier', TIERS);
  if (ceilingTier) policy.ceilingTier = ceilingTier;
  if (floorTier && ceilingTier && TIERS.indexOf(floorTier) > TIERS.indexOf(ceilingTier)) bad('floorTier', 'a tier not above ceilingTier');
  const costMode = optOneOf(o, 'costMode', COST_MODES);
  if (costMode) policy.costMode = costMode;
  const prefer = optModelIds(o, 'prefer');
  if (prefer) policy.prefer = prefer;
  const avoid = optModelIds(o, 'avoid');
  if (avoid) policy.avoid = avoid;
  return policy;
}

function policyScope(o: Obj): { agentId?: string; conversationId?: string } {
  const scope: { agentId?: string; conversationId?: string } = {};
  const agentId = optId(o, 'agentId');
  if (agentId) scope.agentId = agentId;
  const conversationId = optId(o, 'conversationId');
  if (conversationId) scope.conversationId = conversationId;
  return scope;
}

/**
 * A sign-in a phone started: the page the CLI printed opens as a tab in this PC's own pane (global) – the phone mirrors
 * that pane and works in it, and the provider's callback reaches this PC's localhost. The owner's window opens it itself.
 */
async function openOnPc<T>(ctx: HandlerContext, result: T): Promise<T> {
  if (ctx.scope.kind !== 'device') return result;
  const page = result as { url?: unknown; signInUrl?: unknown } | undefined;
  const url = page?.url ?? page?.signInUrl;
  const sideBrowser = ctx.services.host?.sideBrowser;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !sideBrowser) return result;
  try {
    await sideBrowser({ action: 'open', url, newTab: true, show: true, space: GLOBAL_SPACE, agent: { id: 'human', name: 'Sign-in' } });
  } catch (error) {
    ctx.services.log.warn('sign-in page not opened on the PC', { error: String((error as Error)?.message ?? error).slice(0, 200) });
  }
  return result;
}

/** A refresh asks providers / the catalog again: the owner and 'manage' devices only. */
function mayRefresh(ctx: HandlerContext, params: unknown): boolean {
  return (optBool(input(params), 'refresh') ?? false) && scopeHas(ctx.scope, 'manage');
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- accounts
  table.add('accounts.list', (_params, ctx) => ctx.services.accounts.list(), ACCOUNTS);
  table.add('accounts.detect', (params, ctx) => ctx.services.accounts.detect(optBool(input(params), 'force') ?? false), ACCOUNTS);
  table.add('accounts.add', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['provider', 'label', 'apiKey', 'baseUrl', 'rotation', 'envVar', 'detected']);
    // PR5: `envVar` names a key variable of the one table (its value never travels), `detected` = "Add again".
    const envVar = optOneOf(o, 'envVar', ENV_KEY_NAMES);
    const detected = optBool(o, 'detected');
    return ctx.services.accounts.add({
      provider: oneOf(o, 'provider', PROVIDERS),
      label: optText(o, 'label', { max: 80 }),
      apiKey: optText(o, 'apiKey', { max: 4096 }),
      baseUrl: baseUrlOf(o),
      rotation: optBool(o, 'rotation'),
      ...(envVar ? { envVar } : {}),
      ...(detected ? { detected } : {}),
    }).then((added) => openOnPc(ctx, added));
  }, ACCOUNTS);
  table.add('accounts.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'label', 'priority', 'rotation', 'enabled']);
    const patch: { label?: string; priority?: number; rotation?: boolean; enabled?: boolean } = {};
    const label = optText(o, 'label', { max: 80 });
    if (label !== undefined) patch.label = label;
    const priority = optNum(o, 'priority', { min: -10_000, max: 10_000 });
    if (priority !== undefined) patch.priority = priority;
    const rotation = optBool(o, 'rotation');
    if (rotation !== undefined) patch.rotation = rotation;
    const enabled = optBool(o, 'enabled');
    if (enabled !== undefined) patch.enabled = enabled;
    return ctx.services.accounts.update(id(o), patch);
  }, ACCOUNTS);
  // B-051 L4: the person's own UI gets the sign-in page the CLI printed (`url`; agent tools never do).
  table.add('accounts.login', (params, ctx) => ctx.services.accounts.login(id(input(params)), { page: true }).then((started) => openOnPc(ctx, started)), ACCOUNTS);
  table.add('accounts.logout', async (params, ctx) => {
    await ctx.services.accounts.logout(id(input(params)));
    return { ok: true };
  }, ACCOUNTS);
  table.add('accounts.remove', async (params, ctx) => {
    await ctx.services.accounts.remove(id(input(params)));
    return { ok: true };
  }, ACCOUNTS);
  table.add('accounts.install', async (params, ctx) => {
    const provider = oneOf(input(params), 'provider', INSTALLABLE);
    await ctx.services.accounts.install(provider);
    return { ok: true };
  }, ACCOUNTS);
  // B-051: one tiny real turn on exactly this account (accounts/try-turn.ts) – never a routing change.
  table.add('accounts.try', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const s = ctx.services;
    const decision = s.accounts.get(id(o));
    if (decision?.provider === DECISION_PROVIDER) return tryDecisionConnection(s, decision); // no engine: one question of its own protocol
    return tryAccount({ engines: s.engines, catalog: s.catalog, accounts: s.accounts, paths: s.paths, clock: s.clock, notifications: s.notifications }, id(o));
  }, ACCOUNTS);
  // B-044: redeem a banked Codex reset after the person confirmed (accounts/resets.ts).
  table.add('accounts.useReset', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'creditId']);
    const creditId = optText(o, 'creditId', { max: 200 });
    const outcome = await (ctx.services.accounts.useReset?.(id(o), creditId) ?? notFound('Account resets'));
    return { outcome };
  }, ACCOUNTS);
  // B-044: the API key form's Test – the key reaches the engine for this one call, never storage or logs.
  table.add('accounts.test', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['provider', 'baseUrl', 'apiKey']);
    return ctx.services.accounts.test?.({ provider: oneOf(o, 'provider', TESTABLE), baseUrl: baseUrlOf(o), apiKey: optText(o, 'apiKey', { max: 4096 }) }) ?? notFound('Endpoint test');
  }, ACCOUNTS);
  // refresh = the quota details opened: the account monitor asks the providers at most once a minute.
  table.add('usage.list', (params, ctx) => ctx.services.accounts.usage(mayRefresh(ctx, params)), CHAT);

  // ---------------------------------------------------------------- models & routing
  table.add('models.list', async (params, ctx) => {
    if (mayRefresh(ctx, params)) await ctx.extras.catalogRefresh();
    return ctx.services.catalog.list();
  }, CHAT);
  table.add('models.uses', (params, ctx) => {
    onlyKeys(input(params), []);
    return modelUses(ctx.services);
  });
  table.add('models.recent', (params, ctx) => ctx.services.catalog.recent(optId(input(params), 'agentId')), CHAT);
  table.add('models.getPolicy', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId']);
    return ctx.extras.policies.get(policyScope(o));
  }, CHAT);
  table.add('models.setPolicy', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId', 'policy']);
    const scope = policyScope(o);
    const policy = policyOf(obj(o, 'policy'));
    // The global cost mode and default model are Settings.routing.costMode / routing.work (policies.ts), a section
    // settings.update refuses to every device: the same rule here (settings audit 23.10.). Agent/chat choices stay 'manage'.
    const global = !scope.agentId && !scope.conversationId;
    if (global && (policy.costMode || policy.pin) && ctx.scope.kind !== 'owner') {
      throw new WorkforceError('forbidden', 'The model choice for all agents can only be changed on the PC (Settings › Models).', { details: { key: policy.costMode ? 'costMode' : 'pin' } });
    }
    ctx.extras.policies.set(scope, policy);
    return { ok: true };
  }, MANAGE);
  table.add('routing.preview', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'conversationId', 'text', 'mode', 'ignorePin']);
    const agent = ctx.services.org.get(id(o, 'agentId')) ?? notFound('Agent');
    const mode = ctx.services.modes.get(optText(o, 'mode', { max: 80 }) ?? agent.mode);
    const conversationId = optId(o, 'conversationId');
    // RT5: like a turn (agents/turn-prepare.ts), the chat's last done run is the choice the return
    // rule keeps (a pending model.set request is not consumed by a preview). `ignorePin` = what a
    // picker's "nothing chosen" option would run: in a chat its own model/effort choice does not
    // answer (its runs do); without a chat the agent's own pin does not answer either.
    const ignorePin = optBool(o, 'ignorePin');
    const { pin: _pin, ...unpinned } = agent.modelPolicy ?? {};
    const previous = conversationId ? returnChoice(ctx.services.runs.list(agent.id, PREVIEW_RUNS), conversationId, undefined) : undefined;
    return ctx.services.router.route({
      agent: ignorePin && !conversationId ? { ...agent, modelPolicy: unpinned } : agent,
      conversationId: ignorePin ? undefined : conversationId,
      mode,
      text: optText(o, 'text', { max: 20_000, multiline: true, allowEmpty: true }),
      ...(previous ? { previous } : {}),
    });
  }, MANAGE);
  table.add('catalog.refresh', async (_params, ctx) => {
    const result = await ctx.extras.catalogRefresh();
    return { ok: true, models: result.models, fetchedAt: result.fetchedAt, refreshedAt: ctx.extras.catalogStatus().refreshedAt };
  });
  // Read-only – like models.list for 'chat' devices.
  table.add('catalog.status', (_params, ctx) => ctx.extras.catalogStatus(), CHAT);
  table.add('efforts.forModel', (params, ctx) => [...(ctx.services.catalog.get(modelId(input(params), 'modelId'))?.efforts ?? [])], CHAT);
}
