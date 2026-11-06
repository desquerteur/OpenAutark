// What a new key or server connection stores (split from service.ts): the checked server URL, the
// API key handed to the vault (only its secret id is kept), a handle `secret://<id>` of an entry of the catalog
// (kept as that handle: the entry stays the person's and removing the account leaves it) or – PR5 – the name of the
// environment variable that holds the key (env-keys.ts).
// Owns: the checks accounts.add runs for API keys, servers and environment keys, and the handle form.
// Never: keeps a key value – the vault stores a typed key, an environment key is never stored.

import { DECISION_PROVIDER, type Account, type ProviderId } from '../../shared/model/providers.ts';
import type { SecretInfo } from '../../shared/model/security.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { endpointFor, LOCAL_PROVIDERS } from '../engines/http/common.ts';
import { envKeyProblem } from './env-keys.ts';

export interface SecretPort {
  save(input: { label: string; kind: SecretInfo['kind']; value: string; hint?: string }): Promise<{ id: string }>;
  read(id: string): Promise<string | undefined>; // in-process only (HTTP engines)
  remove(id: string): void;
}

export interface ConnectionInput { provider: ProviderId; label: string; apiKey?: string; baseUrl?: string; envVar?: string }

export type Connection = Pick<Account, 'auth' | 'baseUrl' | 'secretId' | 'envVar' | 'detected'>;

const HANDLE = /^secret:\/\/([A-Za-z0-9_-]+)$/;

/** The catalog id of a `secret://<id>` handle; undefined for anything else (a typed key, a plain stored id). */
export function handleId(value: string | undefined): string | undefined {
  return value ? HANDLE.exec(value.trim())?.[1] : undefined;
}

/** The vault id behind an account's `secretId` – its own key's id, or the catalog entry its handle names. */
export const vaultId = (secretId: string): string => handleId(secretId) ?? secretId;

/** The value a handle stands for, or the clear error when no entry holds one. */
export async function handleValue(handle: string, secrets: Pick<SecretPort, 'read'>): Promise<string> {
  const value = await secrets.read(vaultId(handle));
  if (!value) throw new WorkforceError('bad_request', `No stored value for ${handle.trim()}. Check the handle with the secrets list.`);
  return value;
}

/** Checks a key, server or environment-key connection; a typed key goes to the vault first, a handle stays a handle. */
export async function connection(input: ConnectionInput, deps: { env: NodeJS.ProcessEnv; secrets: Pick<SecretPort, 'save' | 'read'> }): Promise<Connection> {
  const { provider } = input;
  if (input.envVar !== undefined) {
    if (input.apiKey || input.baseUrl) throw new WorkforceError('bad_request', 'Use either the key from the environment or your own key and server.');
    const problem = envKeyProblem(provider, input.envVar, deps.env);
    if (problem) throw new WorkforceError('bad_request', problem);
    return { auth: 'env', envVar: input.envVar, detected: true }; // found on this PC; its provider's own endpoint only
  }
  const local = LOCAL_PROVIDERS.has(provider);
  const baseUrl = input.baseUrl?.trim() || undefined;
  if (baseUrl || provider === 'compatible' || provider === DECISION_PROVIDER || local) {
    try { endpointFor({ provider, baseUrl }); }
    catch (error) { throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'Enter a valid server URL.'); }
  }
  if (!local && provider !== 'compatible' && provider !== DECISION_PROVIDER && !input.apiKey) throw new WorkforceError('bad_request', 'Enter an API key for this connection.');
  if (!input.apiKey) return { auth: local ? 'local' : 'none', baseUrl, detected: false };
  if (handleId(input.apiKey)) {
    await handleValue(input.apiKey, deps.secrets);
    return { auth: local ? 'local' : 'api_key', baseUrl, secretId: input.apiKey.trim(), detected: false };
  }
  const key = input.apiKey.trim().slice(0, 4096);
  const secret = await deps.secrets.save({ label: `${input.label} key`, kind: 'api_key', value: key, hint: key.length > 8 ? key.slice(-4) : undefined });
  return { auth: local ? 'local' : 'api_key', baseUrl, secretId: secret.id, detected: false };
}
