// Runtime service contracts: models, routing, decisions, accounts, engines, knowledge, skills, modes. Re-exported by ../contracts.ts (import from there).
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { Bus } from '../bus.ts';
import type { Db } from '../db/database.ts';
import type { Host } from '../host.ts';
import type { Engine } from '../engines/types.ts';
import type { ToolContext, ToolDef, ToolOutput, ToolSpec } from '../tools/types.ts';
import type { Agent, AgentTemplate, OrgNode, Space } from '../../shared/model/org.ts';
import type {
  Conversation, ConversationSettings, ConversationSummary, Member, Message, MessageMeta, SendMessageInput, StatusLine,
} from '../../shared/model/chat.ts';
import type {
  CreateTaskInput, Schedule, Task, TaskFilter, TaskResult, TaskStatus, TaskView,
} from '../../shared/model/tasks.ts';
import type { Handoff, KnowledgeHit, KnowledgeItem, KnowledgeListFilter, KnowledgeQuery, ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import type {
  Account, AccountLimits, DetectionReport, Effort, EngineId, ModelInfo, ProviderId, RouteDecision, UsageSummary,
} from '../../shared/model/providers.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { AgentActivity, Run, RunItem, WakeReason } from '../../shared/model/runs.ts';
import type { FileRef, Settings, SettingsPatch } from '../../shared/model/system.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import type { ActionDescription } from '../tools/types.ts';

// ------------------------------------------------------------------ models, routing, decisions

export interface DecisionRequest {
  question: string;
  type: 'choice' | 'score' | 'predicate';
  options?: string[]; // for choice
  context?: string; // compact state
  /** 'agent' (addition RT9): an agent's own decide tool call (tools/builtin/decide.ts). */
  purpose: 'route' | 'widget' | 'responder' | 'retrieval' | 'skill' | 'classify' | 'verify' | 'other' | 'agent';
  /** Addition (F05): the request's deadline over all backend attempts; when it passes the running call is
   * aborted and the answer is none (confidence 0, by 'timeout'). Absent = the hub's per-attempt limit only. */
  timeoutMs?: number;
  /** Addition (RT9): the caller's stop (a stopped turn): the running backend call is aborted, no further
   * backend is tried and the answer is none (confidence 0, by 'stopped'). */
  signal?: AbortSignal;
}

export interface DecisionResult {
  choice?: string;
  score?: number;
  value?: boolean;
  confidence: number;
  by: string; // backend/model
  /** Addition (RT9), choice requests only (DecisionHub sets it): what the answer means – see DecisionOutcome. */
  outcome?: DecisionOutcome;
}

/**
 * Addition (RT9): 'choice' = an option with confidence ≥ 0.55; 'none_fit' = the model picked
 * "none" with confidence ≥ 0.55; 'unsure' = lower confidence, an unknown option, a timeout or no
 * backend (a low-confidence `choice` is kept as a lean).
 */
export type DecisionOutcome = 'choice' | 'none_fit' | 'unsure';

export interface DecisionService {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  available(): boolean;
}

export interface ModelCatalog {
  list(): ModelInfo[];
  get(id: string): ModelInfo | undefined;
  refresh(options?: { force?: boolean }): Promise<void>;
  recent(agentId?: string): string[];
}

export interface RouteRequest {
  agent: Agent;
  conversationId?: string;
  taskId?: string;
  mode: ModeInfo;
  text?: string; // what the turn is about (for category inference)
  /** Decision → LLM return rule. `explicit` (addition R3-R): the agent itself asked for this model/effort
   * (model.set request) – it then beats default pins and weak priors, but never policy bounds.
   * Additions (RT2, routing/previous.ts): `asked` = what the request named, 'model' or 'effort'
   * (absent = both); an effort-only request leaves the model to the usual rules. `category` = the
   * category of the run `previous` comes from: its effort is carried only within that category, and
   * after a change of category its model only while it scores within 0.3 of the best candidate.
   * B-048 E4.2 (ROUTING hunk, routing/need.ts): `need` = the agent asked for a kind of model instead of
   * a concrete one, relative to `from` (the model it ran on); the router resolves it (`modelId` = the
   * model model.set named in its answer, kept while it still meets the need).
   * B-078 (D14, D16): `temperature` = the sampling temperature 0..2 the request asked for; the router never reads it, the
   * turn hands it to the engine (agents/next-route.ts temperatureOf → EngineTurnInput.temperature). */
  previous?: { modelId: string; effort: Effort; explicit?: boolean; asked?: 'model' | 'effort'; category?: string; need?: { kind: 'stronger' | 'cheaper' | 'faster' | 'vision' | 'long_context'; from?: string }; temperature?: number };
  exclude?: string[]; // models/accounts that just failed
  needs?: { vision?: boolean; computerUse?: boolean; structured?: boolean; tier?: ModelInfo['tier'] };
  /** B-057 S10: a split's turn (routing/split-route.ts) – its own model/effort beats the agent's pin and fixed effort; plan pacing. */
  split?: { splitId: string };
}

export interface Router {
  route(request: RouteRequest): Promise<RouteDecision>;
}

export interface AccountService {
  list(): Account[];
  get(id: string): Account | undefined;
  detect(force?: boolean): Promise<DetectionReport>;
  /** Addition (RT7), optional so simple fakes stay valid: the last detection's report, no scan. */
  lastDetection?(): DetectionReport | undefined;
  add(input: { provider: ProviderId; label?: string; apiKey?: string; baseUrl?: string; rotation?: boolean }): Promise<Account>;
  update(id: string, patch: Partial<Pick<Account, 'label' | 'priority' | 'rotation' | 'enabled'>>): Account;
  login(id: string): Promise<{ started: boolean; url?: string }>;
  logout(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  install(provider: 'claude' | 'codex'): Promise<void>;
  /** Healthy accounts able to run `engine`, best first (priority, headroom, rotation rules). */
  candidates(engine: EngineId, model?: string): Account[];
  markLimited(id: string, until: number, limits?: AccountLimits): void;
  updateLimits(id: string, limits: AccountLimits): void;
  /** A turn found the account signed out ('needs_login') or its CLI missing ('error'); true when its state changed. */
  markUnavailable(id: string, state: 'needs_login' | 'error'): boolean;
  usage(refresh?: boolean): Promise<UsageSummary[]>;
  apiKey(id: string): Promise<string | undefined>; // decrypted only for HTTP engines in-process
  /** Shutdown: ends the open sign-in processes and windows; later checks store nothing (optional so simple fakes stay valid). */
  dispose?(): Promise<void>;
  /** Reads one account's state and limits now, in the monitor's queue (B-075: a login that came from another PC; optional so simple fakes stay valid). */
  checkNow?(id: string): Promise<void>;
}

export interface EngineRegistry {
  get(id: EngineId): Engine;
  all(): Engine[];
  disposeIdle(): Promise<void>;
}

// ------------------------------------------------------------------ knowledge

export interface KnowledgeService {
  search(query: KnowledgeQuery): Promise<KnowledgeHit[]>;
  save(item: Partial<KnowledgeItem> & { title: string; body: string; scope: KnowledgeItem['scope']; createdBy: string }): KnowledgeItem;
  /** Correction: expires the old row and links the new one (bi-temporal history). */
  correct(id: string, patch: { body?: string; title?: string; validTo?: number }, by: string): KnowledgeItem;
  expire(id: string, by: string, reason?: string): void;
  get(id: string): KnowledgeItem | undefined;
  /** Addition (CTX5): `kinds` narrows to several kinds (the knowledge browser hides observations). */
  list(filter: KnowledgeListFilter & { kinds?: readonly string[] }): Promise<KnowledgeItem[]>;
  /** The runtime's chat observations (rows only, no file is read): what a prompt reads. */
  observations(filter: KnowledgeListFilter): KnowledgeItem[];
  /** Addition (B-044), optional so simple fakes stay valid: the kinds current rows carry (the browser's kind chips). */
  kinds?(): Promise<KnowledgeItem['kind'][]>;
  history(id: string): KnowledgeItem[];
  pinned(agentId: string, conversationId?: string): KnowledgeItem[];
  /** Addition (CTX5): pins/unpins the current version in place (a prompt flag – no new version). */
  pin(id: string, pinned: boolean, by: string): KnowledgeItem;
  /** Addition (CTX5): deletes the whole correction chain of `id` (rows, FTS) in one transaction and emits
   * `knowledge.removed`. Only for the person's request (owner RPC knowledge.forget) – agents expire or correct instead. */
  forget(id: string, by: string): { ids: string[] };
}

export interface SkillService {
  /** One skill per name, as `viewerId`'s route resolves it (own, managers up the chain, shared, built in). */
  list(viewerId?: string): SkillInfo[];
  get(name: string, viewerId?: string): { info: SkillInfo; body: string } | undefined;
  save(input: { name: string; description: string; body: string; ownerAgentId?: string }): SkillInfo;
  remove(name: string): void;
  /** Skills index (name + description) an agent may use in a mode. */
  indexFor(agent: Agent, mode: ModeInfo): SkillInfo[];
}

export interface ModeService {
  list(): ModeInfo[];
  get(key: string): ModeInfo;
}
