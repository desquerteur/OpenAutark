// AF-005 Settings › Connectors › "Own MCP server": what the form makes of its fields – one mcp.json entry, either a web
// server (HTTP / SSE: address, an optional token, headers) or a program on this PC (stdio: command, arguments, folder,
// environment variables). Every value typed into the Name | Value rows and the token goes into the secrets catalog
// (the entry holds its secret://<id> handle; a handle typed in stays as it is), so no key ever lands in the file.
// Owns: checking the fields and building that entry with the values still apart (mcp-import.ts SecretMove).
// Never: saves a value, calls anything or keeps what it read.

import type { KvRow } from './secret-groups.ts';
import { nameForServer, type ImportedServer, type SecretMove } from './mcp-import.ts';
import { splitCommand } from './apps-files.ts';

export type ServerKind = 'url' | 'command';

export interface ServerFields {
  kind: ServerKind;
  /** The web address, or the command line (its first part the program, the rest arguments). */
  address: string;
  /** More arguments ("quoted parts" stay together). */
  args: string;
  /** stdio: the folder it starts in (optional). */
  cwd: string;
  name: string;
  /** url: a key sent as Authorization: Bearer … (optional). */
  token: string;
  /** url: headers; command: environment variables. */
  rows: KvRow[];
}

export const NO_SERVER: ServerFields = { kind: 'url', address: '', args: '', cwd: '', name: '', token: '', rows: [] };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOOPBACK = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i;
const HANDLE = /secret:\/\/[A-Za-z0-9_-]{1,128}/;
const SCHEME = /^(Bearer|Basic|Token|Bot)\s+(\S.*)$/i;

/** Why the form cannot save yet ('' = it can) and the server it makes. */
export function serverDraft(fields: ServerFields): { blocked: string; server?: ImportedServer } {
  const address = fields.address.trim();
  const url = fields.kind === 'url';
  if (!address) return { blocked: url ? 'Enter the MCP address the server names for AI tools' : 'Enter the command that starts the server' };
  if (url && !/^https?:\/\/\S+$/i.test(address)) return { blocked: 'Enter an address that starts with https://' };
  if (url && /^http:/i.test(address) && !LOOPBACK.test(address)) return { blocked: 'Use https:// – http:// only for a server on this PC (localhost)' };
  const rows = fields.rows.filter((row) => row.name.trim() || row.value.trim());
  const label = url ? 'header' : 'variable';
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) return { blocked: `Give every ${label} a name` };
    if (!row.value.trim()) return { blocked: `Enter a value for ${name}` };
    if (url ? !HEADER_NAME.test(name) : !ENV_NAME.test(name)) return { blocked: url ? `"${name}" is no header name` : `"${name}" is no variable name (letters, digits and _)` };
  }
  const names = rows.map((row) => row.name.trim().toLowerCase());
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) return { blocked: `${rows.find((row) => row.name.trim().toLowerCase() === twice)!.name.trim()} is there twice` };
  if (url && fields.token.trim() && names.includes('authorization')) return { blocked: 'Either the token or an Authorization header' };

  const moves: SecretMove[] = [];
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.name.trim();
    const value = row.value.trim();
    if (HANDLE.test(value)) { map[key] = value; continue; }
    const scheme = url ? SCHEME.exec(value) : null;
    map[key] = value; // replaced by its handle once stored (mcp-import.ts withHandles)
    moves.push({ where: url ? 'headers' : 'env', key, value: scheme ? scheme[2].trim() : value, scheme: scheme ? `${scheme[1]} ` : '' });
  }
  if (url && fields.token.trim()) {
    map.Authorization = fields.token.trim();
    moves.push({ where: 'headers', key: 'Authorization', value: fields.token.trim().replace(/^Bearer\s+/i, ''), scheme: 'Bearer ' });
  }
  let entry: Record<string, unknown>;
  if (url) entry = { url: address, ...(Object.keys(map).length ? { headers: map } : {}) };
  else {
    const line = splitCommand(address);
    const args = [...line.args, ...splitArgs(fields.args)];
    entry = { command: line.command, args, ...(fields.cwd.trim() ? { cwd: fields.cwd.trim() } : {}), ...(Object.keys(map).length ? { env: map } : {}) };
  }
  const name = fields.name.trim() || nameForServer(entry);
  return { blocked: '', server: { name, entry, moves, notes: [], kind: url ? 'http' : 'stdio' } };
}

/** The arguments of one line ("quoted parts" stay together). */
export function splitArgs(line: string): string[] {
  return (line.match(/"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^"|"$/g, ''));
}
