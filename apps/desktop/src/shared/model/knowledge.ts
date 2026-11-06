// Knowledge model: bi-temporal memory items, skills and modes.
// Owns: shapes for what agents know and how they are configured for a kind of work.
// Never: treats retrieved knowledge as an instruction or a permission (it is a hint).

// 'mode' (CTX3): a mode's knowledge area (scopeId = mode key) – every agent reads it, tips prefer the turn's own mode.
// 'reference' (F-52): a person's references (scopeId = subject: 'human' or a person's 'per_…') – no agent reads them through
// knowledge search, tips or pins; runtime/references/* checks its own per-principal rights.
export type KnowledgeScope = 'global' | 'space' | 'agent' | 'conversation' | 'website' | 'app' | 'mode' | 'reference';

export type KnowledgeKind =
  | 'fact' // something true about the world/user/company (with validity)
  | 'preference' // how the user likes things
  | 'experience' // a learned tip from past work ("last time X failed because …")
  | 'procedure' // a reusable way of doing something (may become a skill)
  | 'plan' // explicit project knowledge / plans
  | 'observation' // compacted chat observations (endless chats)
  | 'note' // free note
  | 'reference'; // F-52: a person's words, reasons or corrections (scope 'reference', runtime/references/*)

export interface KnowledgeSource {
  kind: 'user' | 'message' | 'run' | 'web' | 'file' | 'agent' | 'import';
  ref?: string;
  trusted: boolean; // false for web pages, foreign chats, feedback reports …
}

export interface KnowledgeItem {
  id: string;
  scope: KnowledgeScope;
  scopeId?: string; // space/agent/conversation id, or site host / app name
  kind: KnowledgeKind;
  title: string;
  /** A memory file's own description line (files only). */
  description?: string;
  body: string;
  tags: string[];
  source: KnowledgeSource;
  confidence: number; // 0..1
  pinned: boolean; // always in the agent's prompt (small, hard-capped)
  validFrom?: number; // world time the fact starts being true
  validTo?: number; // world time it stops being true
  recordedAt: number; // when we learned it
  expiredAt?: number; // when a correction superseded it (row kept for history)
  supersedes?: string; // id of the item this one corrected
  createdBy: string;
  uses: number;
  lastUsedAt?: number;
}

export interface KnowledgeQuery {
  text: string;
  agentId?: string; // limits to what this agent may see (global + its space + own + its chats)
  conversationId?: string;
  /** The memory folders searched, as the caller names them ("company", "memory/company/kunden"); '' or "memory" = the whole tree. Overrides agentId's folders. */
  folders?: string[];
  scopes?: KnowledgeScope[];
  kinds?: KnowledgeKind[];
  at?: number; // validity time, default now
  includeExpired?: boolean;
  limit?: number;
  /** B-044: only items saved before this time (Settings › Knowledge "Older than"). */
  before?: number;
}

/** Filter of the paged knowledge list (current rows only, newest first). */
export interface KnowledgeListFilter {
  scope?: string;
  scopeId?: string;
  kind?: string;
  pinned?: boolean; // true = only pinned items, false = only unpinned ones
  limit?: number;
  offset?: number;
  /** B-044: only items saved before this time (Settings › Knowledge "Older than"). */
  before?: number;
}

export interface KnowledgeHit {
  item: KnowledgeItem;
  score: number;
  why: string; // short reason ("matches 'YouTube upload' · 3 weeks old")
  /** B-044 (knowledge.search rank: true, runtime/find/rank-hits.ts): the decision model that put this hit first – its display name. */
  rankedBy?: string;
}

/** A skill in the agentskills.io format (SKILL.md with name + description front matter). */
export interface SkillInfo {
  name: string; // lowercase-hyphen, matches folder
  description: string; // what + when (shown in the skills index)
  source: 'builtin' | 'user' | 'agent';
  ownerAgentId?: string; // for agent-authored skills
  path: string; // absolute folder path
  modes: string[]; // modes that load it by default
  updatedAt: number;
  /** Wave 3: one of its owner agent's Main Skills (<data>/agents/<id>/skills, shared/model/agent-core.ts). */
  main?: true;
  /** B-066: `metadata.always: true` – name and description stand in every prompt its route reaches. */
  always?: true;
}

/** A mode: declarative bundle that turns an agent into a specialist for one kind of work. */
export interface ModeInfo {
  key: string; // general, manager, video, web, computer, browser, research, writing, social, secretary, harness …
  name: string;
  description: string;
  skills: string[];
  tools: string[]; // tool name patterns allowed in this mode ('*' = all)
  category: string; // routing task category, e.g. 'video-animation'
  workspace?: 'video' | 'web' | 'computer' | 'browser' | 'docs';
  verifier?: string; // rubric used to verify task completion in this mode
  minTier?: 'any' | 'strong' | 'frontier'; // e.g. harness changes need frontier models
  instructions: string; // mode prompt section
}

/** Portable checkpoint handed between agents/modes (no opaque reasoning). */
export interface Handoff {
  goal: string;
  verified: string[]; // what is done and how it was verified
  open: string[]; // what remains
  next: string; // the next concrete step
  artifacts: Array<{ label: string; ref: string }>;
  constraints?: string[];
}

/**
 * Addition (O4): merged into ModeInfo above – the tier a mode prefers. Routing keeps automatic
 * choices at or above it while such a model can run and otherwise falls back to the best model
 * left, noting 'below qualified tier'; `minTier` stays the hard limit (e.g. harness, video).
 */
export interface ModeInfo {
  qualifiedTier?: 'strong' | 'frontier';
}

/**
 * Addition (CTX8): merged into ModeInfo above – where a mode comes from. 'builtin' = shipped
 * (<resources>/modes); 'user' = <data>/modes, saved by the person or an agent (modes.save).
 * A user mode replaces the built-in mode of the same key (`overrides`). Absent = built-in.
 */
export interface ModeInfo {
  source?: 'builtin' | 'user';
  overrides?: boolean;
}

/**
 * Addition (CTX8): what modes.save stores as <data>/modes/<key>.md. Fields left out keep the
 * values of the mode saved under `key` – or of `from` when given (a copy) – else the defaults; ''
 * clears workspace, verifier and qualifiedTier. A new mode needs a description and instructions.
 */
export interface ModeSaveInput {
  key: string;
  from?: string;
  name?: string;
  description?: string;
  instructions?: string;
  skills?: string[];
  tools?: string[];
  category?: string;
  workspace?: NonNullable<ModeInfo['workspace']> | '';
  verifier?: string;
  minTier?: NonNullable<ModeInfo['minTier']>;
  qualifiedTier?: NonNullable<ModeInfo['qualifiedTier']> | '';
}

/** Addition (CTX8): the saved mode and the skills it names that no skill folder provides (saved anyway). */
export interface ModeSaveResult {
  mode: ModeInfo;
  unknownSkills: string[];
}

/** Addition (CTX5, merged here by CTX3): `kinds` narrows the list to several kinds (the knowledge browser hides observations). */
export interface KnowledgeListFilter {
  kinds?: readonly string[];
}

/**
 * Addition (CTX3): merged into KnowledgeQuery above – `mode` keeps, of the modes' knowledge areas,
 * only that mode's ('' keeps none); other scopes are not affected. Absent = every area the ACL admits.
 */
export interface KnowledgeQuery {
  mode?: string;
}
