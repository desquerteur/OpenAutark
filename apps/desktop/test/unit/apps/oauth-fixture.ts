// Test fixture for MCP authorization (B-052 track B): a fake authorization server + protected resource over node:http
// on 127.0.0.1:0 (well-known documents, /register, /token, /revoke; /authorize is simulated by authorize(), which
// returns the callback the browser would load), a fake vault, an in-memory apps KV, fake timers and a fake loopback
// listener the test hits the way the browser would.
// Owns: fixtures only. Never imported by src/.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { SecretInfo } from '../../../src/shared/model/security.ts';
import { McpAuthRequired, type AppKv } from '../../../src/runtime/apps/types.ts';
import { createAppOAuth, type AppOAuthDeps } from '../../../src/runtime/apps/oauth/index.ts';
import type { Timers } from '../../../src/runtime/schedules/scheduler.ts';
import type { LoopbackHandler, LoopbackServerFactory } from '../../../src/runtime/apps/oauth/loopback.ts';
import type { VaultLike } from '../../../src/runtime/apps/oauth/register.ts';

export class MemoryKv implements AppKv {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.data.has(key) ? structuredClone(this.data.get(key)) as T : undefined; }
  set(key: string, value: unknown): void { this.data.set(key, structuredClone(value)); }
  delete(key: string): void { this.data.delete(key); }
  keys(prefix = ''): string[] { return [...this.data.keys()].filter((key) => key.startsWith(prefix)); }
}

interface Entry { label: string; kind: string; value?: string; source?: string }

export class FakeVault implements VaultLike {
  readonly entries = new Map<string, Entry>();
  readonly saves: Array<{ id?: string } & Entry> = [];
  readonly uses: Array<{ id: string; agentId: string; domain?: string }> = [];
  private seq = 0;
  async save(input: Parameters<VaultLike['save']>[0]): Promise<SecretInfo> {
    this.saves.push({ ...input });
    const id = input.id ?? `sec_${++this.seq}`;
    const previous = this.entries.get(id);
    this.entries.set(id, { label: input.label, kind: input.kind, value: input.value ?? previous?.value, source: input.source ?? previous?.source });
    return { id, label: input.label, kind: input.kind } as SecretInfo;
  }
  async use(id: string, agentId: string, domain?: string): Promise<string> {
    this.uses.push({ id, agentId, domain });
    const entry = this.entries.get(id);
    if (!entry?.value) throw new WorkforceError('not_found', 'Secret not found.');
    return entry.value;
  }
  remove(id: string): void { this.entries.delete(id); }
  /** Every stored value (to check that no token leaks into KV or an error). */
  values(): string[] { return [...this.entries.values()].map((entry) => entry.value ?? ''); }
}

export class FakeTimers implements Timers {
  pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  private seq = 0;
  set(fn: () => void, ms: number) { const id = ++this.seq; this.pending.push({ fn, ms, id }); return id; }
  clear(handle: unknown) { this.pending = this.pending.filter((timer) => timer.id !== handle); }
  fireAll() { const due = this.pending; this.pending = []; for (const timer of due) timer.fn(); }
}

/**
 * Fake loopback listeners: ports in `busy` (another program) or held by an open fake listener refuse to bind; `hit` is
 * the browser coming back to the port named in its Host header (default: the latest listener).
 */
export function fakeLoopback() {
  const handlers = new Map<number, LoopbackHandler>();
  const open = new Set<number>();
  let port = 0;
  const busy = new Set<number>();
  const tried: number[] = [];
  const factory: LoopbackServerFactory = (h) => {
    let bound: number | undefined;
    return {
      listen: async (wanted) => {
        tried.push(wanted);
        if (busy.has(wanted) || open.has(wanted)) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
        bound = port = wanted || 50_000;
        handlers.set(bound, h);
        open.add(bound);
        return bound;
      },
      close: () => { if (bound !== undefined && handlers.get(bound) === h) open.delete(bound); },
    };
  };
  const hit = (path: string, host = `127.0.0.1:${port}`, method = 'GET') => {
    let status = 0;
    let body = '';
    const handler = handlers.get(Number(host.split(':').at(-1))) ?? handlers.get(port)!;
    handler({ method, url: path, headers: { host } }, { writeHead: (code) => { status = code; }, end: (text) => { body = text ?? ''; } });
    return { status, body };
  };
  /** The browser coming back to the listener of `authUrl` (its redirect_uri). */
  const back = (authUrl: string, path: string) => hit(path, new URL(new URL(authUrl).searchParams.get('redirect_uri')!).host);
  return { factory, hit, back, busy, tried, isOpen: () => open.has(port), port: () => port, openPorts: () => [...open] };
}

export interface AsOptions {
  /** Issuer path ('' = the origin). */
  issuerPath?: string;
  /** Where the protected resource metadata is: the path-aware address (default), the root one, or nowhere. */
  prm?: 'path' | 'root' | 'none';
  prmResource?: string;
  prmScopes?: string[];
  asScopes?: string[];
  s256?: boolean;
  registration?: boolean;
  wrongIssuer?: boolean;
  issParameter?: boolean;
  rotate?: boolean;
  noRefresh?: boolean;
  expiresIn?: number;
  revocation?: boolean;
  clientSecret?: string;
}

type Pending = { challenge: string; clientId: string; redirectUri: string; resource: string; scope: string };

export async function fakeAuthServer(options: AsOptions = {}) {
  const hits: string[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  const tokenRequests: Array<{ params: URLSearchParams; authorization?: string }> = [];
  const revocations: URLSearchParams[] = [];
  const codes = new Map<string, Pending>();
  const refreshTokens = new Map<string, string>(); // token → scope
  let seq = 0;
  let tokenDelayMs = 0;
  let failTokens: number | undefined;
  let failCode = 'server_error';
  let base = '';
  const issuerPath = options.issuerPath ?? '';
  const issuer = () => `${base}${issuerPath}`;

  const metadata = () => ({
    issuer: options.wrongIssuer ? `${base}/someone-else` : issuer(),
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    ...(options.registration === false ? {} : { registration_endpoint: `${base}/register` }),
    ...(options.revocation === false ? {} : { revocation_endpoint: `${base}/revoke` }),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: options.s256 === false ? ['plain'] : ['S256'],
    ...(options.asScopes ? { scopes_supported: options.asScopes } : {}),
    authorization_response_iss_parameter_supported: options.issParameter ?? true,
  });
  const prmDocument = () => ({ resource: options.prmResource ?? `${base}/mcp`, authorization_servers: [issuer()], ...(options.prmScopes ? { scopes_supported: options.prmScopes } : {}) });

  const send = (response: ServerResponse, status: number, body?: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (request: IncomingMessage) => new Promise<string>((resolve) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => resolve(text));
  });
  const issue = (scope: string) => {
    const n = ++seq;
    const refresh = options.noRefresh ? undefined : `rt-${n}`;
    if (refresh) refreshTokens.set(refresh, scope);
    return { access_token: `at-${n}`, token_type: 'Bearer', expires_in: options.expiresIn ?? 3600, ...(refresh ? { refresh_token: refresh } : {}), scope };
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', base);
    hits.push(`${request.method} ${url.pathname}`);
    const body = await readBody(request);
    if (request.method === 'GET') {
      if (url.pathname === `/.well-known/oauth-protected-resource/mcp` && (options.prm ?? 'path') === 'path') return send(response, 200, prmDocument());
      if (url.pathname === '/.well-known/oauth-protected-resource' && options.prm === 'root') return send(response, 200, prmDocument());
      if (url.pathname === `/.well-known/oauth-authorization-server${issuerPath}`) return send(response, 200, metadata());
      return send(response, 404, { error: 'not_found' });
    }
    if (url.pathname === '/register') {
      const input = JSON.parse(body) as Record<string, unknown>;
      registrations.push(input);
      return send(response, 201, { client_id: `client-${registrations.length}`, ...input, ...(options.clientSecret ? { client_secret: options.clientSecret, token_endpoint_auth_method: 'client_secret_post' } : {}) });
    }
    const params = new URLSearchParams(body);
    if (url.pathname === '/revoke') { revocations.push(params); return send(response, 200); }
    if (url.pathname !== '/token') return send(response, 404);
    tokenRequests.push({ params, authorization: request.headers.authorization });
    if (tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
    if (failTokens !== undefined) return send(response, failTokens, { error: failCode, error_description: 'secret body text' });
    if (params.get('grant_type') === 'authorization_code') {
      const pending = codes.get(params.get('code') ?? '');
      codes.delete(params.get('code') ?? '');
      const verifier = params.get('code_verifier') ?? '';
      const ok = pending && createHash('sha256').update(verifier).digest('base64url') === pending.challenge
        && params.get('client_id') === pending.clientId && params.get('redirect_uri') === pending.redirectUri && params.get('resource') === pending.resource;
      return ok ? send(response, 200, issue(pending!.scope)) : send(response, 400, { error: 'invalid_grant', error_description: 'secret body text' });
    }
    const presented = params.get('refresh_token') ?? '';
    const scope = refreshTokens.get(presented);
    if (scope === undefined) return send(response, 400, { error: 'invalid_grant' });
    if (options.rotate ?? true) refreshTokens.delete(presented);
    const answer = issue(scope);
    if (!(options.rotate ?? true)) { refreshTokens.delete(answer.refresh_token!); delete (answer as { refresh_token?: string }).refresh_token; }
    return send(response, 200, answer);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    get base() { return base; },
    get issuer() { return issuer(); },
    get mcpUrl() { return `${base}/mcp`; },
    hits, registrations, tokenRequests, revocations, refreshTokens,
    setTokenDelay(ms: number) { tokenDelayMs = ms; },
    failTokenCalls(status: number | undefined, code = 'server_error') { failTokens = status; failCode = code; },
    /** The authorization endpoint: remembers the request and returns the callback path + query the browser loads. */
    authorize(authUrl: string, extra: { iss?: string | null; state?: string; error?: string } = {}): string {
      const params = new URL(authUrl).searchParams;
      const code = `code-${++seq}`;
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '', clientId: params.get('client_id') ?? '', redirectUri: params.get('redirect_uri') ?? '',
        resource: params.get('resource') ?? '', scope: params.get('scope') ?? '',
      });
      const back = new URLSearchParams({ state: extra.state ?? params.get('state') ?? '' });
      if (extra.error) back.set('error', extra.error); else back.set('code', code);
      const iss = extra.iss === undefined ? issuer() : extra.iss;
      if (iss !== null) back.set('iss', iss);
      return `${new URL(params.get('redirect_uri')!).pathname}?${back.toString()}`;
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

export type FakeAs = Awaited<ReturnType<typeof fakeAuthServer>>;
export const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);

/** The fake server, a vault, a KV, a manual clock, fake timers and a fake loopback around createAppOAuth. */
export async function world(asOptions: AsOptions = {}, deps: Partial<AppOAuthDeps> = {}) {
  const as = await fakeAuthServer(asOptions);
  const kv = new MemoryKv();
  const vault = new FakeVault();
  const loopback = fakeLoopback();
  const timers = new FakeTimers();
  let now = T0;
  const make = () => createAppOAuth({ secrets: vault, kv, clientName: 'Workforce', server: loopback.factory, timers, now: () => now, ...deps });
  const oauth = make();
  const challenge = (input: { status?: 401 | 403; resourceMetadata?: string; scope?: string; error?: string } = {}) =>
    new McpAuthRequired({ status: input.status ?? 401, resourceMetadata: input.resourceMetadata, scope: input.scope, error: input.error });
  /** begin → the browser at the server → back on the loopback → done. */
  const signIn = async (appId = 'notion', reason = challenge(), oauthImpl = oauth) => {
    const start = await oauthImpl.begin({ appId, appName: appId === 'notion' ? 'Notion' : appId, resourceUrl: as.mcpUrl, challenge: reason });
    const page = loopback.back(start.authUrl, as.authorize(start.authUrl));
    await start.done;
    return { start, page, params: new URL(start.authUrl).searchParams };
  };
  return {
    as, kv, vault, loopback, timers, oauth, make, challenge, signIn,
    clock: { now: () => now, advance: (ms: number) => { now += ms; } },
    /** Everything outside the vault, as text (no token may be in it). */
    kvText: () => JSON.stringify([...kv.data.entries()]),
  };
}
