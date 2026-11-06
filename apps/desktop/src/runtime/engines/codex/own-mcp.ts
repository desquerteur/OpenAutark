// B-052 M1: agents' Codex threads never load the person's own MCP servers ([mcp_servers.*] of CODEX_HOME/config.toml,
// e.g. of the default ~/.codex home): through them an agent would reach the person's services without Workforce's
// gate. Connected apps reach agents as gated Workforce tools instead (runtime/apps; Settings › Apps imports these
// servers on the person's click). Codex has no switch for "no configured MCP servers": `-c mcp_servers={}` merges into
// the table and changes nothing, and `-c mcp_servers.<name>.enabled=false` splits the key at every dot. One inline
// table that names each configured server (`-c mcp_servers={"a"={enabled=false},"b.c"={enabled=false}}`) merges
// `enabled = false` into every entry – checked with codex-cli 0.164: `codex mcp list` shows them disabled, and the
// app-server's mcpServerStatus/list answers at once without starting one (without it, it starts all of them). A name
// that is not configured makes Codex refuse the whole config ("invalid transport"), so only the entries the file has
// with a transport (`command` or `url`) are named, read again at every server start (server.ts) and whenever the
// file's stamp (mtime and size) changed while the server waits between turns (server.ts restarts it when the names
// differ). Codex must never break over this: when a start with the override fails and one without it works, the home
// is remembered as refusing it until its config.toml changes (its own servers then load as before B-052).
// Owns: reading the names of that table, the one override, the file's stamp and the homes that refused it. Never:
// keeps or returns anything else of the file (commands, addresses, env, headers, tokens), reads another CODEX_HOME
// file, or writes one.

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseToml, type TomlValue } from '../../apps/import/toml.ts';

/** A larger config.toml is not read (its servers stay as Codex reads them – a person's file is far smaller). */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

const isTable = (value: TomlValue | undefined): value is Record<string, TomlValue> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The config.toml Codex reads for this home: the account's home, else $CODEX_HOME, else ~/.codex. */
export function codexConfigFile(home: string | undefined, env: NodeJS.ProcessEnv, homeDir: string = os.homedir()): string {
  const dir = home || env.CODEX_HOME || path.join(homeDir, '.codex');
  return path.join(dir, 'config.toml');
}

/** The configured server names (entries with a `command` or `url`), in file order. */
export function configuredServers(text: string): string[] {
  let table: TomlValue | undefined;
  try { table = parseToml(text).mcp_servers; } catch { return []; }
  if (!isTable(table)) return [];
  return Object.entries(table)
    .filter(([, entry]) => isTable(entry) && (typeof entry.command === 'string' || typeof entry.url === 'string'))
    .map(([name]) => name);
}

/** A TOML basic string (quotes, backslashes and control characters escaped). */
function tomlString(text: string): string {
  return `"${text.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => (ch === '\\' || ch === '"' ? `\\${ch}` : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`))}"`;
}

/** The `-c` value that turns these servers off, or undefined when there are none. */
export function serversOff(names: readonly string[]): string | undefined {
  if (!names.length) return undefined;
  return `mcp_servers={${names.map((name) => `${tomlString(name)}={enabled=false}`).join(',')}}`;
}

/** `-c` pairs for the app-server: the person's configured MCP servers off ([] when the file has none or is unreadable). */
export async function ownMcpOff(home: string | undefined, env: NodeJS.ProcessEnv, read: (file: string) => Promise<string | undefined> = readConfig): Promise<string[]> {
  const text = await read(codexConfigFile(home, env)).catch(() => undefined);
  const off = text ? serversOff(configuredServers(text)) : undefined;
  return off ? [off] : [];
}

/** config.toml's stamp ("<mtime>:<size>"), '' when it is missing or unreadable. */
export async function configStamp(file: string): Promise<string> {
  try {
    const stat = await fsp.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

/** config.toml path → the stamp with which a start with the override failed and one without it worked. */
const refused = new Map<string, string>();

/** This home's Codex refused the override for the file as it is now (its stamp). */
export function overrideRefused(file: string, stamp: string): boolean {
  return refused.get(file) === stamp;
}

/** Remembers the refusal until the file's stamp changes. */
export function rememberRefused(file: string, stamp: string): void {
  refused.set(file, stamp);
}

async function readConfig(file: string): Promise<string | undefined> {
  try {
    if ((await fsp.stat(file)).size > MAX_CONFIG_BYTES) return undefined;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined; // no config file: nothing to turn off
  }
}
