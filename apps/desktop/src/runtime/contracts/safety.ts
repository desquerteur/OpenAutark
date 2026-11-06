// Runtime service contracts: money, secrets, tools, MCP, files, devices, notifications, run journal. Re-exported by ../contracts.ts (import from there).
// A notification channel gets the notification's id, the same on every one of the owner's PCs that pushes it.
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { ToolContext, ToolDef, ToolOutput, ToolSpec } from '../tools/types.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { SecretGroup, SecretGroupInput, SecretGroupSaved, SecretInfo } from '../../shared/model/security.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { Run, RunItem } from '../../shared/model/runs.ts';
import type { FileRef } from '../../shared/model/system.ts';

// ------------------------------------------------------------------ money

/** The cost journal (spend/ledger.ts): model cost and other bookings, read for display only (spend.list). */
export interface SpendLedger {
  record(input: { agentId: string; amount: number; currency: string; kind: 'tokens' | 'purchase' | 'subscription' | 'ads' | 'other'; ref?: string }): void;
}

export interface SecretService {
  list(): SecretInfo[];
  /**
   * X05: `groupId` + `field` add a field to a group. Every secret is for every agent.
   * `description` is the secret's purpose; `createdBy` the agent that stores a new one (browser.save_secret,
   * secrets.save, secrets.generate) – absent for the person's. `source` (29.10.2026): the site or tool the value came
   * from – provenance only, never a restriction; kept on edits. Owner 29.10.2026 (a catalog like a skill): `route`
   * the catalog area (absent: kept, or chosen automatically – autoSecretRoute), `tags` usage tags (information only).
   * There is no site restriction of any kind: nobody – neither the app nor the person – ties a secret to sites.
   */
  save(input: { id?: string; label: string; kind: SecretInfo['kind']; value?: string; hint?: string; groupId?: string; field?: string; description?: string; conversationId?: string; createdBy?: string; source?: string; route?: string; tags?: string[] }): Promise<SecretInfo>;
  remove(id: string): void;
  /**
   * Decrypts for in-process use by a tool at the last moment; never logged. Owner 29.10.2026: a secret works everywhere – any site, command, header or app; `domain` (where it
   * goes) is recorded in the log for the person, never judged. A 2FA key gives its current code.
   */
  use(id: string, agentId: string, domain?: string): Promise<string>;
  /**
   * PM6: a new random password for one agent, saved from the site's registrable domain (its source, no binding – 29.10.2026). X05: `username` creates the agent's own login, `groupId` fills
   * a login (`replace` an existing password or username).
   */
  generate(input: { label: string; agentId: string; site?: string; length?: number; symbols?: boolean; username?: string; groupId?: string; replace?: boolean }): Promise<SecretInfo>;
  /** Replaces any known secret value in text with its handle (`secret://<id>`). */
  redact(text: string): string;
  // --- X05: grouped secrets (logins, cards) – metadata only; each field keeps its own handle
  groups(): SecretGroup[];
  /** Checks every field (names, kinds, 2FA key) before anything is written; an empty value keeps the stored one. `createdBy`: the agent creating a new group (never from an RPC). */
  saveGroup(input: SecretGroupInput, options?: { createdBy?: string }): Promise<SecretGroupSaved>;
  removeGroup(id: string): void;
  /**
   * 29.10.2026: the ids of stored secrets `agentId` may use whose value is exactly `value` (not a 2FA key; any
   * length) – the duplicate check of browser.save_secret. Never returns or logs a value. Optional so simple fakes stay valid.
   */
  holding?(value: string, agentId: string): Promise<string[]>;
  /**
   * 29.10.2026 (password import): the stored logins as keyed prints of username and password (an HMAC with a key that
   * lives only in this process) and `print` to compare an imported value – no value leaves the vault. Optional so simple fakes stay valid.
   */
  /** values: the print of every stored value that is not a 2FA key (one decrypt pass; a .env import's duplicate check, B-072). */
  loginPrints?(): Promise<{ print: (value: string) => string; logins: Array<{ id: string; source?: string; username?: string; password?: string }>; values?: ReadonlySet<string> }>;
  /** B-044: hears the id of every entry whose metadata changed or went (the metadata files); optional so simple fakes stay valid. */
  observe?(listener: (id: string) => void): () => void;
}

// ------------------------------------------------------------------ tools, files, devices, notifications

export interface ToolRegistry {
  register(tool: ToolDef): void;
  /** B-052 (addition; optional so simple fakes stay valid): removes a registered tool (a connected app's, when its
   *  tool list changes or the app is removed). Unknown names are ignored. */
  unregister?(name: string): void;
  /** Tools offered to this agent in this mode (deterministic order for prompt caching). */
  /** `engine` (addition): filters `audience` – 'http' tools only without own tools, 'mcp' only via the hub. */
  specsFor(agent: Agent, mode: ModeInfo, engine?: { ownTools: boolean; via: 'mcp' | 'native' }): ToolSpec[];
  /**
   * B-049 F4 (addition; optional so simple fakes stay valid – callers then offer specsFor): what an engine is
   * offered directly – the mode's core set (tools/core-sets.ts), the `learned` tools and tools.find / tools.call –
   * out of specsFor (same order). Everything else in specsFor stays reachable through tools.call.
   */
  offerFor?(agent: Agent, mode: ModeInfo, engine: { ownTools: boolean; via: 'mcp' | 'native' }, learned?: readonly string[]): ToolSpec[];
  get(name: string): ToolDef | undefined;
  /** Validates args, executes (locally or on a device), journals the call. */
  call(name: string, args: unknown, ctx: Omit<ToolContext, 'services'>, callId: string): Promise<ToolOutput>;
}

export interface McpHub {
  /** URL + bearer token for an agent run (lease); the token encodes the run context. */
  lease(ctx: Omit<ToolContext, 'services' | 'signal' | 'status'>): { url: string; token: string; release(): void };
  url(): string;
  // --- additions (R3-D); optional so simple fakes stay valid
  /** One HTTP POST to `/mcp/<token>` or `/mcp` (Bearer header); the HTTP server sends the reply. */
  handle?(token: string | undefined, body: unknown, headers?: Record<string, string | undefined>): Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
  /** Shutdown: aborts in-flight calls and forgets all leases. */
  close?(): void;
}

export interface FileStore {
  put(data: Uint8Array, name: string, mime?: string): Promise<FileRef>;
  /** `mime` (addition R3): the client's type hint, used like put()'s when sniffing finds nothing. */
  putPath(path: string, mime?: string): Promise<FileRef>;
  get(id: string): FileRef | undefined;
  path(id: string): string; // absolute path of the blob
  read(id: string): Promise<Uint8Array>;
  /** Extracted text (pdf/text), cached. */
  text(id: string, maxChars?: number): Promise<string | undefined>;
}

export interface DeviceService {
  self(): Device;
  list(): Device[];
  /** Calls a method on a linked device's runtime (tools, engines). */
  call(deviceId: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  online(deviceId: string): boolean;
}

export interface NotificationInput {
  kind: 'todo' | 'blocker' | 'important' | 'done' | 'reply' | 'info';
  title: string;
  body: string;
  conversationId?: string;
  taskId?: string;
}

/** Extra push channel (e.g. web push); called only for notifications that passed the settings filter (here or on another
 * of the owner's PCs). `id` stays the same across PCs; deduplication is per service-worker origin, not across PCs. */
export type NotificationChannel = (input: NotificationInput & { id: string; silent: boolean; tag?: string }) => void | Promise<void>;

export interface NotificationService {
  notify(input: NotificationInput): void;
  /** Registers an extra push channel (web push …); returns a function that removes it.
   * Optional so simple fakes stay valid; the shipped implementation (notify/service.ts) has it. */
  addChannel?(channel: NotificationChannel): () => void;
}

export interface RunJournal {
  start(run: Omit<Run, 'status' | 'startedAt'>): Run;
  item(runId: string, item: Omit<RunItem, 'id' | 'runId' | 'seq' | 'createdAt'>): RunItem;
  /** `data` merges into the item's data: fields given again win, fields not named are kept (the registry's settle update keeps `category`/`raised`). */
  updateItem(id: string, patch: Partial<Pick<RunItem, 'data' | 'effectStatus'>>): void;
  finish(runId: string, patch: Partial<Run>): Run;
  get(runId: string): Run | undefined;
  list(agentId: string, limit?: number): Run[];
  items(runId: string): RunItem[];
  /** Mark runs left 'running' by a crash as interrupted; effects pending → unknown. */
  /** RC1: `runIds` = the runs this call interrupted plus the runs a graceful stop cut off (runs/journal.ts recordShutdownRuns); their unknown effects go into the recovery notes. `interrupted` counts the crash runs only. */
  reconcile(): { interrupted: number; unknownEffects: number; runIds: string[] };
}
