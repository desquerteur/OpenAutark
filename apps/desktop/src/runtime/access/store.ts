// AF-013: where access is kept. An agent's mode and rules: <data>/agents/<id>/access.json (next to SYSTEM.md and
// agent.json – a plain file the person or an AI with full access may edit; read again when its mtime or size changed;
// an unusable file counts as missing, so the agent keeps full access as before AF-013). A chat's mode: the kv table
// (namespace 'access.chat'). A run's mode: memory only (a run lives in this runtime). Without a data folder (tests)
// the agents' access lives in memory too.
// Owns: the file's form, its checks (normalizeAccess) and these three places. Never: judges or asks.

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ACCESS_MODES, type AccessChoice, type AccessMode, type AccessRules, type AgentAccess } from '../../shared/model/access.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { agentFolder, isCoreFolderName } from '../agent-core/layout.ts';
import { signature, writeAtomic } from '../root/text-doc.ts';

export const ACCESS_FILE = 'access.json';
const FORMAT = 'autark-access';
const MAX_ENTRIES = 200;
const MAX_ENTRY = 500;
const MAX_BYTES = 256 * 1024;
const RUNS_KEPT = 500;
const CHAT_NS = 'access.chat';

export interface AccessKv {
  get<T>(ns: string, key: string): T | undefined;
  set(ns: string, key: string, value: unknown, at: number): void;
  delete(ns: string, key: string): boolean;
}

export interface AccessStoreDeps {
  /** <data>; absent: agents' access in memory. */
  dataDir?: string;
  kv?: AccessKv;
  now: () => number;
}

export const isMode = (value: unknown): value is AccessMode => typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value);
const isChoice = (value: unknown): value is AccessChoice => value === 'allow' || value === 'ask' || value === 'deny';

function list(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new WorkforceError('bad_request', `${field}: a list of texts.`);
  const out = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > MAX_ENTRY || /[\u0000-\u001f]/.test(entry)) throw new WorkforceError('bad_request', `${field}: each entry one line of at most ${MAX_ENTRY} characters.`);
    return entry.trim();
  });
  if (out.length > MAX_ENTRIES) throw new WorkforceError('bad_request', `${field}: at most ${MAX_ENTRIES} entries.`);
  return out.length ? [...new Set(out)] : undefined;
}

function pair(value: unknown, field: string, keys: readonly [string, string]): Record<string, string[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new WorkforceError('bad_request', `${field}: an object with ${keys.join(' and ')}.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new WorkforceError('bad_request', `${field}: unknown key "${key.slice(0, 40)}".`);
  const out: Record<string, string[]> = {};
  for (const key of keys) { const entries = list(record[key], `${field}.${key}`); if (entries) out[key] = entries; }
  return Object.keys(out).length ? out : undefined;
}

/** Checked rules (throws 'bad_request' naming the field); empty parts are dropped. */
export function normalizeRules(value: unknown): AccessRules {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new WorkforceError('bad_request', 'rules: an object.');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!['folders', 'commands', 'network', 'tools', 'money'].includes(key)) throw new WorkforceError('bad_request', `rules: unknown key "${key.slice(0, 40)}".`);
  const rules: AccessRules = {};
  const folders = pair(raw.folders, 'rules.folders', ['write', 'deny']);
  if (folders) {
    for (const entry of [...(folders.write ?? []), ...(folders.deny ?? [])]) if (!path.isAbsolute(entry)) throw new WorkforceError('bad_request', `rules.folders: "${entry.slice(0, 80)}" is not an absolute folder.`);
    rules.folders = folders;
  }
  const commands = pair(raw.commands, 'rules.commands', ['allow', 'deny']);
  if (commands) rules.commands = commands;
  const tools = pair(raw.tools, 'rules.tools', ['allow', 'deny']);
  if (tools) rules.tools = tools;
  for (const key of ['network', 'money'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!isChoice(raw[key])) throw new WorkforceError('bad_request', `rules.${key}: allow, ask or deny.`);
    rules[key] = raw[key];
  }
  return rules;
}

/** A stored access, checked; undefined when it is not usable. */
export function normalizeAccess(value: unknown): AgentAccess | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isMode(raw.mode)) return undefined;
  try { return { mode: raw.mode, rules: normalizeRules(raw.rules) }; } catch { return undefined; }
}

/** The file's text: a readable note, the mode, the rules. */
export function accessText(access: AgentAccess): string {
  return `${JSON.stringify({
    format: FORMAT, version: 1,
    about: 'What this agent may do on this PC. mode: read | ask | project | full. Without this file the agent has full access.',
    mode: access.mode, rules: access.rules,
  }, null, 2)}\n`;
}

export class AccessStore {
  private readonly deps: AccessStoreDeps;
  private readonly reads = new Map<string, { sig: string; access?: AgentAccess }>();
  private readonly memory = new Map<string, AgentAccess>();
  private readonly chats = new Map<string, AccessMode>();
  private readonly runs = new Map<string, AccessMode>();

  constructor(deps: AccessStoreDeps) {
    this.deps = deps;
  }

  private file(agentId: string): string | undefined {
    if (!this.deps.dataDir || !isCoreFolderName(agentId)) return undefined;
    return path.join(agentFolder(this.deps.dataDir, agentId), ACCESS_FILE);
  }

  /** The agent's stored access (undefined: none – full access, as before AF-013). */
  agent(agentId: string): AgentAccess | undefined {
    const file = this.file(agentId);
    if (!file) return this.memory.get(agentId);
    let sig: string;
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.size > MAX_BYTES) return undefined;
      sig = signature(info);
    } catch { this.reads.delete(agentId); return undefined; }
    const known = this.reads.get(agentId);
    if (known?.sig === sig) return known.access;
    let access: AgentAccess | undefined;
    try { access = normalizeAccess(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))); } catch { access = undefined; }
    this.reads.set(agentId, { sig, access });
    return access;
  }

  setAgent(agentId: string, access: AgentAccess): void {
    const file = this.file(agentId);
    if (!file) { this.memory.set(agentId, access); return; }
    writeAtomic(file, accessText(access));
    this.reads.delete(agentId);
  }

  chatMode(conversationId: string): AccessMode | undefined {
    if (!this.deps.kv) return this.chats.get(conversationId);
    try { const mode = this.deps.kv.get<unknown>(CHAT_NS, conversationId); return isMode(mode) ? mode : undefined; } catch { return undefined; }
  }

  setChatMode(conversationId: string, mode: AccessMode | undefined): void {
    if (!this.deps.kv) { if (mode) this.chats.set(conversationId, mode); else this.chats.delete(conversationId); return; }
    if (mode) this.deps.kv.set(CHAT_NS, conversationId, mode, this.deps.now());
    else this.deps.kv.delete(CHAT_NS, conversationId);
  }

  runMode(runId: string): AccessMode | undefined {
    return this.runs.get(runId);
  }

  setRunMode(runId: string, mode: AccessMode | undefined): void {
    this.runs.delete(runId);
    if (!mode) return;
    if (this.runs.size >= RUNS_KEPT) this.runs.delete(this.runs.keys().next().value!);
    this.runs.set(runId, mode);
  }
}
