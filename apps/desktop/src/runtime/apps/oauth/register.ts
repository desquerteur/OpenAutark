// MCP authorization (B-052 track B): Workforce's client registration at an authorization server – Dynamic Client
// Registration (RFC 7591) as a native client (`application_type: native`, the loopback redirect) – a public one
// (`token_endpoint_auth_method: none`) unless the server lists only secret methods (then client_secret_basic, else
// _post); the method used is the answer's when it names one we know ('none' stays none even with a secret), else the
// one asked for. Stored per issuer in the apps KV namespace and reused (re-registering can orphan earlier grants at
// some servers), replaced only when the redirect changed, its secret expired, or the server forgot it (index.ts: a
// sign-in with a reused registration that never came back; the last grant using it was forgotten).
// A client secret the server insists on goes to the vault (saved from the token host); the KV
// record keeps its vault id only. Also: the client authentication of token calls.
// Owns: registrations and client authentication. Never: a client secret outside the vault, in a log or an error.

import { SYSTEM_ID } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { SecretService } from '../../contracts/safety.ts';
import type { AppKv } from '../types.ts';
import type { AuthServer } from './discover.ts';
import { callJson, OAuthHttpError, record, type FetchLike } from './http.ts';

export type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export type VaultLike = Pick<SecretService, 'save' | 'use' | 'remove'>;

export interface Registration {
  issuer: string;
  clientId: string;
  /** The redirect it was registered with (the loopback port is part of it). */
  redirectUri: string;
  authMethod: AuthMethod;
  /** Vault id of a client secret, when the server issued one. */
  secretId?: string;
  /** When that secret expires (ms; absent: never). */
  secretExpiresAt?: number;
  registeredAt: number;
}

/** What a token call needs to authenticate the client (a grant keeps a copy, so a newer registration never breaks it). */
export interface ClientRef { clientId: string; authMethod: AuthMethod; clientSecretId?: string; tokenEndpoint: string }

export const CLIENT_PREFIX = 'oauth:client:';
export const clientKey = (issuer: string) => `${CLIENT_PREFIX}${issuer}`;
const WHAT = "The app's sign-in server";

/** The stored registration at `issuer`, unless its client secret expired. */
export function storedRegistration(kv: AppKv, issuer: string, now: number): Registration | undefined {
  const found = kv.get<Registration>(clientKey(issuer));
  if (!found || typeof found.clientId !== 'string') return undefined;
  return found.secretExpiresAt !== undefined && found.secretExpiresAt <= now ? undefined : found;
}

/** Whether a stored grant still authenticates with this client secret (then it stays in the vault). */
function secretInUse(kv: AppKv, secretId: string): boolean {
  return kv.keys('oauth:grant:').some((key) => kv.get<{ clientSecretId?: string }>(key)?.clientSecretId === secretId);
}

/** Forgets the registration at `issuer` (only that `clientId`, when given); its secret too unless a grant uses it. */
export function dropRegistration(kv: AppKv, secrets: VaultLike, issuer: string, clientId?: string): void {
  const found = kv.get<Registration>(clientKey(issuer));
  if (!found || (clientId !== undefined && found.clientId !== clientId)) return;
  kv.delete(clientKey(issuer));
  if (found.secretId && !secretInUse(kv, found.secretId)) { try { secrets.remove(found.secretId); } catch { /* already gone */ } }
}

/** The method to register with: 'none' when the server lists it (or lists nothing), else a secret method it lists. */
export function askedAuthMethod(supported: readonly string[] | undefined): AuthMethod {
  if (!supported || supported.includes('none')) return 'none';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  return supported.includes('client_secret_post') ? 'client_secret_post' : 'none';
}

/** The method token calls use, from the registration's answer (see the header). */
export function authMethodOf(value: unknown, hasSecret: boolean, asked: AuthMethod, supported?: readonly string[]): AuthMethod {
  if (!hasSecret || value === 'none') return 'none';
  if (value === 'client_secret_post' || value === 'client_secret_basic') return value;
  if (asked !== 'none') return asked;
  return supported && !supported.includes('client_secret_basic') && supported.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
}

/** Registers Workforce at `server` for `redirectUri` and stores the registration (replacing an older one). */
export async function register(
  deps: { fetch: FetchLike; kv: AppKv; secrets: VaultLike; now: number; clientName: string },
  server: AuthServer,
  redirectUri: string,
): Promise<Registration> {
  if (!server.registrationEndpoint) throw new WorkforceError('unavailable', "The app's sign-in server does not register new apps.");
  const grants = server.grantTypesSupported;
  const refresh = !grants || grants.includes('refresh_token');
  const asked = askedAuthMethod(server.authMethodsSupported);
  let answer: Record<string, unknown> | undefined;
  try {
    answer = record(await callJson<unknown>(deps.fetch, server.registrationEndpoint, {
      method: 'POST',
      json: {
        client_name: deps.clientName.slice(0, 80),
        redirect_uris: [redirectUri],
        grant_types: refresh ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: asked,
        application_type: 'native',
      },
    }, WHAT));
  } catch (error) {
    if (error instanceof OAuthHttpError) throw new WorkforceError('unavailable', `${WHAT} refused to register Autark (${error.message}).`);
    throw error;
  }
  const data = answer ?? {};
  const clientId = data.client_id;
  if (typeof clientId !== 'string' || !clientId || clientId.length > 500) throw new WorkforceError('unavailable', `${WHAT} sent a registration that could not be read.`);
  const issued = typeof data.client_secret === 'string' && data.client_secret ? data.client_secret : undefined;
  const authMethod = authMethodOf(data.token_endpoint_auth_method, Boolean(issued), asked, server.authMethodsSupported);
  const secret = authMethod === 'none' ? undefined : issued; // a secret the method never uses is not kept
  const expiresIn = data.client_secret_expires_at;
  const expires = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn * 1000 : undefined;
  dropRegistration(deps.kv, deps.secrets, server.issuer);
  let secretId: string | undefined;
  if (secret) {
    const host = new URL(server.tokenEndpoint).hostname;
    secretId = (await deps.secrets.save({ label: `Sign-in registration at ${host}`.slice(0, 120), kind: 'token', value: secret, source: host })).id;
  }
  const registration: Registration = {
    issuer: server.issuer, clientId, redirectUri, authMethod,
    ...(secretId ? { secretId } : {}), ...(expires && secret ? { secretExpiresAt: expires } : {}), registeredAt: deps.now,
  };
  deps.kv.set(clientKey(server.issuer), registration);
  return registration;
}

/** The form fields and headers that authenticate `client` at its token (or revocation) endpoint. */
export async function clientAuth(secrets: VaultLike, client: ClientRef): Promise<{ fields: Record<string, string>; headers: Record<string, string> }> {
  if (client.authMethod === 'none' || !client.clientSecretId) return { fields: { client_id: client.clientId }, headers: {} };
  const secret = await secrets.use(client.clientSecretId, SYSTEM_ID, new URL(client.tokenEndpoint).hostname);
  if (client.authMethod === 'client_secret_post') return { fields: { client_id: client.clientId, client_secret: secret }, headers: {} };
  const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`, 'utf8').toString('base64');
  return { fields: {}, headers: { authorization: `Basic ${basic}` } };
}
