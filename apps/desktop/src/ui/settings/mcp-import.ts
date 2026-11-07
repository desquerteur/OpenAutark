// AF-005 Settings › Connectors › "Paste JSON": the MCP server configs people copy from Claude Desktop
// (claude_desktop_config.json), Claude Code (.mcp.json, `claude mcp add-json`), Cursor or VS Code – {"mcpServers": {…}},
// {"servers": {…}}, a bare map of servers, or one server object – checked entry by entry with errors that name the entry
// and the key. A checked server becomes one mcp.json entry; a key in its "env" or "headers" that holds a secret
// (shared/model/key-values.ts isSecretPair; any Authorization header) moves into the secrets catalog and the file gets
// its handle – plain settings (NODE_ENV, a port, a folder) stay as written.
// Owns: reading and checking a pasted config, which values move, and putting handles in. Never: saves a value, calls
// anything or keeps what it read.

import { isSecretPair } from '../../shared/model/key-values.ts';

type Json = Record<string, unknown>;

/** At most this many servers in one paste, and this long a name. */
export const MAX_IMPORT = 50;
export const MAX_NAME = 60;

/** One value that goes into the secrets catalog: `scheme` ("Bearer ") stays in the file in front of the handle. */
export interface SecretMove { where: 'env' | 'headers'; key: string; value: string; scheme: string }

/** One checked server: its key in mcp.json, the entry (moved values still in it until withHandles), what moves, notes. */
export interface ImportedServer { name: string; entry: Json; moves: SecretMove[]; notes: string[]; kind: 'stdio' | 'http' }

export interface ImportCheck { servers: ImportedServer[]; errors: string[] }

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const SCHEME = /^(Bearer|Basic|Token|Bot)\s+(\S.*)$/i;
const TYPES = new Set(['stdio', 'http', 'streamable-http', 'streamablehttp', 'sse']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOOPBACK = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;

/** "line 3, column 5" for a JSON.parse failure, when the engine names a position but no line. */
function jsonError(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : 'not valid JSON';
  const at = /position (\d+)/.exec(message);
  if (!at || /line \d+/i.test(message)) return `Not valid JSON: ${message}`;
  const before = text.slice(0, Number(at[1]));
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  return `Not valid JSON: ${message.replace(/\s*in JSON at position \d+.*$/, '')} (line ${line}, column ${column})`;
}

const looksLikeServer = (value: Json): boolean => typeof value.command === 'string' || typeof value.url === 'string' || typeof value.serverUrl === 'string';

/** A name for a server pasted without one: its host, or the package or program it starts. */
export function nameForServer(raw: Json): string {
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : '';
  const host = /^https?:\/\/([^/:?#]+)/i.exec(url)?.[1];
  if (host) return host.replace(/^(www|mcp|api)\./, '').split('.')[0] || host;
  const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string' && !arg.startsWith('-')) : [];
  const program = typeof raw.command === 'string' ? raw.command.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1|com)$/i, '') : '';
  const runner = /^(npx|bunx|uvx|pnpm|dlx|docker|node|python3?|deno)$/i.test(program);
  const pkg = runner ? args.find((arg) => arg !== 'run' && arg !== 'exec' && arg !== 'dlx') : undefined;
  const base = (pkg ?? program).replace(/@[^@/]*$/, '').split('/').pop() ?? '';
  return base.replace(/^(mcp-server-|server-)|(-mcp-server|-mcp|-server)$/g, '') || 'server';
}

/** The servers of the pasted text, by their names (a paste of one server without a name gets one). */
function serversOf(data: Json): { map?: Json; error?: string } {
  for (const key of ['mcpServers', 'servers']) {
    if (!Object.hasOwn(data, key)) continue;
    return isRecord(data[key]) ? { map: data[key] } : { error: `"${key}" must be an object of servers by name.` };
  }
  if (looksLikeServer(data)) return { map: { [nameForServer(data)]: data } };
  const values = Object.values(data);
  if (values.length && values.every(isRecord)) return { map: data };
  return { error: 'No servers found. Paste {"mcpServers": {"<name>": {"command": "npx", "args": […]}}} as Claude Desktop and Claude Code write it.' };
}

/** Text values of `env` / `headers`, or the error naming the first that is not one. */
function textMap(name: string, key: 'env' | 'headers', value: unknown, errors: string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) { errors.push(`"${name}": "${key}" must be an object of names and texts.`); return undefined; }
  const out: Record<string, string> = {};
  for (const [field, item] of Object.entries(value)) {
    if (typeof item !== 'string') { errors.push(`"${name}": "${key}.${field}" must be text (put it in quotes).`); continue; }
    if (key === 'env' && !ENV_NAME.test(field)) { errors.push(`"${name}": "${field}" is no environment variable name (letters, digits and _).`); continue; }
    if (key === 'headers' && !HEADER_NAME.test(field)) { errors.push(`"${name}": "${field}" is no header name.`); continue; }
    out[field] = item;
  }
  return out;
}

/** The values of `map` that hold a secret and are no handle yet. */
function movesOf(where: 'env' | 'headers', map: Record<string, string> | undefined): SecretMove[] {
  const moves: SecretMove[] = [];
  for (const [key, raw] of Object.entries(map ?? {})) {
    const value = raw.trim();
    if (!value || value.includes('secret://') || /^\$\{[^}]+\}$/.test(value)) continue;
    const auth = where === 'headers' && key.toLowerCase() === 'authorization';
    if (!auth && !isSecretPair({ name: key, value })) continue;
    const scheme = where === 'headers' ? SCHEME.exec(value) : null;
    moves.push({ where, key, value: scheme ? scheme[2].trim() : value, scheme: scheme ? `${scheme[1]} ` : '' });
  }
  return moves;
}

/** One server's checks; undefined when it has errors (they are in `errors`). */
function checkServer(name: string, raw: unknown, errors: string[]): ImportedServer | undefined {
  const before = errors.length;
  if (!name.trim()) { errors.push('A server has an empty name.'); return undefined; }
  if (name.length > MAX_NAME) errors.push(`"${name.slice(0, 30)}…": the name is longer than ${MAX_NAME} characters.`);
  if (!isRecord(raw)) { errors.push(`"${name}": must be an object like {"command": "npx", "args": ["-y", "<package>"]}.`); return undefined; }
  const type = raw.type === undefined ? undefined : typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  if (type !== undefined && !TYPES.has(type)) errors.push(`"${name}": "type" must be "stdio", "http" or "sse".`);
  const url = raw.url ?? raw.serverUrl;
  const stdio = type === 'stdio' || (type === undefined && raw.command !== undefined && url === undefined);
  const notes: string[] = [];
  if (stdio) {
    if (typeof raw.command !== 'string' || !raw.command.trim()) errors.push(`"${name}": "command" must be the program to start, like "npx".`);
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string'))) errors.push(`"${name}": "args" must be a list of texts, like ["-y", "<package>"].`);
    if (raw.cwd !== undefined && typeof raw.cwd !== 'string') errors.push(`"${name}": "cwd" must be a folder path.`);
    if (raw.headers !== undefined) notes.push(`"${name}": "headers" are for web servers – a command gets "env".`);
  } else if (url === undefined) {
    errors.push(`"${name}": needs "command" (a program on this PC) or "url" (a web address).`);
  } else if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url.trim())) {
    errors.push(`"${name}": "url" must be a web address that starts with https://.`);
  } else if (/^http:/i.test(url.trim()) && !LOOPBACK.test(url.trim())) {
    errors.push(`"${name}": "url" must start with https:// (http:// only for this PC, like http://localhost:3000/mcp).`);
  } else if (type === 'sse' || /\/sse\/?$/i.test(url.trim())) {
    notes.push(`"${name}": an SSE address – if it does not connect, the server's Streamable HTTP address (often ending in /mcp) does.`);
  }
  const env = textMap(name, 'env', raw.env, errors);
  const headers = textMap(name, 'headers', raw.headers, errors);
  if (errors.length > before) return undefined;
  const strings = [JSON.stringify(raw.args ?? []), ...Object.values(env ?? {}), ...Object.values(headers ?? {}), typeof url === 'string' ? url : ''];
  const variable = strings.join(' ').match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/)?.[0];
  if (variable) notes.push(`"${name}": ${variable} stays as written – this app fills in no variables; put the value into Secrets and use secret://<id>.`);
  const { type: _type, serverUrl: _serverUrl, ...rest } = raw;
  const entry: Json = stdio
    ? { ...rest, command: String(raw.command).trim(), ...(raw.args ? { args: raw.args } : {}) }
    : { ...rest, url: String(url).trim() };
  if (env) entry.env = env;
  if (headers) entry.headers = headers;
  return { name, entry, moves: [...movesOf('env', env), ...(stdio ? [] : movesOf('headers', headers))], notes, kind: stdio ? 'stdio' : 'http' };
}

/** Reads and checks a pasted config; `errors` empty = every server can go in. */
export function checkImport(text: string): ImportCheck {
  const source = text.replace(/^﻿/, '').trim();
  if (!source) return { servers: [], errors: ['Paste the JSON of one or more MCP servers.'] };
  let data: unknown;
  try { data = JSON.parse(source); } catch (error) { return { servers: [], errors: [jsonError(error, source)] }; }
  if (!isRecord(data)) return { servers: [], errors: ['The JSON must be an object: {"mcpServers": {…}}.'] };
  const found = serversOf(data);
  if (!found.map) return { servers: [], errors: [found.error!] };
  const entries = Object.entries(found.map);
  if (!entries.length) return { servers: [], errors: ['There is no server in it yet.'] };
  if (entries.length > MAX_IMPORT) return { servers: [], errors: [`That is ${entries.length} servers – ${MAX_IMPORT} at most at a time.`] };
  const errors: string[] = [];
  const servers: ImportedServer[] = [];
  for (const [name, raw] of entries) {
    const server = checkServer(name.trim(), raw, errors);
    if (server) servers.push(server);
  }
  return { servers: errors.length ? [] : servers, errors };
}

/** The entry with each moved value replaced by its handle (`ids`: the secret id per "where.key"). */
export function withHandles(server: ImportedServer, ids: ReadonlyMap<string, string>): Json {
  const entry: Json = { ...server.entry };
  for (const where of ['env', 'headers'] as const) {
    const map = isRecord(entry[where]) ? { ...(entry[where] as Record<string, string>) } : undefined;
    if (!map) continue;
    for (const move of server.moves.filter((item) => item.where === where)) {
      const id = ids.get(`${where}.${move.key}`);
      if (id) map[move.key] = `${move.scheme}secret://${id}`;
    }
    entry[where] = map;
  }
  return entry;
}

/** One line per server for the check area: name, what it runs, how many values move into Secrets. */
export function importSummary(check: ImportCheck): string[] {
  return check.servers.map((server) => {
    const what = server.kind === 'stdio' ? `runs ${String(server.entry.command)}` : `at ${/^https?:\/\/([^/?#]+)/i.exec(String(server.entry.url))?.[1] ?? 'a web address'}`;
    const keys = server.moves.length ? ` · ${server.moves.map((move) => move.key).join(', ')} into Secrets` : '';
    return `${server.name}: ${what}${keys}`;
  });
}

