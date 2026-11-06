// Several companies on this PC (B-072, shared/model/companies.ts): companies.list reads each company's data folder, the
// first one and every "<first> Companies/<id>/" (AppInfo.companies from main), and names it from the profile in its
// settings.json. Another company keeps its workspace in its own folder (<data>/workspace), so two companies never share
// projects, downloads or shared skills; the first keeps <home>/Workforce.
// B-075: callCompany reaches another company's running runtime on this PC – its loopback POST /rpc with the owner token
// of its runtime.json – for an agent's tool call there (tools/registry.ts) and for its own facts (tools/builtin/companies.ts).
// Owns: the list, a company's folder, another company's workspace folder and that loopback call. Never: writes into a
// company's folder, starts a company (main does: main/companies.ts), logs, returns or keeps a token.

import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import type { AppInfo } from '../../shared/api/host-bridge.ts';
import { WorkforceError, isErrorCode } from '../../shared/errors.ts';
import { companyLabel, isCompanyId, parseRuntimeFile, RUNTIME_FILE, type CompanyEntry } from '../../shared/model/companies.ts';
import { parseText } from '../settings/schema.ts';
import { ROOT_SETTINGS } from './layout.ts';

type CompanyApp = Pick<AppInfo, 'dataDir' | 'companies'>;

/** The profile section of a company's settings.json (none when the file is missing or unreadable). */
function profileOf(dir: string): Record<string, unknown> | undefined {
  try {
    const profile = parseText(readFileSync(path.join(dir, ROOT_SETTINGS), 'utf8')).data?.profile;
    return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** A company's data folder: the first one for id null, else "<first> Companies/<id>"; undefined without AppInfo.companies. */
export function companyFolder(app: CompanyApp, id: string | null): string | undefined {
  const info = app.companies;
  if (!info) return undefined;
  return id === null ? info.first : path.join(info.dir, id);
}

/** Every company on this PC, the first one first, the others by id; empty without AppInfo.companies (a test profile, headless). */
export function listCompanies(app: CompanyApp): CompanyEntry[] {
  const info = app.companies;
  if (!info) return [];
  const here = path.resolve(app.dataDir);
  const entry = (id: string | null, dir: string): CompanyEntry => ({ id, label: companyLabel(profileOf(dir), id), current: path.resolve(dir) === here });
  let ids: string[] = [];
  try {
    ids = readdirSync(info.dir, { withFileTypes: true }).filter((item) => item.isDirectory() && isCompanyId(item.name)).map((item) => item.name);
  } catch { /* no other company yet */ }
  ids.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return [entry(null, info.first), ...ids.map((id) => entry(id, path.join(info.dir, id)))];
}

/** Another company's workspace: <data>/workspace; undefined for the first company (the runtime's default). */
export function companyWorkspace(app: CompanyApp): string | undefined {
  const info = app.companies;
  return info && path.resolve(app.dataDir) !== path.resolve(info.first) ? path.join(app.dataDir, 'workspace') : undefined;
}

/** {port, token} of the company runtime in `dir` while its process lives; null when it does not run. */
function endpointOf(dir: string): { port: number; token: string } | null {
  try {
    const found = parseRuntimeFile(readFileSync(path.join(dir, RUNTIME_FILE), 'utf8'));
    if (!found) return null;
    process.kill(found.pid, 0); // throws when that runtime is gone
    return { port: found.port, token: found.token };
  } catch {
    return null;
  }
}

/** Does the company in `dir` run now? */
export const companyRuns = (dir: string): boolean => endpointOf(dir) !== null;

/** An RPC answer's frame, undefined when the text is none. */
function replyOf(text: string): { result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as { result?: unknown; error?: { code?: unknown; message?: unknown } } : undefined;
  } catch {
    return undefined;
  }
}

const notReached = (message: string): WorkforceError => new WorkforceError('unavailable', message, { details: { reachable: false } });

/**
 * One owner call into the company runtime in `dir` over its loopback POST /rpc; resolves with the result. Rejects with a
 * WorkforceError: details.reachable false when nothing reached it (it does not run, the connection was refused, stopped
 * before sending); that runtime's own error as it answered it; 'unavailable' when the answer broke off (what ran there is
 * then unknown). No timeout unless `timeoutMs`: a tool's own limits and the caller's signal bound it.
 */
export function callCompany(dir: string, method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  const target = endpointOf(dir);
  if (!target) return Promise.reject(notReached('That company does not run right now, so nothing ran there. It runs once it is opened (profile menu).'));
  if (options.signal?.aborted) return Promise.reject(notReached('Stopped before the call was sent.'));
  const body = JSON.stringify({ id: 1, method, ...(params === undefined ? {} : { params }) });
  return new Promise((done, fail) => {
    // The caller's signal lives as long as its turn: its listener goes once this call settles.
    const onAbort = () => req.destroy(new WorkforceError('cancelled', 'Stopped.'));
    const resolve = (value: unknown) => { options.signal?.removeEventListener('abort', onAbort); done(value); };
    const reject = (error: WorkforceError) => { options.signal?.removeEventListener('abort', onAbort); fail(error); };
    const req = request({
      host: '127.0.0.1', port: target.port, path: '/rpc', method: 'POST', agent: false, ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('error', () => reject(new WorkforceError('unavailable', 'The answer from that company broke off.')));
      res.on('end', () => {
        const reply = replyOf(text);
        if (reply && 'result' in reply) return resolve(reply.result);
        const code = typeof reply?.error?.code === 'string' && isErrorCode(reply.error.code) ? reply.error.code : 'internal';
        reject(new WorkforceError(code, typeof reply?.error?.message === 'string' ? reply.error.message : 'That company sent no readable answer.'));
      });
    });
    req.on('timeout', () => req.destroy(new WorkforceError('timeout', 'That company did not answer in time.')));
    req.on('error', (error: Error & { code?: unknown }) => {
      if (error instanceof WorkforceError) reject(error);
      else reject(error.code === 'ECONNREFUSED' ? notReached('That company does not take calls right now, so nothing ran there.') : new WorkforceError('unavailable', 'The call into that company broke off.'));
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    req.end(body);
  });
}
