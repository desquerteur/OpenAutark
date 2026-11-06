// MCP authorization (B-052 track B): the tokens of an app's grant. The code exchange and refreshes (with the RFC 8707
// `resource`), the refresh token – or, when the server issues none, the access token and its expiry – in the vault
// as '<App> sign-in' (saved from the token endpoint's host; a rotated refresh token is written into
// the same entry), the access token in memory only and refreshed 60 s before it expires, one refresh per app at a
// time (rotating servers may revoke a grant when an old refresh token is replayed), a refresh the server refuses
// (HTTP 400/401, invalid_grant) → ReconnectNeeded and the grant is dropped, and best-effort revocation (RFC 7009).
// The KV record per app keeps vault ids and endpoints only. A sign-in that replaces a grant while a refresh runs wins.
// Owns: grants and the in-memory access tokens. Never: a token in a log, an error, the UI or KV.

import { SYSTEM_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { ReconnectNeeded, type AppKv } from '../types.ts';
import { callJson, OAuthHttpError, record, type FetchLike } from './http.ts';
import { clientAuth, dropRegistration, type ClientRef, type VaultLike } from './register.ts';
import { resourceCovers } from './discover.ts';

/** The stored grant of one app (no token: `secretId` points into the vault). */
export interface Grant extends ClientRef {
  /** Vault entry: the refresh token (`refresh`), else the access token. */
  secretId: string;
  refresh: boolean;
  label: string;
  issuer: string;
  scopes: string[];
  resource: string;
  revocationEndpoint?: string;
  /** Expiry of the access token (ms; absent: unknown). */
  expiresAt?: number;
}

export interface TokenAnswer { accessToken: string; expiresAt?: number; refreshToken?: string; scopes?: string[] }

export interface GrantDeps { kv: AppKv; secrets: VaultLike; fetch: FetchLike; now: () => number }

export const GRANT_PREFIX = 'oauth:grant:';
export const grantKey = (appId: string) => `${GRANT_PREFIX}${appId}`;
/** Refresh this long before the access token expires. */
export const EARLY_MS = 60_000;
/** Assumed lifetime when a refreshable answer names none (so a refresh happens now and then). */
const DEFAULT_LIFETIME_MS = 3_600_000;
const WHAT = "The app's sign-in server";
const hostOf = (endpoint: string) => new URL(endpoint).hostname;

/** The checked token answer (Bearer only). */
function tokenAnswer(value: unknown, now: number): TokenAnswer {
  const answer = record(value) ?? {};
  const { access_token: access, token_type: type, refresh_token: refreshValue, scope } = answer;
  if (typeof access !== 'string' || !access || access.length > 16_384) throw new WorkforceError('unavailable', `${WHAT} sent no usable access token.`);
  if (typeof type === 'string' && type.toLowerCase() !== 'bearer') throw new WorkforceError('unavailable', `${WHAT} issued a token type Autark cannot use.`);
  const refresh = typeof refreshValue === 'string' && refreshValue ? refreshValue : undefined;
  const seconds = Number(answer.expires_in);
  const expiresAt = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : refresh ? now + DEFAULT_LIFETIME_MS : undefined;
  const scopes = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean).slice(0, 100) : undefined;
  return { accessToken: access, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(refresh ? { refreshToken: refresh } : {}), ...(scopes ? { scopes } : {}) };
}

async function tokenCall(deps: GrantDeps, client: ClientRef, fields: Record<string, string>): Promise<TokenAnswer> {
  let auth: Awaited<ReturnType<typeof clientAuth>>;
  try { auth = await clientAuth(deps.secrets, client); } catch { throw new OAuthHttpError(401, 'invalid_client'); }
  const now = deps.now();
  return tokenAnswer(await callJson<unknown>(deps.fetch, client.tokenEndpoint, { method: 'POST', form: { ...fields, ...auth.fields }, headers: auth.headers }, WHAT), now);
}

/** The code from the browser → tokens. `invalid_client` forgets the registration (the next sign-in registers again). */
export async function exchangeCode(deps: GrantDeps, client: ClientRef & { issuer: string; resource: string }, answer: { code: string; verifier: string; redirectUri: string }): Promise<TokenAnswer> {
  try {
    return await tokenCall(deps, client, {
      grant_type: 'authorization_code', code: answer.code, code_verifier: answer.verifier, redirect_uri: answer.redirectUri, resource: client.resource,
    });
  } catch (error) {
    if (!(error instanceof OAuthHttpError)) throw error;
    if (error.code === 'invalid_client' || error.code === 'unauthorized_client') dropRegistration(deps.kv, deps.secrets, client.issuer, client.clientId);
    throw new WorkforceError('unavailable', `The sign-in could not be finished (${error.message}). Try again.`);
  }
}

/** Best effort (RFC 7009): tells the server to drop `token`; failures are ignored. */
export async function revokeToken(deps: GrantDeps, grant: Grant, token: string): Promise<void> {
  if (!grant.revocationEndpoint) return;
  try {
    const auth = await clientAuth(deps.secrets, grant);
    await callJson(deps.fetch, grant.revocationEndpoint, {
      method: 'POST', form: { token, token_type_hint: grant.refresh ? 'refresh_token' : 'access_token', ...auth.fields }, headers: auth.headers, timeoutMs: 10_000,
    }, WHAT);
  } catch { /* gone already, or offline */ }
}

/** The grants of the connected apps: KV records, vault entries and access tokens in memory. */
export class Grants {
  private readonly deps: GrantDeps;
  private readonly held = new Map<string, { token: string; expiresAt?: number }>();
  private readonly pending = new Map<string, Promise<string>>();
  /** Bumped by every new or dropped grant, so a refresh that started before writes nothing. */
  private readonly generation = new Map<string, number>();

  constructor(deps: GrantDeps) { this.deps = deps; }

  get(appId: string): Grant | undefined {
    const grant = this.deps.kv.get<Grant>(grantKey(appId));
    return grant && typeof grant.secretId === 'string' ? grant : undefined;
  }

  /** A refresh token is stored, or an access token that has not expired. */
  has(appId: string): boolean {
    const grant = this.get(appId);
    return Boolean(grant && (grant.refresh || grant.expiresAt === undefined || grant.expiresAt > this.deps.now()));
  }

  /** Stores the tokens of a finished sign-in (into the app's existing vault entry when there is one). */
  async save(appId: string, appName: string, base: Omit<Grant, 'secretId' | 'refresh' | 'label' | 'expiresAt'>, answer: TokenAnswer): Promise<void> {
    this.bump(appId);
    await this.settled(appId);
    const previous = this.get(appId);
    const label = `${appName.trim().slice(0, 100) || 'App'} sign-in`;
    const host = hostOf(base.tokenEndpoint);
    const saved = await this.deps.secrets.save({
      ...(previous ? { id: previous.secretId } : {}), label, kind: 'token', value: answer.refreshToken ?? answer.accessToken, source: host,
    });
    const grant: Grant = {
      ...base, secretId: saved.id, refresh: Boolean(answer.refreshToken), label,
      scopes: answer.scopes ?? base.scopes, ...(answer.expiresAt !== undefined ? { expiresAt: answer.expiresAt } : {}),
    };
    this.deps.kv.set(grantKey(appId), grant);
    this.held.set(appId, { token: answer.accessToken, ...(answer.expiresAt !== undefined ? { expiresAt: answer.expiresAt } : {}) });
  }

  /**
   * The Authorization header for the app ({} without a grant, or when `resourceUrl` is not covered by the grant's
   * resource: never a token for another address); refreshes when needed. Throws ReconnectNeeded.
   */
  async header(appId: string, resourceUrl?: string): Promise<Record<string, string>> {
    const grant = this.get(appId);
    if (!grant) return {};
    if (resourceUrl !== undefined && typeof grant.resource === 'string' && !resourceCovers(grant.resource, resourceUrl)) return {};
    const now = this.deps.now();
    const held = this.held.get(appId);
    const margin = grant.refresh ? EARLY_MS : 0;
    if (held && (held.expiresAt === undefined || held.expiresAt - margin > now)) return { authorization: `Bearer ${held.token}` };
    if (!grant.refresh) {
      if (grant.expiresAt !== undefined && grant.expiresAt <= now) { this.drop(appId); throw new ReconnectNeeded(); }
      const token = await this.read(appId, grant);
      this.held.set(appId, { token, ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}) });
      return { authorization: `Bearer ${token}` };
    }
    let running = this.pending.get(appId);
    if (!running) {
      running = this.refresh(appId, grant).finally(() => this.pending.delete(appId));
      this.pending.set(appId, running);
    }
    return { authorization: `Bearer ${await running}` };
  }

  /** Drops the in-memory access token (the server refused it): the next header() refreshes. */
  invalidate(appId: string): void { this.held.delete(appId); }

  /** Revokes (best effort) and deletes the grant and its vault entry. */
  async forget(appId: string): Promise<void> {
    this.bump(appId);
    await this.settled(appId);
    const grant = this.get(appId);
    this.held.delete(appId);
    if (!grant) { this.deps.kv.delete(grantKey(appId)); return; }
    if (grant.revocationEndpoint) {
      let token: string | undefined;
      try { token = await this.deps.secrets.use(grant.secretId, SYSTEM_ID, hostOf(grant.tokenEndpoint)); } catch { token = undefined; }
      if (token) await revokeToken(this.deps, grant, token);
    }
    this.drop(appId);
  }

  private bump(appId: string): void {
    this.generation.set(appId, (this.generation.get(appId) ?? 0) + 1);
  }

  /** Waits for a running refresh (bumped first, so it writes nothing more). */
  private async settled(appId: string): Promise<void> {
    await this.pending.get(appId)?.catch(() => undefined);
  }

  /** Deletes the grant's vault entry and KV record. */
  private drop(appId: string): void {
    const grant = this.get(appId);
    this.held.delete(appId);
    this.deps.kv.delete(grantKey(appId));
    if (grant) { try { this.deps.secrets.remove(grant.secretId); } catch { /* already gone */ } }
  }

  private async read(appId: string, grant: Grant): Promise<string> {
    try { return await this.deps.secrets.use(grant.secretId, SYSTEM_ID, hostOf(grant.tokenEndpoint)); } catch {
      this.drop(appId);
      throw new ReconnectNeeded();
    }
  }

  private async refresh(appId: string, grant: Grant): Promise<string> {
    const generation = this.generation.get(appId) ?? 0;
    const current = () => (this.generation.get(appId) ?? 0) === generation;
    const refreshToken = await this.read(appId, grant);
    let answer: TokenAnswer;
    try {
      answer = await tokenCall(this.deps, grant, { grant_type: 'refresh_token', refresh_token: refreshToken, resource: grant.resource });
    } catch (error) {
      if (!(error instanceof OAuthHttpError)) throw error;
      if (error.status === 400 || error.status === 401 || error.code === 'invalid_grant') {
        if (current()) {
          if (error.code === 'invalid_client' || error.code === 'unauthorized_client') dropRegistration(this.deps.kv, this.deps.secrets, grant.issuer, grant.clientId);
          this.bump(appId);
          this.drop(appId);
        }
        throw new ReconnectNeeded();
      }
      throw new WorkforceError('unavailable', `${WHAT} could not renew the sign-in (${error.message}).`);
    }
    if (!current()) return answer.accessToken; // a new sign-in replaced the grant meanwhile: use once, store nothing
    if (answer.refreshToken && answer.refreshToken !== refreshToken) {
      await this.deps.secrets.save({ id: grant.secretId, label: grant.label, kind: 'token', value: answer.refreshToken, source: hostOf(grant.tokenEndpoint) });
    }
    if (!current()) return answer.accessToken;
    const next: Grant = { ...grant, scopes: answer.scopes ?? grant.scopes };
    if (answer.expiresAt !== undefined) next.expiresAt = answer.expiresAt; else delete next.expiresAt;
    this.deps.kv.set(grantKey(appId), next);
    this.held.set(appId, { token: answer.accessToken, ...(answer.expiresAt !== undefined ? { expiresAt: answer.expiresAt } : {}) });
    return answer.accessToken;
  }
}
