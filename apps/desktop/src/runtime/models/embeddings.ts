// Which embedding model serves the use "embeddings" (settings.json routing.embeddings). "auto": this PC's small model, else
// an embedding model of a local server (Ollama, LM Studio …), else a connected API key whose service embeds (a listed
// embedding model, else the service's usual one); "off": none; a model id "<account or provider>:<model>", listed or not: that model, and only
// that – vectors of two models do not compare, so a choice that is unreachable says so instead of falling to another.
// Owns: that order and the usual model per service. Never: embeds, stores or reads keys.

import type { RuntimeServices } from '../contracts.ts';
import { servesUse, useValue, USE_AUTO, USE_OFF } from '../../shared/model/models-uses.ts';
import { DECISION_PROVIDER, type Account } from '../../shared/model/providers.ts';
import { endpointFor, LOCAL_PROVIDERS } from '../engines/http/common.ts';

export type EmbeddingChoice =
  | { kind: 'local' }
  | { kind: 'http'; accountId: string; provider: string; baseUrl: string; model: string; local: boolean };

/** The name settings.json takes for this PC's own model. */
export const LOCAL_CHOICE = 'local';

/** API hosts and the embedding model used there when the connection lists none (cheapest good one first). */
const USUAL_MODELS: ReadonlyArray<{ host: string; model: string }> = [
  { host: 'api.deepinfra.com', model: 'Qwen/Qwen3-Embedding-8B' },
  { host: 'openrouter.ai', model: 'qwen/qwen3-embedding-8b' },
  { host: 'api.openai.com', model: 'text-embedding-3-small' },
  { host: 'api.siliconflow.com', model: 'Qwen/Qwen3-Embedding-8B' },
  { host: 'api.jina.ai', model: 'jina-embeddings-v5-text-small' },
];

type Services = Pick<RuntimeServices, 'catalog' | 'accounts' | 'settings'>;

const usable = (account: Account): boolean => account.enabled && account.auth !== 'cli' && account.provider !== DECISION_PROVIDER && account.state !== 'needs_login' && account.state !== 'disabled';
const isLocal = (account: Account): boolean => account.auth === 'local' || LOCAL_PROVIDERS.has(account.provider);

function endpoint(account: Account): string | undefined {
  try { return endpointFor(account); } catch { return undefined; }
}

function viaAccount(account: Account, model: string): EmbeddingChoice | undefined {
  const baseUrl = endpoint(account);
  return baseUrl ? { kind: 'http', accountId: account.id, provider: account.provider, baseUrl, model, local: isLocal(account) } : undefined;
}

/** Embedding models the connections list, local servers first, each with its account. */
function listed(s: Services): Array<{ account: Account; model: string }> {
  let models: ReturnType<Services['catalog']['list']>;
  try { models = s.catalog.list(); } catch { models = []; }
  const accounts = s.accounts.list().filter(usable);
  const found = models.filter((model) => model.available && servesUse(model, 'embeddings')).flatMap((model) => {
    const account = accounts.find((entry) => entry.provider === model.provider && (!model.accounts.length || model.accounts.includes(entry.id)));
    return account ? [{ account, model: model.model }] : [];
  });
  return [...found.filter((entry) => isLocal(entry.account)), ...found.filter((entry) => !isLocal(entry.account))];
}

/** The usual model of a connected API key's service. */
function usual(s: Services): EmbeddingChoice | undefined {
  const accounts = s.accounts.list().filter((account) => usable(account) && !isLocal(account));
  for (const { host, model } of USUAL_MODELS) {
    for (const account of accounts) {
      const base = endpoint(account);
      if (base && new URL(base).hostname === host) return viaAccount(account, model);
    }
  }
  return undefined;
}

/** What serves embeddings now; undefined = off or nothing connected. `localPossible`: this PC can run its own model. */
export function embeddingChoice(s: Services, localPossible: boolean): EmbeddingChoice | undefined {
  let value: string;
  try { value = useValue(s.settings.get().routing, 'embeddings'); } catch { return undefined; }
  if (value === USE_OFF) return undefined;
  if (value === LOCAL_CHOICE) return localPossible ? { kind: 'local' } : undefined;
  if (value !== USE_AUTO) {
    const at = value.indexOf(':');
    const owner = at > 0 ? value.slice(0, at) : undefined; // an account the file names, or a provider
    const model = at > 0 ? value.slice(at + 1) : value;
    const own = owner ? s.accounts.list().find((entry) => usable(entry) && entry.id === owner) : undefined;
    if (own) return viaAccount(own, model);
    const known = listed(s).find((entry) => entry.model === model && (!owner || entry.account.provider === owner));
    if (known) return viaAccount(known.account, known.model);
    const account = owner ? s.accounts.list().find((entry) => usable(entry) && entry.provider === owner) : undefined;
    return account ? viaAccount(account, model) : undefined;
  }
  if (localPossible) return { kind: 'local' };
  const first = listed(s)[0];
  if (first) return viaAccount(first.account, first.model);
  return usual(s);
}
