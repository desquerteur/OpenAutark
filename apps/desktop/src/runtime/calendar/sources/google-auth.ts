// Google sign-in tokens of a connected calendar (B-041 track G): the code from the loopback consent is exchanged
// (PKCE verifier; Desktop clients still send their client secret) for a refresh token – stored in the vault, usable
// by no agent, saved from oauth2.googleapis.com, like bridges/tokens.ts – and an access token kept in memory only and
// refreshed shortly before it expires (concurrent callers share one refresh). A refresh Google answers with
// invalid_grant (revoked, or a client in "Testing" after 7 days) needs a new consent: ReconnectNeeded.
// Owns: those exchanges and the in-memory access tokens. Never: a token in a log, an error text, the UI or the
// database outside the vault.

import { SYSTEM_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { callJson, formBody, HttpFailure, type FetchFn } from './http.ts';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
/** Refresh this long before Google's expiry. */
const EARLY_MS = 60_000;

export interface GoogleClient { clientId: string; clientSecret?: string }
interface TokenAnswer { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string }

/** The sign-in is gone (revoked or expired): the person connects again. */
export class ReconnectNeeded extends Error {
  constructor() { super('Google sign-in expired. Connect again.'); this.name = 'ReconnectNeeded'; }
}

/** The user-safe error of a failed token call. */
function tokenError(error: unknown): Error {
  if (error instanceof HttpFailure) {
    if (error.code === 'invalid_grant') return new ReconnectNeeded();
    if (error.code === 'invalid_client' || error.code === 'unauthorized_client') return new WorkforceError('bad_request', 'Google refused the client ID or client secret.');
    return new WorkforceError('unavailable', `Google sign-in failed (HTTP ${error.status}).`);
  }
  return error instanceof Error ? error : new WorkforceError('internal', 'Google sign-in failed.');
}

async function tokenCall(fetchFn: FetchFn, fields: Record<string, string | undefined>): Promise<TokenAnswer> {
  try {
    return await callJson<TokenAnswer>(fetchFn, GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody(fields) }, 'Google sign-in');
  } catch (error) { throw tokenError(error); }
}

/** The consent's code → tokens (a refresh token is required: the consent asks for offline access). */
export async function exchangeCode(fetchFn: FetchFn, client: GoogleClient, consent: { code: string; verifier: string; redirectUri: string }, now: number):
  Promise<{ accessToken: string; expiresAt: number; refreshToken: string; scope: string }> {
  const answer = await tokenCall(fetchFn, {
    code: consent.code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: consent.redirectUri, grant_type: 'authorization_code',
    code_verifier: consent.verifier,
  });
  if (!answer.access_token || !answer.refresh_token) throw new WorkforceError('unavailable', 'Google did not grant offline access. Try again.');
  return { accessToken: answer.access_token, expiresAt: now + Math.max(60, answer.expires_in ?? 3600) * 1000, refreshToken: answer.refresh_token, scope: answer.scope ?? '' };
}

/** A new access token for `refreshToken` (and a new refresh token when Google rotates it). */
export async function refreshAccess(fetchFn: FetchFn, client: GoogleClient, refreshToken: string, now: number): Promise<{ accessToken: string; expiresAt: number; refreshToken?: string }> {
  const answer = await tokenCall(fetchFn, { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  if (!answer.access_token) throw new WorkforceError('unavailable', 'Google did not renew the sign-in.');
  return { accessToken: answer.access_token, expiresAt: now + Math.max(60, answer.expires_in ?? 3600) * 1000, ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}) };
}

/** Best effort: tells Google to drop a refresh token (removing the connection); failures are ignored. */
export async function revokeToken(fetchFn: FetchFn, token: string): Promise<void> {
  try { await callJson(fetchFn, GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ token }), timeoutMs: 10_000 }, 'Google'); } catch { /* gone already, or offline */ }
}

/** Saves a refresh token in the vault (a new value into `id` when given); the vault id. */
export async function storeRefreshToken(secrets: RuntimeServices['secrets'], token: string, id?: string): Promise<string> {
  const saved = id
    ? await secrets.save({ id, label: 'Google Calendar sign-in', kind: 'token', value: token })
    : await secrets.save({ label: 'Google Calendar sign-in', kind: 'token', value: token, source: GOOGLE_TOKEN_HOST });
  return saved.id;
}

export interface TokenDeps {
  fetch: FetchFn;
  clock: RuntimeServices['clock'];
  secrets: RuntimeServices['secrets'];
  /** The OAuth client of a source (its id and secret). */
  client(sourceId: string): Promise<GoogleClient>;
}

/** Access tokens of the connected Google sources (memory only). */
export class GoogleTokens {
  private readonly deps: TokenDeps;
  private readonly held = new Map<string, { token: string; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(deps: TokenDeps) { this.deps = deps; }

  /** Keeps the access token the consent returned. */
  hold(sourceId: string, token: string, expiresAt: number): void {
    this.held.set(sourceId, { token, expiresAt });
  }

  /** An access token of the source whose refresh token is vault entry `secretId` (`fresh`: refresh even when one is held). */
  access(sourceId: string, secretId: string, fresh = false): Promise<string> {
    const held = this.held.get(sourceId);
    if (!fresh && held && held.expiresAt - EARLY_MS > this.deps.clock.now()) return Promise.resolve(held.token);
    const running = this.pending.get(sourceId);
    if (running) return running;
    const next = this.renew(sourceId, secretId).finally(() => this.pending.delete(sourceId));
    this.pending.set(sourceId, next);
    return next;
  }

  forget(sourceId: string): void {
    this.held.delete(sourceId);
  }

  private async renew(sourceId: string, secretId: string): Promise<string> {
    let refresh: string;
    try { refresh = await this.deps.secrets.use(secretId, SYSTEM_ID, GOOGLE_TOKEN_HOST); } catch { throw new ReconnectNeeded(); }
    const client = await this.deps.client(sourceId);
    const answer = await refreshAccess(this.deps.fetch, client, refresh, this.deps.clock.now());
    if (answer.refreshToken && answer.refreshToken !== refresh) await storeRefreshToken(this.deps.secrets, answer.refreshToken, secretId);
    this.held.set(sourceId, { token: answer.accessToken, expiresAt: answer.expiresAt });
    return answer.accessToken;
  }
}
