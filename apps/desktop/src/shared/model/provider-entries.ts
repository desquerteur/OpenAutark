// The `providers` section of settings.json: one entry per API connection, the one place a connection is written down
// (the person's form, an agent and a text editor write the same thing; the accounts table keeps only state and limits).
//   "deepinfra": { "name": "DeepInfra", "protocol": "openai-chat", "url": "https://…", "key": "secret://<id>",
//                  "models": ["extra-model", { "id": "x", "uses": ["embeddings"] }] }
// The entry's id is the account's id, and a value "deepinfra:model" names that account. Protocols: how the server is
// spoken to; a known address (shared/model/providers-connect.ts) keeps its service's own provider and quirks, and an id of
// that table may leave out what the table knows. `models` adds to what the server lists, and `uses` says what a model is
// for when its name does not tell.
// Owns: these shapes, what an entry means as a connection, the comment settings.json shows above the section, and which
// prefix a model id of an account carries. Never: I/O, keys, or reconciling accounts (runtime/accounts/provider-file.ts).

import type { Account, AccountAuth, ProviderId } from './providers.ts';
import { DECISION_PROVIDER } from './providers.ts';
import { API_SERVICES, connectService, hostOf, LOCAL_SERVICES, serviceAt, type ConnectService } from './providers-connect.ts';
import { MODEL_USES, WORK_PLAN_PROVIDERS, USE_AUTO, USE_LOCAL, USE_OFF, type ModelUse } from './models-uses.ts';

export const PROVIDER_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic', 'decision'] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/** One line per protocol: what the server has to answer. */
export const PROTOCOL_ABOUT: Readonly<Record<ProviderProtocol, string>> = {
  'openai-chat': 'POST <url>/chat/completions with messages, GET <url>/models – what most servers speak',
  'openai-responses': 'POST <url>/responses, GET <url>/models – OpenAI\'s own',
  anthropic: 'POST <url>/messages with an x-api-key header, GET <url>/models',
  decision: 'POST <url>/systemone: typed choice, score and yes/no answers with confidence; serves routing.decision only, list its model under models',
};

export interface ProviderModelEntry { id: string; name?: string; uses?: ModelUse[] }

export interface ProviderEntry {
  name?: string;
  protocol?: ProviderProtocol;
  url?: string;
  /** A handle of the secrets catalog, secret://<id>; absent: a server without a key. */
  key?: string;
  models?: Array<string | ProviderModelEntry>;
}

export type ProviderEntries = Readonly<Record<string, ProviderEntry>>;

/** An entry's id: what comes before the colon of a model value. */
export const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const KEY_HANDLE = /^secret:\/\/[A-Za-z0-9_-]+$/;
/** Ids a use's value already means something else with. */
const RESERVED: ReadonlySet<string> = new Set<string>([USE_AUTO, USE_OFF, USE_LOCAL, ...WORK_PLAN_PROVIDERS]);
export const providerIdFree = (id: string): boolean => PROVIDER_ID.test(id) && !RESERVED.has(id);

/** What an entry makes of the account row. */
export type EntryConnection = Pick<Account, 'provider' | 'label' | 'auth' | 'baseUrl' | 'secretId'>;

/** The protocol a provider id speaks. */
export function protocolOfProvider(provider: ProviderId): ProviderProtocol {
  if (provider === 'openai') return 'openai-responses';
  if (provider === 'anthropic') return 'anthropic';
  return provider === DECISION_PROVIDER ? 'decision' : 'openai-chat';
}

/** The provider id a typed "Other" URL gets from its protocol. */
export function providerOfProtocol(protocol: ProviderProtocol): ProviderId {
  if (protocol === 'openai-responses') return 'openai';
  if (protocol === 'anthropic') return 'anthropic';
  return protocol === 'decision' ? DECISION_PROVIDER : 'compatible';
}

const localAt = (url: string | undefined): ConnectService | undefined => {
  const host = hostOf(url);
  return host ? LOCAL_SERVICES.find((service) => hostOf(service.base) === host) : undefined;
};

/** The table's service an entry id stands for ("deepinfra", also a second one "deepinfra-2"). */
const serviceOfId = (id: string): ConnectService | undefined => {
  const service = connectService(id) ?? connectService(id.replace(/-\d+$/, ''));
  return service?.base ? service : undefined;
};

/** The account an entry means, or why it cannot be one. */
export function entryConnection(id: string, entry: ProviderEntry): EntryConnection | { problem: string } {
  const named = serviceOfId(id);
  const protocol = entry.protocol ?? (named ? protocolOfProvider(named.provider) : 'openai-chat');
  const url = entry.url?.trim().replace(/\/+$/, '') || named?.base;
  if (!url && (protocol === 'openai-chat' || protocol === 'decision')) return { problem: `${id} needs a url` };
  let provider = providerOfProtocol(protocol);
  if (protocol === 'openai-chat') { // a known address keeps its service's provider and quirks; OpenAI's and Anthropic's own speak other protocols
    const service = serviceAt(url) ?? localAt(url) ?? named;
    if (service && service.provider !== 'openai' && service.provider !== 'anthropic') provider = service.provider;
  }
  const local = localAt(url) !== undefined || named?.kind === 'local';
  const key = entry.key?.trim();
  const auth: AccountAuth = local ? 'local' : key ? 'api_key' : 'none';
  return { provider, label: entry.name?.trim().slice(0, 80) || named?.name || id, auth, ...(url ? { baseUrl: url } : {}), ...(key ? { secretId: key } : {}) };
}

/** An entry's models, each as an object. */
export function entryModels(entry: ProviderEntry | undefined): ProviderModelEntry[] {
  return (entry?.models ?? []).map((model) => (typeof model === 'string' ? { id: model } : model));
}

/** Why an entry cannot stand in the file (undefined: it can). The url's own rules are the runtime's. */
export function entryProblem(id: string, value: unknown): string | undefined {
  if (!providerIdFree(id)) return `${id}: an id of lower case letters, digits and dashes, none of ${[...RESERVED].join(', ')}`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${id}: an object`;
  const entry = value as Record<string, unknown>;
  const stray = Object.keys(entry).find((key) => !['name', 'protocol', 'url', 'key', 'models'].includes(key));
  if (stray) return `${id}.${stray}: name, protocol, url, key or models`;
  for (const key of ['name', 'url', 'key'] as const) if (entry[key] !== undefined && typeof entry[key] !== 'string') return `${id}.${key}: text`;
  if (entry.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly unknown[]).includes(entry.protocol)) return `${id}.protocol: ${PROVIDER_PROTOCOLS.join(' | ')}`;
  if (typeof entry.key === 'string' && !KEY_HANDLE.test(entry.key.trim())) return `${id}.key: a handle secret://<id> of the secrets catalog (the value itself stays out of this file)`;
  if (entry.models !== undefined && !Array.isArray(entry.models)) return `${id}.models: a list`;
  for (const model of (entry.models ?? []) as unknown[]) {
    const item = typeof model === 'string' ? { id: model } : model as ProviderModelEntry | null;
    if (typeof item?.id !== 'string' || !/^[^\s\u0000-\u001f]{1,200}$/.test(item.id)) return `${id}.models: a model name without spaces, or { "id": … }`;
    if (item.uses !== undefined && (!Array.isArray(item.uses) || item.uses.some((use) => !MODEL_USES.includes(use)))) return `${id}.models: uses from ${MODEL_USES.join(', ')}`;
  }
  const connection = entryConnection(id, entry as ProviderEntry);
  return 'problem' in connection ? connection.problem : undefined;
}

/** The prefix of an account's model ids: its entry id when the file names it, else its provider. */
export function modelOwner(account: Pick<Account, 'id' | 'provider'>, entries: ProviderEntries | undefined): string {
  return entries && Object.hasOwn(entries, account.id) ? account.id : account.provider;
}

/** The comment above the section in settings.json: the format, the protocols and every service the app knows. */
export function providerNotes(): string[] {
  const row = (service: ConnectService) => `  ${service.id} | ${service.base} | ${service.kind === 'media' ? 'its own (leave it out)' : protocolOfProvider(service.provider)}${service.keyPage ? ` | ${service.keyPage}` : ''}`;
  return [
    'One entry per connection: "<id>": { "name": "…", "protocol": "…", "url": "…", "key": "secret://<id>", "models": ["extra", { "id": "x", "uses": ["embeddings"] }] }',
    'The id names the account: routing.<use> "<id>:<model>" takes that model on it, also one the server does not list. Skill ai-providers walks through it.',
    'An id of the table below may leave out its url and protocol. models adds names; uses says what a model is for when its name does not tell.',
    'Plans and logins found on this PC are not listed here, they stay detected.',
    'Protocols:',
    ...PROVIDER_PROTOCOLS.map((protocol) => `  ${protocol}: ${PROTOCOL_ABOUT[protocol]}`),
    'Known services (id | url | protocol | key page):',
    ...[...API_SERVICES, ...LOCAL_SERVICES].filter((service) => service.base).map(row),
  ];
}
