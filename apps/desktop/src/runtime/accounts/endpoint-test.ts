// "Test" in the API key form (B-044, accounts.test): lists an endpoint's models before it is saved,
// through the engine its provider uses (OpenAI-compatible or Anthropic-compatible), with a throwaway
// account. The key – typed, or the value behind a handle `secret://<id>` – lives only in `keys`
// (AccountService.apiKey reads it) for this one call.
// Owns: the throwaway account and the user-safe answer. Never: stores the key or the account, logs
// either, or echoes provider bodies (engines/http/common.ts gives fixed messages).

import { randomUUID } from 'node:crypto';
import type { Account, EngineId, ProviderId } from '../../shared/model/providers.ts';
import type { Engine } from '../engines/types.ts';
import { endpointFor, HttpEngineError } from '../engines/http/common.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { engineFor } from './candidates.ts';
import { handleId, handleValue, type SecretPort } from './connect.ts';

export interface EndpointTestInput { provider: ProviderId; baseUrl?: string; apiKey?: string }

export interface EndpointTestDeps {
  engine(id: EngineId): Engine;
  /** Throwaway account id → its key while the test runs (AccountService.apiKey reads it). */
  keys: Map<string, string>;
  /** Reads the value behind a handle. */
  secrets: Pick<SecretPort, 'read'>;
  now(): number;
  /** Demo/test mode: the fake engine serves 'compatible' (as for accounts). */
  demo?: boolean;
}

const HTTP_ENGINES: ReadonlySet<EngineId> = new Set<EngineId>(['openai', 'anthropic', 'compatible']);
/** At most this many model ids come back (the form shows the count and a few names). */
export const TEST_MODELS = 200;

export async function testEndpoint(input: EndpointTestInput, deps: EndpointTestDeps): Promise<{ models: string[] }> {
  const engineId = engineFor(input.provider);
  if (!engineId || !HTTP_ENGINES.has(engineId)) throw new WorkforceError('bad_request', 'Only an API endpoint can be tested.');
  const baseUrl = input.baseUrl?.trim() || undefined;
  try { endpointFor({ provider: input.provider, baseUrl }); }
  catch (error) { throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'Enter a valid server URL.'); }
  const key = handleId(input.apiKey) ? await handleValue(input.apiKey!, deps.secrets) : input.apiKey?.trim().slice(0, 4096) || undefined;
  const account: Account = {
    id: `test_${randomUUID()}`, provider: input.provider, label: 'Test', auth: key ? 'api_key' : 'none', baseUrl,
    state: 'unknown', priority: 0, rotation: false, enabled: true, detected: false, createdAt: deps.now(),
  };
  if (key) deps.keys.set(account.id, key);
  try {
    const engine = deps.engine(deps.demo && input.provider === 'compatible' ? 'fake' : engineId);
    const models = await engine.listModels(account);
    return { models: models.map((model) => model.model).slice(0, TEST_MODELS) };
  } catch (error) {
    throw new WorkforceError('unavailable', error instanceof HttpEngineError ? error.data.message : 'The server did not answer with a model list.');
  } finally {
    deps.keys.delete(account.id);
  }
}
