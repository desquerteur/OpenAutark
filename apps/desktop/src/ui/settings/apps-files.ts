// Settings › Apps writes what the AI writes: one entry of <data>/connectors/mcp.json or mail.json (skill connect-apps). The
// runtime's watcher applies the change within a second; `apps.changed` brings the rows up to date. A key or password goes into
// the secrets catalog first and the file holds only its handle secret://<id>. Everything else in the file stays as it is.
// Owns: the pure edits of those two files, the entries the forms make, a row's words, and the one read-edit-write through files.*.
// Never: holds a value after handing it to secrets.save, writes a key into a file, or connects anything itself (the runtime does).

import type { AppStatus, ConnectedApp, MailServer } from '../../shared/model/apps.ts';
import { rpc } from '../lib/rpc.ts';

export type ConnectorFile = 'mcp.json' | 'mail.json';
type Json = Record<string, unknown>;

const SECTION: Readonly<Record<ConnectorFile, string>> = { 'mcp.json': 'mcpServers', 'mail.json': 'mailboxes' };

export const fileOf = (app: Pick<ConnectedApp, 'transport'>): ConnectorFile => (app.transport === 'mail' ? 'mail.json' : 'mcp.json');

const STATUS: Readonly<Record<AppStatus, string>> = { ok: 'Connected', connecting: 'Connecting…', waiting: 'Waiting for the sign-in in your browser', signin: 'Needs a sign-in', error: 'Not connected', off: 'Off' };
export const toolCount = (tools: number): string => `${tools} ${tools === 1 ? 'tool' : 'tools'}`;

/** The app's one line: its address, its state or why not, its tools. */
export function appLine(app: Pick<ConnectedApp, 'address' | 'status' | 'error' | 'tools'>): string {
  const state = app.status === 'ok' ? toolCount(app.tools) : app.error || STATUS[app.status];
  return [app.address, state].filter(Boolean).join(' · ');
}

/** The one action of the row's cell by its status: Test, Connect again, the open sign-in page; none while off; `wait` runs nothing new while it connects. */
export function appAction(app: Pick<ConnectedApp, 'status' | 'signInUrl'>): { kind: 'test' | 'connect' | 'page'; label: string; wait?: true } | undefined {
  switch (app.status) {
    case 'ok': return { kind: 'test', label: 'Test' };
    case 'signin': case 'error': return { kind: 'connect', label: 'Connect again' };
    case 'waiting': return app.signInUrl ? { kind: 'page', label: 'Sign-in page' } : { kind: 'connect', label: 'Connect again' };
    case 'connecting': return { kind: 'test', label: 'Test', wait: true };
    default: return undefined;
  }
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The file's object and its section; a file that is broken stays untouched (the error names it). */
function parsed(file: ConnectorFile, text: string): { root: Json; entries: Json } {
  let root: unknown;
  try { root = JSON.parse(text.replace(/^﻿/, '') || '{}'); } catch { throw new Error(`${file} is not valid JSON. Open it and fix it first.`); }
  if (!isRecord(root)) throw new Error(`${file} must hold an object. Open it and fix it first.`);
  const entries = root[SECTION[file]] ?? {};
  if (!isRecord(entries)) throw new Error(`"${SECTION[file]}" in ${file} must be an object. Open it and fix it first.`);
  return { root, entries };
}

const written = (file: ConnectorFile, root: Json, entries: Json): string => `${JSON.stringify({ ...root, [SECTION[file]]: entries }, null, 2)}\n`;

/** A key not in use yet: `name`, else "name 2", "name 3" … (a new entry never replaces one). */
export function freeKey(name: string, entries: Json): string {
  if (!Object.hasOwn(entries, name)) return name;
  for (let n = 2; ; n += 1) if (!Object.hasOwn(entries, `${name} ${n}`)) return `${name} ${n}`;
}

/** The file with a new entry `name` (made free). */
export function withEntry(file: ConnectorFile, text: string, name: string, entry: Json): string {
  const { root, entries } = parsed(file, text);
  return written(file, root, { ...entries, [freeKey(name, entries)]: entry });
}

/** The file without the entry `name`. */
export function withoutEntry(file: ConnectorFile, text: string, name: string): string {
  const { root, entries } = parsed(file, text);
  const { [name]: _gone, ...rest } = entries;
  return written(file, root, rest);
}

/** The entry `name` changed by `patch`; a key set to undefined leaves it. */
export function patchedEntry(file: ConnectorFile, text: string, name: string, patch: Json): string {
  const { root, entries } = parsed(file, text);
  const entry = entries[name];
  if (!isRecord(entry)) throw new Error(`"${name}" is no longer in ${file}.`);
  return written(file, root, { ...entries, [name]: { ...entry, ...patch } });
}

/** On or off: the keys the runtime reads ("disabled": true; an "enabled" of another tool goes). */
export const switchPatch = (on: boolean): Json => ({ disabled: on ? undefined : true, enabled: undefined });

/** An HTTP header that carries a token by its handle. */
export const tokenHeaders = (secretId: string): Json => ({ Authorization: `Bearer secret://${secretId}` });

/** The entry `name` with this token; its other headers stay, the one it replaces is any spelling of Authorization. */
export function withToken(file: ConnectorFile, text: string, name: string, secretId: string): string {
  const headers = parsed(file, text).entries[name];
  const now = isRecord(headers) && isRecord(headers.headers) ? headers.headers : {};
  const kept = Object.fromEntries(Object.entries(now).filter(([header]) => header.toLowerCase() !== 'authorization'));
  return patchedEntry(file, text, name, { headers: { ...kept, ...tokenHeaders(secretId) } });
}

/** One command line as program and arguments ("quoted parts" stay together). */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = (line.match(/"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^"|"$/g, ''));
  return { command: parts[0] ?? '', args: parts.slice(1) };
}

/** A name for an address without one: its host, or the program's name. */
export function nameFromAddress(address: string): string {
  const host = /^https?:\/\/([^/:?#]+)/i.exec(address)?.[1];
  if (host) return host.replace(/^(www|mcp|api)\./, '').split('.')[0] || host;
  return address.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1|com)$/i, '') || 'app';
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^[a-z0-9.-]+$/i;

/** A server from host and port ('' port: `fallback`); TLS follows the port (143/587/25/2525: STARTTLS). */
function mailServer(host: string, port: string, fallback: number): MailServer | string {
  const name = host.trim();
  if (!name) return 'Enter both servers, or leave them all empty';
  if (!HOST.test(name)) return 'A server is a host name like imap.example.com';
  const number = port.trim() ? Number(port.trim()) : fallback;
  if (!Number.isInteger(number) || number < 1 || number > 65535) return 'A port is a number from 1 to 65535';
  return { host: name, port: number, tls: [143, 587, 25, 2525].includes(number) ? 'starttls' : 'implicit' };
}

export interface MailFields { address: string; password: string; imapHost: string; imapPort: string; smtpHost: string; smtpPort: string }

/** Why the mailbox form cannot save yet ('' = it can), and the entry without its password. */
export function mailEntry(fields: MailFields): { blocked: string; entry?: Json } {
  const address = fields.address.trim();
  if (!address || !ADDRESS.test(address)) return { blocked: 'Enter an email address like name@example.com' };
  if (!fields.password) return { blocked: 'Enter the password' };
  if (!`${fields.imapHost}${fields.imapPort}${fields.smtpHost}${fields.smtpPort}`.trim()) return { blocked: '', entry: { address } };
  const imap = mailServer(fields.imapHost, fields.imapPort, 993);
  if (typeof imap === 'string') return { blocked: imap };
  const smtp = mailServer(fields.smtpHost, fields.smtpPort, 465);
  if (typeof smtp === 'string') return { blocked: smtp };
  return { blocked: '', entry: { address, imap, smtp } };
}

/** A key into the catalog; the file gets its handle. */
export async function storeKey(label: string, kind: 'token' | 'password', value: string, description: string): Promise<string> {
  return (await rpc.call('secrets.save', { label, kind, value, description })).id;
}

/** Reads the file, applies `change` to its text and writes it back, unless someone changed it in between (a conflict the caller shows). */
export async function editConnectors(file: ConnectorFile, change: (text: string) => string): Promise<void> {
  const root = (await rpc.call('system.root')).path;
  const slash = root.includes('\\') ? '\\' : '/';
  const path = `${root}${slash}connectors${slash}${file}`;
  const now = await rpc.call('files.readPath', { path });
  if (now.state !== 'text' && now.state !== 'missing') throw new Error(`${file} cannot be read as text.`);
  await rpc.call('files.writePath', { path, text: change(now.text ?? ''), ...(now.stamp ? { base: now.stamp } : {}) });
}
