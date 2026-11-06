// The connector files in <data>/connectors/ – the whole configuration of connected apps, edited by the AI (skill
// connect-apps) or the person:
//   mcp.json   {"mcpServers": {"<name>": {"url": "https://…", "headers": {…}} | {"command": "npx", "args": […], "env": {…}, "cwd": "…"}}}
//              – the map Claude Code and Cursor use; "disabled": true turns one off.
//   mail.json  {"mailboxes": {"<name>": {"address": "me@x.com", "password": "secret://<id>", "agent": "<agent id or name>",
//              "user"?, "imap"?: {"host", "port", "tls": "implicit"|"starttls"}, "smtp"?: {…}, "disabled"?: true}}}
// Any value may hold secret://<id> handles of the secrets catalog (resolved only when it connects; a plain value works
// too). status.json is written by the runtime: each connector's state, tool count, error and open sign-in page.
// migrateRecords() turns the records of the old Settings › Apps (kv 'apps', keys 'app:<id>') into these files once.
// Owns: reading, checking and writing these files, the id a key gets. Never: resolves a handle, logs a value.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ID_MAX, APP_ID_PATTERN, type ConnectedApp, type MailServer } from '../../shared/model/apps.ts';
import type { AppKv, Connector } from './types.ts';

export const CONNECTORS_DIR = 'connectors';
export const MCP_FILE = 'mcp.json';
export const MAIL_FILE = 'mail.json';
export const STATUS_FILE = 'status.json';
/** Ids a connector never gets: they would read as the runtime's own tools. */
const RESERVED: ReadonlySet<string> = new Set(['workforce', 'apps', 'app']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const strings = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const out = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return Object.keys(out).length ? out : undefined;
};

export const connectorsDir = (dataDir: string) => path.join(dataDir, CONNECTORS_DIR);

/** Lower-case [a-z0-9-], starting with a letter, at most APP_ID_MAX characters ('app' when nothing is left). */
export function slug(name: string): string {
  let out = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) return 'app';
  if (!/^[a-z]/.test(out)) out = `app-${out}`;
  return out.slice(0, APP_ID_MAX).replace(/-+$/, '');
}

/** A free id for `name` (its slug, else with -2, -3 …). */
function freeId(name: string, taken: Set<string>): string {
  const base = slug(name);
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `${base.slice(0, APP_ID_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!RESERVED.has(id) && !taken.has(id) && APP_ID_PATTERN.test(id)) { taken.add(id); return id; }
  }
  return `app-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

function server(value: unknown): MailServer | undefined {
  if (!isRecord(value) || !text(value.host)) return undefined;
  const port = Number(value.port);
  const tls = value.tls === 'starttls' ? 'starttls' : 'implicit';
  return { host: text(value.host)!, port: Number.isInteger(port) && port > 0 ? port : tls === 'starttls' ? 587 : 993, tls };
}

/** Reads one JSON file of the folder: its object, undefined when it does not exist, or the problem. */
function readJson(file: string): { value?: Record<string, unknown>; problem?: string } {
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '') || '{}');
    return isRecord(value) ? { value } : { problem: `${path.basename(file)}: the top level must be an object.` };
  } catch (error) {
    return { problem: `${path.basename(file)}: ${error instanceof Error ? error.message.slice(0, 200) : 'not valid JSON'}` };
  }
}

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** Every connector the two files name (keys in file order, mcp.json first), and the problems found. */
export function readConnectors(dataDir: string): { connectors: Connector[]; problems: string[] } {
  const dir = connectorsDir(dataDir);
  const problems: string[] = [];
  const connectors: Connector[] = [];
  const taken = new Set<string>();
  const mcp = readJson(path.join(dir, MCP_FILE));
  if (mcp.problem) problems.push(mcp.problem);
  const servers = mcp.value?.mcpServers ?? {};
  if (!isRecord(servers)) problems.push(`${MCP_FILE}: "mcpServers" must be an object.`);
  else {
    for (const [name, raw] of Object.entries(servers)) {
      if (!isRecord(raw)) { problems.push(`${MCP_FILE}: "${name}" must be an object.`); continue; }
      const base = { name, enabled: raw.disabled !== true && raw.enabled !== false, fingerprint: fingerprint(raw) };
      const url = text(raw.url) ?? text(raw.serverUrl);
      const command = text(raw.command);
      if (url) connectors.push({ ...base, id: freeId(name, taken), transport: 'http', url, ...(strings(raw.headers) ? { headers: strings(raw.headers) } : {}) });
      else if (command) {
        const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : [];
        connectors.push({ ...base, id: freeId(name, taken), transport: 'stdio', command, args, ...(text(raw.cwd) ? { cwd: text(raw.cwd) } : {}), ...(strings(raw.env) ? { env: strings(raw.env) } : {}) });
      } else problems.push(`${MCP_FILE}: "${name}" needs "url" or "command".`);
    }
  }
  const mail = readJson(path.join(dir, MAIL_FILE));
  if (mail.problem) problems.push(mail.problem);
  const boxes = mail.value?.mailboxes ?? {};
  if (!isRecord(boxes)) problems.push(`${MAIL_FILE}: "mailboxes" must be an object.`);
  else {
    for (const [name, raw] of Object.entries(boxes)) {
      if (!isRecord(raw)) { problems.push(`${MAIL_FILE}: "${name}" must be an object.`); continue; }
      const address = text(raw.address);
      const password = text(raw.password);
      if (!address || !address.includes('@') || !password) { problems.push(`${MAIL_FILE}: "${name}" needs "address" and "password".`); continue; }
      const imap = server(raw.imap);
      const smtp = server(raw.smtp);
      connectors.push({
        id: freeId(name, taken), name, transport: 'mail', enabled: raw.disabled !== true && raw.enabled !== false, fingerprint: fingerprint(raw),
        mail: { address, password, ...(text(raw.user) ? { user: text(raw.user) } : {}), ...(imap ? { imap } : {}), ...(smtp ? { smtp } : {}), ...(text(raw.agent) ? { agent: text(raw.agent) } : {}) },
      });
    }
  }
  return { connectors, problems };
}

/** Writes `content` through a temporary file (an editor never sees half a file). */
function writeFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** Creates the folder and the two files when they are missing (so the AI finds them). */
export function ensureFiles(dataDir: string): void {
  const dir = connectorsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(dir, MCP_FILE))) writeFile(path.join(dir, MCP_FILE), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  if (!existsSync(path.join(dir, MAIL_FILE))) writeFile(path.join(dir, MAIL_FILE), `${JSON.stringify({ mailboxes: {} }, null, 2)}\n`);
}

/** status.json: what the AI reads after a change (written by the runtime only). */
export function writeStatus(dataDir: string, apps: readonly ConnectedApp[], problems: readonly string[], now: number): void {
  const connectors = Object.fromEntries(apps.map((app) => [app.name, {
    id: app.id, type: app.transport === 'mail' ? 'mail' : 'mcp', status: app.status, tools: app.tools,
    ...(app.error ? { error: app.error } : {}), ...(app.signInUrl ? { signInUrl: app.signInUrl } : {}),
    ...(app.toolNames.length ? { toolNames: app.toolNames } : {}),
  }]));
  const body = { note: 'Written by the app – edit mcp.json / mail.json instead.', updatedAt: new Date(now).toISOString(), ...(problems.length ? { problems } : {}), connectors };
  try { writeFile(path.join(connectorsDir(dataDir), STATUS_FILE), `${JSON.stringify(body, null, 2)}\n`); } catch { /* the next change writes it again */ }
}

// ------------------------------------------------------------------ one-time move of the old Settings › Apps records

interface OldRecord {
  id?: unknown; name?: unknown; transport?: unknown; url?: unknown; command?: unknown; args?: unknown; cwd?: unknown; enabled?: unknown;
  env?: Record<string, unknown>; headers?: Record<string, unknown>; token?: { secretId?: unknown; header?: unknown };
  mail?: { address?: unknown; user?: unknown; imap?: unknown; smtp?: unknown; agentId?: unknown };
  tools?: unknown;
}

const handle = (ref: unknown): string | undefined => (isRecord(ref) && typeof ref.secretId === 'string' ? `secret://${ref.secretId}` : undefined);

/**
 * Moves the old records (kv 'app:<id>') into mcp.json / mail.json – only when neither file exists yet – and keeps
 * their tool lists as the cache ('tools:<id>'); REST APIs (no longer a connector kind) are left out. Returns how many moved.
 */
export function migrateRecords(dataDir: string, kv: AppKv): number {
  const dir = connectorsDir(dataDir);
  const keys = kv.keys('app:');
  if (!keys.length || existsSync(path.join(dir, MCP_FILE)) || existsSync(path.join(dir, MAIL_FILE))) return 0;
  const servers: Record<string, unknown> = {};
  const mailboxes: Record<string, unknown> = {};
  let moved = 0;
  for (const key of keys) {
    const record = kv.get<OldRecord>(key);
    if (!record || typeof record.name !== 'string') continue;
    const name = record.name;
    const off = record.enabled === false ? { disabled: true } : {};
    const token = record.token && typeof record.token.secretId === 'string' ? { header: String(record.token.header ?? 'Authorization'), value: `secret://${record.token.secretId}` } : undefined;
    let entry: Record<string, unknown> | undefined;
    if (record.transport === 'http' && typeof record.url === 'string') {
      const headers: Record<string, string> = {};
      for (const [header, ref] of Object.entries(record.headers ?? {})) { const value = handle(ref); if (value) headers[header] = value; }
      if (token) headers[token.header] = token.value;
      entry = { url: record.url, ...(Object.keys(headers).length ? { headers } : {}), ...off };
      servers[name] = entry;
    } else if (record.transport === 'stdio' && typeof record.command === 'string') {
      const env: Record<string, string> = {};
      for (const [variable, value] of Object.entries(record.env ?? {})) { const plain = typeof value === 'string' ? value : handle(value); if (plain) env[variable] = plain; }
      entry = { command: record.command, args: Array.isArray(record.args) ? record.args : [], ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}), ...(Object.keys(env).length ? { env } : {}), ...off };
      servers[name] = entry;
    } else if (record.transport === 'mail' && record.mail && typeof record.mail.address === 'string' && token) {
      entry = {
        address: record.mail.address, password: token.value, ...(typeof record.mail.user === 'string' ? { user: record.mail.user } : {}),
        ...(isRecord(record.mail.imap) ? { imap: record.mail.imap } : {}), ...(isRecord(record.mail.smtp) ? { smtp: record.mail.smtp } : {}),
        ...(typeof record.mail.agentId === 'string' ? { agent: record.mail.agentId } : {}), ...off,
      };
      mailboxes[name] = entry;
    }
    if (!entry) continue;
    if (typeof record.id === 'string' && Array.isArray(record.tools)) kv.set(`tools:${record.id}`, { fingerprint: fingerprint(entry), tools: record.tools });
    kv.delete(key);
    moved += 1;
  }
  writeFile(path.join(dir, MCP_FILE), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  writeFile(path.join(dir, MAIL_FILE), `${JSON.stringify({ mailboxes }, null, 2)}\n`);
  return moved;
}
