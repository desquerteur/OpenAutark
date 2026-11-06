// Test harness for the model catalog and router (package R3-R): in-memory SQLite, manual clock,
// fake accounts (real selection rules), fake engines with scripted model lists, fake settings,
// secrets, org and chats. Services are late-bound like the composition root does.

import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { Priors } from '../../../src/runtime/models/priors.ts';
import { Catalog } from '../../../src/runtime/models/catalog.ts';
import { RouterImpl } from '../../../src/runtime/routing/router.ts';
import { selectCandidates } from '../../../src/runtime/accounts/candidates.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import type { DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineCaps, EngineModel } from '../../../src/runtime/engines/types.ts';
import type { Account, AccountLimits, EngineId, ProviderId } from '../../../src/shared/model/providers.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Conversation, ConversationSettings, Member } from '../../../src/shared/model/chat.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Settings, SettingsPatch } from '../../../src/shared/model/system.ts';
import type { EventMap, EventName } from '../../../src/shared/api/events.ts';

export const T0 = Date.UTC(2026, 9, 17, 9, 0, 0);

/** Small, stable priors (the shipped file is our judgement and may change). */
export const TEST_PRIORS = Priors.parse({
  version: 'test',
  categories: {},
  models: [
    { match: 'claude-opus-5-5*', name: 'Claude Opus 5.5', tier: 'frontier', relCost: 0.6, caps: { vision: true, tools: true, computerUse: true, structuredOutput: true },
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', strengths: { 'video-animation': 0.9, chat: 0.4, coding: 0.7, 'cheap-chat': -0.6 } },
    { match: 'claude-haiku-5-5*', name: 'Claude Haiku 5.5', tier: 'small', relCost: 0.03, caps: { vision: true, tools: true, structuredOutput: true },
      efforts: ['low', 'medium', 'high'], defaultEffort: 'low', strengths: { 'cheap-chat': 0.8, chat: 0.4, 'video-animation': -0.5, 'harness-self-modification': -1 } },
    { match: 'gpt-6.1-sol*', name: 'GPT-6.1 Sol', tier: 'frontier', relCost: 0.3, caps: { vision: true, tools: true, structuredOutput: true },
      efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', strengths: { coding: 0.8, chat: 0.4, research: 0.8, 'video-animation': -0.7 } },
    { match: 'gpt-6-luna*', name: 'GPT-6 Luna', tier: 'small', relCost: 0.03, caps: { tools: true, structuredOutput: true },
      efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'low', strengths: { 'cheap-chat': 0.8, chat: 0.4, 'video-animation': -0.6 } },
    { match: 'gpt-6-astra*', name: 'GPT-6 Astra', tier: 'frontier', relCost: 1, caps: { tools: true, structuredOutput: true }, strengths: { chat: 0.9 } },
    { match: 'nimble*', name: 'nimble (decision)', tier: 'local', relCost: 0, strengths: { decision: 0.9 } },
  ],
});

export function account(id: string, provider: ProviderId, patch: Partial<Account> = {}): Account {
  return {
    id, provider, label: id, auth: provider === 'codex' || provider === 'claude' ? 'cli' : provider === 'ollama' ? 'local' : 'api_key',
    state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: T0, ...patch,
  };
}

export function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, name: id, role: '', avatar: { kind: 'initials', value: id.slice(0, 2) }, instructions: '', mode: 'general', skills: [],
    modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: T0, updatedAt: T0, ...patch,
  };
}

export function mode(category: string, patch: Partial<ModeInfo> = {}): ModeInfo {
  return { key: category, name: category, description: '', skills: [], tools: ['*'], category, instructions: '', ...patch };
}

/** One engine whose listModels answers from a per-account (or per-provider) table. */
export class FakeEngine implements Engine {
  readonly id: EngineId;
  readonly caps: EngineCaps = { sessions: false, dynamicTools: true, mcp: false, images: true, rebase: false, structured: true, ownTools: false };
  lists = new Map<string, EngineModel[] | Error>();
  calls: string[] = [];
  constructor(id: EngineId) { this.id = id; }
  async listModels(account: Account): Promise<EngineModel[]> {
    this.calls.push(account.id);
    const value = this.lists.get(account.id) ?? this.lists.get(account.provider);
    if (value instanceof Error) throw value;
    if (!value) throw new Error(`no list for ${account.id}`);
    return value.map((model) => ({ ...model }));
  }
  async checkAccount() { return { state: 'ok' as const }; }
  async run(): Promise<never> { throw new Error('not used'); }
  async dispose() {}
}

export class FakeAccounts {
  accounts: Account[] = [];
  private readonly clock: ManualClock;
  private readonly bus: Bus;
  constructor(clock: ManualClock, bus: Bus) { this.clock = clock; this.bus = bus; }
  list() { return this.accounts.map((a) => ({ ...a })); }
  get(id: string) { return this.accounts.find((a) => a.id === id); }
  candidates(engine: EngineId) { return selectCandidates(this.accounts, engine, this.clock.now()); }
  upsert(next: Account, emit = true) {
    this.accounts = [...this.accounts.filter((a) => a.id !== next.id), next];
    if (emit) this.bus.emit('account.upserted', next);
  }
  remove(id: string) { this.accounts = this.accounts.filter((a) => a.id !== id); this.bus.emit('account.removed', { id }); }
  // What a failed turn or helper call records (accounts/failure.ts), like AccountServiceImpl.
  markLimited(id: string, until: number, limits?: AccountLimits) {
    const account = this.get(id);
    if (account) this.upsert({ ...account, state: 'cooling', coolingUntil: until, limits: limits ?? account.limits });
  }
  markUnavailable(id: string, state: 'needs_login' | 'error') {
    const account = this.get(id);
    if (!account || !account.enabled || account.state === state) return false;
    this.upsert({ ...account, state });
    return true;
  }
  updateLimits(id: string, limits: AccountLimits) {
    const account = this.get(id);
    if (account) this.upsert({ ...account, limits });
  }
}

/** A Work plan the harness never connects: no work plan bonus for any account. */
export const NO_PLAN_HERE = 'gemini-cli';

export function setup(options: { decisions?: DecisionService; secrets?: Record<string, string>; priors?: Priors } = {}) {
  const db = new Db(':memory:');
  migrate(db);
  const bus = new Bus((error) => { throw error; });
  const clock = new ManualClock(T0);
  const events: Array<{ event: EventName; data: unknown }> = [];
  bus.onAny((event, data) => events.push({ event, data }));
  const of = <E extends EventName>(event: E) => events.filter((e) => e.event === event).map((e) => e.data as EventMap[E]);
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];

  // The rule tests run without a work plan: the Work use names a plan none of these accounts is (B-044's default –
  // agent work on Claude Code while its plan login is on, shared/model/model-guide.ts effectiveWorkPlan – is tested
  // in routing/model-choice.test.ts).
  const defaults = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  let settings: Settings = { ...defaults, routing: { ...defaults.routing, work: NO_PLAN_HERE } };
  const settingsService = {
    get: () => settings,
    update(patch: SettingsPatch) {
      settings = { ...settings, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { ...(settings as any)[key], ...value }])) } as Settings;
      bus.emit('settings.updated', settings);
      return settings;
    },
  };

  const agents = new Map<string, Agent>();
  const org = {
    get: (id: string) => agents.get(id),
    update(id: string, patch: Partial<Agent>) { const next = { ...agents.get(id)!, ...patch }; agents.set(id, next); return next; },
  };
  const conversations = new Map<string, Conversation>();
  const members = new Map<string, Member[]>();
  const chats = {
    get: (id: string) => conversations.get(id),
    members: (id: string) => members.get(id) ?? [],
    update(id: string, patch: { settings?: Partial<ConversationSettings> }) {
      const conversation = conversations.get(id);
      if (!conversation) throw new Error('missing chat');
      const next = { ...conversation, settings: { ...conversation.settings, ...patch.settings } };
      conversations.set(id, next);
      return next;
    },
  };
  const addChat = (id: string, agentIds: string[], chatSettings: ConversationSettings = {}) => {
    conversations.set(id, { id, title: id, titleNamed: false, createdBy: 'human', pinned: false, settings: chatSettings, lastSeq: 0, createdAt: T0, updatedAt: T0 } as Conversation);
    members.set(id, [
      { conversationId: id, memberId: 'human', kind: 'human', role: 'owner', readSeq: 0, joinedAt: T0 },
      ...agentIds.map((memberId) => ({ conversationId: id, memberId, kind: 'agent' as const, role: 'member' as const, readSeq: 0, joinedAt: T0 })),
    ]);
  };

  const engines = new Map<EngineId, FakeEngine>();
  const engine = (id: EngineId) => { let e = engines.get(id); if (!e) engines.set(id, (e = new FakeEngine(id))); return e; };
  const accounts = new FakeAccounts(clock, bus);
  const secretUses: Array<{ id: string; agentId: string }> = [];

  const services = {
    db, bus, clock,
    log: { debug() {}, info() {}, warn(message: string, data?: Record<string, unknown>) { warnings.push({ message, data }); }, error() {} },
    settings: settingsService,
    org, chats,
    accounts,
    engines: { get: (id: EngineId) => { const e = engines.get(id); if (!e) throw new Error(`engine ${id} missing`); return e; }, all: () => [...engines.values()], disposeIdle: async () => {} },
    secrets: { use: async (id: string, agentId: string) => { secretUses.push({ id, agentId }); const value = options.secrets?.[id]; if (!value) throw new Error('no secret'); return value; } },
    decisions: options.decisions,
  } as unknown as RuntimeServices;

  const catalog = new Catalog({ services: () => services, priors: options.priors ?? TEST_PRIORS, debounceMs: 0, priceFeed: false });
  services.catalog = catalog;
  const router = new RouterImpl({ services: () => services });
  services.router = router;

  return { db, bus, clock, events, of, warnings, services, catalog, router, accounts, engine, agents, addChat, conversations, settings: settingsService, secretUses };
}

/** Two plan accounts with two models each (the common "Codex + Claude Code" setup). */
export async function standardSetup(options: Parameters<typeof setup>[0] = {}) {
  const h = setup(options);
  h.accounts.upsert(account('acc_codex', 'codex'), false);
  h.accounts.upsert(account('acc_claude', 'claude'), false);
  h.engine('codex').lists.set('codex', [
    { model: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', vision: true },
    { model: 'gpt-6-luna', name: 'gpt-6-luna', efforts: ['none', 'low', 'medium', 'high'], vision: false },
  ]);
  h.engine('claude').lists.set('claude', [
    { model: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', vision: true, contextTokens: 1_000_000 },
    { model: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'], vision: true },
  ]);
  await h.catalog.refresh({ force: true });
  return h;
}
