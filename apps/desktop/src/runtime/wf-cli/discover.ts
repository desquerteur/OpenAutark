// Finds the running app (or headless runtime) for the wf terminal client (C7): the data dir is
// --data, else AUTARK_DATA (the app sets it for what its runtime and agents start, so their wf reaches their
// own company, B-072), else this OS user's Electron userData dir (%APPDATA%\<productName>, ~/Library/
// Application Support/<productName>, $XDG_CONFIG_HOME or ~/.config/<productName>), and
// <data>/runtime.json {port, token, pid} is what the runtime writes once it listens (main.ts).
// B-044: that data dir is the documented Workforce folder – its generated README.md names wf as the way other
// programs control the app (root/readme.ts); agents may use it too.
// AF-001: run by an agent (AUTARK_AGENT_TOKEN set by the app, engines/agent-token.ts), the Endpoint also holds that agent's
// identity and hands it over with the Hello: the runtime then writes what this wf sends into chats as that agent.
// Owns: the per-OS default data dir, reading and checking runtime.json, the Endpoint that holds
// the owner token (and an agent's identity). Never: prints, logs or serialises a token (they are private fields that only
// Endpoint.hello() and Endpoint.redact() use); never connects anywhere or writes files.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOKEN_ENV, PROTOCOL_VERSION } from '../../shared/api/protocol.ts';
import type { Hello } from '../../shared/api/protocol.ts';

/** Electron's app name – package.json `productName` – names the userData folder (unit-tested against package.json). */
export const PRODUCT_NAME = 'Autark';
export const RUNTIME_FILE = 'runtime.json';
/** The runtime's Hello token limit (http/ws.ts). */
const MAX_TOKEN = 512;

export interface DiscoverEnv {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  cwd: string;
  /** Reads a UTF-8 file; throws (code ENOENT) when it does not exist. */
  readFile(file: string): string;
  /** True while a process with this pid exists. */
  alive(pid: number): boolean;
}

/** Where the desktop app keeps its data for this OS user: AUTARK_DATA when absolute, else Electron's `app.getPath('userData')`. */
export function defaultDataDir(input: Pick<DiscoverEnv, 'platform' | 'env' | 'home'>): string {
  const own = input.env.AUTARK_DATA?.trim();
  if (own && (input.platform === 'win32' ? path.win32 : path.posix).isAbsolute(own)) return own;
  if (input.platform === 'win32') {
    const base = input.env.APPDATA?.trim() || path.win32.join(input.home, 'AppData', 'Roaming');
    return path.win32.join(base, PRODUCT_NAME);
  }
  if (input.platform === 'darwin') return path.posix.join(input.home, 'Library', 'Application Support', PRODUCT_NAME);
  const xdg = input.env.XDG_CONFIG_HOME?.trim();
  return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(input.home, '.config'), PRODUCT_NAME);
}

/** A reachable runtime: loopback port plus the owner token, which never leaves through output. */
export class Endpoint {
  readonly dataDir: string;
  readonly port: number;
  readonly pid?: number;
  readonly #token: string;
  /** AF-001: the agent identity of the agent running this wf (AUTARK_AGENT_TOKEN) – the runtime then writes as that agent. */
  readonly #agent?: string;

  constructor(input: { dataDir: string; port: number; token: string; pid?: number; agent?: string }) {
    this.dataDir = input.dataDir;
    this.port = input.port;
    this.pid = input.pid;
    this.#token = input.token;
    this.#agent = input.agent;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  /** True when this wf runs for an agent (it acts with the owner's rights, but writes as the agent). */
  get asAgent(): boolean {
    return this.#agent !== undefined;
  }

  /** The first frame on `/ws` – the only place the tokens are handed out. */
  hello(): Hello {
    return { protocol: PROTOCOL_VERSION, token: this.#token, client: 'cli', ...(this.#agent ? { agent: this.#agent } : {}) };
  }

  /** Replaces the tokens wherever they would appear in output (defence in depth). */
  redact(text: string): string {
    let out = text.includes(this.#token) ? text.split(this.#token).join('[token]') : text;
    if (this.#agent && out.includes(this.#agent)) out = out.split(this.#agent).join('[token]');
    return out;
  }

  toJSON(): { dataDir: string; port: number; pid?: number } {
    return { dataDir: this.dataDir, port: this.port, pid: this.pid };
  }
}

export type Discovery =
  | { ok: true; endpoint: Endpoint }
  | { ok: false; dataDir: string; reason: 'missing' | 'invalid' | 'stopped'; message: string };

/** Reads <data>/runtime.json of `--data` (or the default data dir) and checks that its process still runs. */
export function discover(options: { data?: string }, env: DiscoverEnv): Discovery {
  const flavor = env.platform === 'win32' ? path.win32 : path.posix; // native on the real machine
  const explicit = options.data?.trim();
  const dataDir = explicit ? flavor.resolve(env.cwd, explicit) : defaultDataDir(env);
  const file = flavor.join(dataDir, RUNTIME_FILE);
  const start = explicit
    ? `Start the app or the headless runtime with --data "${dataDir}" first.`
    : `Start ${PRODUCT_NAME} first, or pass --data <dir> for a headless runtime.`;
  let text: string;
  try {
    text = env.readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, dataDir, reason: 'missing', message: `No running app found: ${file} does not exist. ${start}` };
    return { ok: false, dataDir, reason: 'invalid', message: `${file} cannot be read (${code ?? 'error'}).` };
  }
  const info = parseRuntimeInfo(text);
  if (!info) return { ok: false, dataDir, reason: 'invalid', message: `${file} is not a valid runtime file. ${start}` };
  if (info.pid !== undefined && !env.alive(info.pid)) {
    // Never send the token to whatever may listen on that port now.
    return { ok: false, dataDir, reason: 'stopped', message: `The app that wrote ${file} is no longer running. ${start}` };
  }
  return { ok: true, endpoint: new Endpoint({ dataDir, port: info.port, token: info.token, pid: info.pid, agent: agentIdentity(env, dataDir, flavor) }) };
}

/**
 * AF-001: AUTARK_AGENT_TOKEN, which the app sets for its agents' shells and engines, when this wf talks to that agent's own
 * app – AUTARK_DATA's data dir (or no AUTARK_DATA). Another company (--data elsewhere) does not know the agent.
 */
export function agentIdentity(env: Pick<DiscoverEnv, 'env' | 'platform'>, dataDir: string, flavor: typeof path.posix = env.platform === 'win32' ? path.win32 : path.posix): string | undefined {
  const token = env.env[AGENT_TOKEN_ENV]?.trim();
  if (!token || token.length > MAX_TOKEN) return undefined;
  const own = env.env.AUTARK_DATA?.trim();
  if (!own || !flavor.isAbsolute(own)) return token; // as defaultDataDir: only an absolute AUTARK_DATA names a folder
  const same = (a: string, b: string) => (env.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return same(flavor.resolve(own), flavor.resolve(dataDir)) ? token : undefined;
}

/** {port, token, pid?} from runtime.json text; undefined when anything is off. */
export function parseRuntimeInfo(text: string): { port: number; token: string; pid?: number } | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { port, token, pid } = value as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return undefined;
  if (pid !== undefined && (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1)) return undefined;
  return { port, token, pid: pid as number | undefined };
}

/** process.kill(pid, 0): ESRCH = gone; EPERM = exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function nodeDiscoverEnv(): DiscoverEnv {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    cwd: process.cwd(),
    readFile: (file) => readFileSync(file, 'utf8'),
    alive: processAlive,
  };
}
