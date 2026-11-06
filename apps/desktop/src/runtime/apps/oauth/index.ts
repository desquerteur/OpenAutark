// MCP authorization (B-052 track B, M3): AppOAuth for the connected-apps service. begin() runs discovery (RFC 9728 →
// RFC 8414/OIDC, issuer exact, S256 required), picks the scopes (challenge → resource metadata; a 403 step-up keeps
// the granted ones), reuses Workforce's registration at that issuer or registers (DCR, native public client), opens
// the loopback listener on the install's stable port (one free port of 33418–33478 picked once and kept in KV; when
// it is busy the next free one is used and the client registers again, since registrations carry their redirect)
// and returns the authorization address with state, PKCE S256 and `resource`; `done` checks `iss` (RFC 9207) on the
// way back, exchanges the code and stores the grant (tokens.ts). Without a way to register: OAuthUnsupported.
// A sign-in that reused a stored registration and never came back (timeout or cancel, not replaced) drops it: the
// server may have forgotten that client, so the next sign-in registers again; forget() drops the issuer's
// registration once no stored grant uses its client any more.
// Owns: the sign-in flow and the open sign-ins. Never: opens the browser, logs or returns a token, or shows server text.

import { randomBytes } from 'node:crypto';
import { WorkforceError } from '../../../shared/errors.ts';
import type { Timers } from '../../schedules/scheduler.ts';
import { OAuthUnsupported, type AppKv, type AppOAuth, type OAuthStart } from '../types.ts';
import { chooseScopes, discover, type AuthServer } from './discover.ts';
import type { FetchLike } from './http.ts';
import { openLoopback, type LoopbackListener, type LoopbackServerFactory } from './loopback.ts';
import { dropRegistration, register, storedRegistration, type Registration, type VaultLike } from './register.ts';
import { exchangeCode, Grants } from './tokens.ts';

export type { LoopbackServerFactory } from './loopback.ts';

/** The stable loopback ports: one is picked per install. */
export const PORT_FIRST = 33418;
export const PORT_LAST = 33478;
export const PORT_KEY = 'oauth:port';

export interface AppOAuthDeps {
  /** The vault (runtime/contracts/safety.ts SecretService): save, use and remove are all it needs. */
  secrets: VaultLike;
  /** The apps KV namespace; this module's keys start with 'oauth:'. */
  kv: AppKv;
  fetch?: FetchLike;
  now?: () => number;
  /** client_name of the registration ("Workforce"). */
  clientName: string;
  random?: (bytes: number) => Buffer;
  /** Test seam: the loopback listener (default node:http on 127.0.0.1). */
  server?: LoopbackServerFactory;
  /** Test seam: listen on this port only (0: the OS picks) instead of the stable range. */
  port?: number;
  timers?: Timers;
  /** Sign-in timeout (default 5 minutes). */
  timeoutMs?: number;
}

/** AppOAuth plus invalidate(): the server refused the access token in memory, the next authHeaders() refreshes. */
export type AppOAuthImpl = AppOAuth & { invalidate(appId: string): void };

const inRange = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= PORT_FIRST && (port as number) <= PORT_LAST;

function portOf(redirectUri: string): number | undefined {
  try { const port = Number(new URL(redirectUri).port); return Number.isInteger(port) && port > 0 ? port : undefined; } catch { return undefined; }
}

/** Ports in the order a sign-in tries them: the registration's, the install's, then the rest of the range (wrapping). */
export function portCandidates(input: { registered?: number; stored?: number; random: (bytes: number) => Buffer }): number[] {
  const size = PORT_LAST - PORT_FIRST + 1;
  const start = inRange(input.stored) ? input.stored : PORT_FIRST + (input.random(2).readUInt16BE(0) % size);
  const range = Array.from({ length: size }, (_, index) => PORT_FIRST + ((start - PORT_FIRST + index) % size));
  return [...new Set([...(input.registered !== undefined ? [input.registered] : []), ...range])];
}

/** RFC 9207: a present `iss` must be the issuer exactly; a missing one only passes when the server does not send it. */
function issuerCheck(server: AuthServer): (params: URLSearchParams) => Error | undefined {
  return (params) => {
    const iss = params.get('iss');
    if (iss === null) return server.issParameter ? new WorkforceError('forbidden', 'The sign-in answer did not name its server. Try again.') : undefined;
    return iss === server.issuer ? undefined : new WorkforceError('forbidden', 'The sign-in answer came from a different server. Try again.');
  };
}

export function createAppOAuth(deps: AppOAuthDeps): AppOAuthImpl {
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? randomBytes;
  const grants = new Grants({ kv: deps.kv, secrets: deps.secrets, fetch: fetchFn, now });
  const open = new Map<string, LoopbackListener>();
  const replaced = () => Object.assign(new WorkforceError('cancelled', 'The sign-in was replaced by a new one.'), { replaced: true });

  const ports = (registration: Registration | undefined): number[] => {
    if (deps.port !== undefined) return [deps.port];
    const stored = deps.kv.get<number>(PORT_KEY);
    return portCandidates({ registered: registration ? portOf(registration.redirectUri) : undefined, stored: inRange(stored) ? stored : undefined, random });
  };

  const begin: AppOAuth['begin'] = async (input) => {
    const { appId, appName, challenge } = input;
    open.get(appId)?.close(replaced());
    const found = await discover(fetchFn, input.resourceUrl, challenge.resourceMetadata);
    const server = found.server;
    const granted = challenge.status === 403 ? grants.get(appId)?.scopes : undefined;
    const scopes = chooseScopes({ challenge: challenge.scope, resourceScopes: found.scopesSupported, serverScopes: server.scopesSupported, granted });
    let registration = storedRegistration(deps.kv, server.issuer, now());
    if (!registration && !server.registrationEndpoint) throw new OAuthUnsupported();

    const ours = new Set([...open.values()].map((other) => other.port)); // another sign-in of this PC holds these
    const listener = await openLoopback({ ports: ports(registration), verify: issuerCheck(server), timers: deps.timers, timeoutMs: deps.timeoutMs, server: deps.server, random });
    const reused = registration !== undefined && registration.redirectUri === listener.redirectUri;
    try {
      if (!reused) {
        if (!server.registrationEndpoint) throw new OAuthUnsupported();
        registration = await register({ fetch: fetchFn, kv: deps.kv, secrets: deps.secrets, now: now(), clientName: deps.clientName }, server, listener.redirectUri);
      }
    } catch (error) { listener.close(); throw error; }
    const stored = deps.kv.get<number>(PORT_KEY);
    if (!inRange(stored) || (!reused && listener.port !== stored && !ours.has(stored))) deps.kv.set(PORT_KEY, listener.port);
    open.get(appId)?.close(replaced());
    open.set(appId, listener);

    const client = { clientId: registration!.clientId, authMethod: registration!.authMethod, tokenEndpoint: server.tokenEndpoint,
      ...(registration!.secretId ? { clientSecretId: registration!.secretId } : {}) };
    const authUrl = listener.address(server.authorizationEndpoint, {
      response_type: 'code', client_id: client.clientId, scope: scopes.length ? scopes.join(' ') : undefined, resource: found.resource,
      prompt: scopes.includes('offline_access') ? 'consent' : undefined,
    });
    const done = (async () => {
      let answer: Awaited<typeof listener.answer>;
      try { answer = await listener.answer; } catch (error) {
        const ended = error instanceof WorkforceError && (error.code === 'timeout' || error.code === 'cancelled') && !(error as { replaced?: boolean }).replaced;
        if (reused && ended) dropRegistration(deps.kv, deps.secrets, server.issuer, client.clientId); // maybe forgotten there: register anew next time
        throw error;
      }
      const tokens = await exchangeCode({ kv: deps.kv, secrets: deps.secrets, fetch: fetchFn, now }, { ...client, issuer: server.issuer, resource: found.resource }, answer);
      // forget(), close() or a newer sign-in during the exchange: this one stores nothing
      if (open.get(appId) !== listener) throw new WorkforceError('cancelled', 'The sign-in was cancelled.');
      await grants.save(appId, appName, {
        ...client, issuer: server.issuer, scopes, resource: found.resource, ...(server.revocationEndpoint ? { revocationEndpoint: server.revocationEndpoint } : {}),
      }, tokens);
    })().finally(() => { if (open.get(appId) === listener) open.delete(appId); });
    done.catch(() => undefined); // the service awaits it; an abandoned sign-in must not become an unhandled rejection
    const start: OAuthStart = { authUrl, done, cancel: () => listener.close() };
    return start;
  };

  return {
    begin,
    authHeaders: (appId, resourceUrl) => grants.header(appId, resourceUrl),
    hasGrant: (appId) => grants.has(appId),
    invalidate: (appId) => grants.invalidate(appId),
    forget: async (appId) => {
      open.get(appId)?.close();
      open.delete(appId);
      const grant = grants.get(appId);
      await grants.forget(appId);
      if (grant && !deps.kv.keys('oauth:grant:').some((key) => deps.kv.get<{ clientId?: unknown }>(key)?.clientId === grant.clientId)) {
        dropRegistration(deps.kv, deps.secrets, grant.issuer, grant.clientId);
      }
    },
    close: () => {
      for (const listener of open.values()) listener.close();
      open.clear();
    },
  };
}
