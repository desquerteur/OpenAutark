// Finds the running app (or headless runtime) for the wf terminal client (C7): the data dir is
// --data, else AUTARK_DATA (the app sets it for what its runtime and agents start, so their wf reaches their
// own company, B-072), else this OS user's Electron userData dir (%APPDATA%\<productName>, ~/Library/
// Application Support/<productName>, $XDG_CONFIG_HOME or ~/.config/<productName>), and
// <data>/runtime.json {port, token, pid} is what the runtime writes once it listens (main.ts).
// B-044: that data dir is the documented Workforce folder – its generated README.md names wf as the way other
// programs control the app (root/readme.ts); agents may use it too.
// Owns: the per-OS default data dir, reading and checking runtime.json, the Endpoint that holds
// the owner token. Never: prints, logs or serialises the token (it is a private field that only
// Endpoint.hello() and Endpoint.redact() use); never connects anywhere or writes files.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../shared/api/protocol.ts';
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

  constructor(input: { dataDir: string; port: number; token: string; pid?: number }) {
    this.dataDir = input.dataDir;
    this.port = input.port;
    this.pid = input.pid;
    this.#token = input.token;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  /** The first frame on `/ws` – the only place the token is handed out. */
  hello(): Hello {
    return { protocol: PROTOCOL_VERSION, token: this.#token, client: 'cli' };
  }

  /** Replaces the token wherever it would appear in output (defence in depth). */
  redact(text: string): string {
    return text.includes(this.#token) ? text.split(this.#token).join('[token]') : text;
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
  return { ok: true, endpoint: new Endpoint({ dataDir, port: info.port, token: info.token, pid: info.pid }) };
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
