// Several companies on one PC (B-072): a company is one data folder. The first is the app's own (<appData>/Autark, as it
// always was); every other one is "<first> Companies/<id>" beside it, never inside, where the first one's backup and
// watcher would take it in. `--company=<id>` picks one before anything else (index.ts), so each company has its own
// single-instance lock, runtime, tray and window. Opening a company starts this app again with its flag, detached; a
// company that runs already shows its window ('second-instance'). The window it was asked from goes to the tray and
// keeps working: that is the switch. The person's emergency stop reaches the other running companies too (their
// runtime.json, owner token), and an update's relaunch of the first company wakes the ones the install ended. B-075: an
// agent's call into another company goes runtime to runtime (runtime/root/companies.ts callCompany), not through here.
// B-078: a new company from the company menu's "+" starts with `--start=mine|employee` (startFlag), so its first run
// opens at connecting to another PC that way (AppInfo.start).
// Owns: the folder rule, the flags, making a company folder, starting a company, the stop and the wake of the others.
// Never: imports electron, reads a company's settings (the runtime names them: runtime/root/companies.ts), quits
// anything, logs or keeps a token.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import type { HostOps } from '../shared/api/host-bridge.ts';
import { WorkforceError } from '../shared/errors.ts';
import { isCompanyId, isCompanyStart, parseRuntimeFile, RUNTIME_FILE, type CompanyStart } from '../shared/model/companies.ts';
import { BACKGROUND_FLAG, readRunState } from './launcher.ts';

export const COMPANY_FLAG = '--company=';
/** B-078: how a new company from the company menu's "+" starts (shared/model/companies.ts CompanyStart). */
export const START_FLAG = '--start=';
const CALL_TIMEOUT_MS = 5_000;

/** The company this start is for (`--company=<id>`, the last valid one); null = the first company. */
export function companyFlag(argv: readonly string[]): string | null {
  let id: string | null = null;
  for (const arg of argv) {
    const value = arg.startsWith(COMPANY_FLAG) ? arg.slice(COMPANY_FLAG.length) : null;
    if (isCompanyId(value)) id = value;
  }
  return id;
}

/** How this start was asked for (`--start=mine|employee|new`, the last valid one); undefined for a plain start. */
export function startFlag(argv: readonly string[]): CompanyStart | undefined {
  let start: CompanyStart | undefined;
  for (const arg of argv) {
    const value = arg.startsWith(START_FLAG) ? arg.slice(START_FLAG.length) : null;
    if (isCompanyStart(value)) start = value;
  }
  return start;
}

/** The arguments that start a company (none for the first). */
export function companyArgs(id: string | null | undefined): string[] {
  return id ? [`${COMPANY_FLAG}${id}`] : [];
}

/** Where the other companies live: beside the first one's folder ("…/Autark Companies"). */
export function companiesDir(first: string): string {
  return `${path.resolve(first)} Companies`;
}

export function companyDir(first: string, id: string): string {
  return path.join(companiesDir(first), id);
}

/** The next free id: company-2, company-3, … */
export function nextCompanyId(taken: readonly string[]): string {
  for (let n = 2; ; n += 1) if (!taken.includes(`company-${n}`)) return `company-${n}`;
}

/** What starts this app again: the AppImage itself on Linux (execPath lies in this process's own mount, which ends with
 *  it – as launcher-tasks.ts), electron <app> in development, else the executable. */
export function appCommand(args: string[], self: { execPath: string; appImage?: string; defaultApp?: boolean; argv: readonly string[] }): [string, string[]] {
  if (self.appImage) return [self.appImage, args];
  return [self.execPath, [...(self.defaultApp ? self.argv.slice(1, 2) : []), ...args]];
}

/** Starts this app again, detached. Throws only when the OS refuses at once. */
export function spawnApp(args: string[]): void {
  const [file, all] = appCommand(args, { execPath: process.execPath, appImage: process.env.APPIMAGE || undefined, defaultApp: process.defaultApp, argv: process.argv });
  const child = spawn(file, all, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // ENOENT/EACCES arrive as an event: unhandled, main would show an error dialog
  child.unref();
}

export interface CompanyOpenDeps {
  dir: string; // companiesDir of the first company
  current: string | null; // this process's company
  spawn(args: string[]): void;
  show(): void; // this company's window
  hide(): void; // this company's window to the tray
}

function folders(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; }
}

function isDir(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/** Host op company.open: a new company (create; with an id that folder), the first one (no id) or one by id. */
export function openCompany(args: HostOps['company.open']['args'], deps: CompanyOpenDeps): HostOps['company.open']['result'] {
  const raw = args as { id?: unknown; create?: unknown; start?: unknown };
  if (raw.create !== undefined && typeof raw.create !== 'boolean') throw new WorkforceError('bad_request', 'Invalid create.');
  if (raw.start !== undefined && !isCompanyStart(raw.start)) throw new WorkforceError('bad_request', 'Invalid start: new, mine or employee.');
  const start = raw.create === true && raw.start !== 'new' ? raw.start as CompanyStart | undefined : undefined;
  if (raw.id !== undefined && raw.id !== null && !isCompanyId(raw.id)) throw new WorkforceError('bad_request', 'Invalid company id.');
  let id = (raw.id ?? null) as string | null;
  if (raw.create === true) {
    id ??= nextCompanyId(folders(deps.dir));
    mkdirSync(path.join(deps.dir, id), { recursive: true });
  } else if (id !== null && !isDir(path.join(deps.dir, id))) {
    throw new WorkforceError('not_found', 'There is no company with this id on this PC (companies.list).');
  }
  if (id === deps.current) {
    deps.show();
    return { ok: true, id };
  }
  try { deps.spawn([...companyArgs(id), ...(start ? [`${START_FLAG}${start}`] : [])]); } catch { throw new WorkforceError('unavailable', 'The company could not be started.'); }
  deps.hide();
  return { ok: true, id };
}

/**
 * After an update install – it ends every company, its relaunch starts only the first – the companies that were running
 * (run-state 'running': no deliberate quit) start again in the background; one the person quit stays off. A company that
 * still runs only gets a start that quits at once (its lock). Returns the ids it started.
 */
export function wakeCompanies(dir: string, start: (args: string[]) => void = spawnApp): string[] {
  const woken = folders(dir).filter(id => isCompanyId(id) && readRunState(path.join(dir, id))?.state === 'running');
  for (const id of woken) {
    try { start([...companyArgs(id), BACKGROUND_FLAG]); } catch { /* the next sign-in or the person starts it */ }
  }
  return woken;
}

/** {port, token} of a company's runtime that still runs; null otherwise (the token never goes to whatever listens on that port now). */
function runtimeOf(dir: string): { port: number; token: string } | null {
  try {
    const found = parseRuntimeFile(readFileSync(path.join(dir, RUNTIME_FILE), 'utf8')); // a port in range and a header-safe token: request() below then never throws
    if (!found) return null;
    process.kill(found.pid, 0); // throws when that runtime is gone
    return { port: found.port, token: found.token };
  } catch { return null; }
}

/** One owner call into another company's running runtime over its loopback `POST /rpc`; true when it answered with a result. Never throws. */
export function callCompany(dir: string, method: 'work.stop'): Promise<boolean> {
  const target = runtimeOf(dir);
  if (!target) return Promise.resolve(false);
  const body = JSON.stringify({ id: 1, method });
  return new Promise(resolve => {
    const req = request({
      host: '127.0.0.1', port: target.port, path: '/rpc', method: 'POST', timeout: CALL_TIMEOUT_MS, agent: false, // one-shot: no pooled socket
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && 'result' in JSON.parse(text)); } catch { resolve(false); } });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

/** The person's emergency stop (tray, the one global shortcut) for every other company on this PC; `current` is this one's folder. */
export async function stopOtherCompanies(companies: { first: string; dir: string }, current: string): Promise<void> {
  const own = path.resolve(current);
  const all = [companies.first, ...folders(companies.dir).filter(isCompanyId).map(id => path.join(companies.dir, id))];
  await Promise.all(all.filter(dir => path.resolve(dir) !== own).map(dir => callCompany(dir, 'work.stop')));
}
