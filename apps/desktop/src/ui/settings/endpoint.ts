// The connection form's model (account-forms.tsx), pure: the same small form for an API key and a local server –
// Provider (shared/model/providers-connect.ts: OpenAI, Anthropic, Google Gemini, OpenRouter, DeepInfra, Groq, Mistral,
// xAI, … and "Other" for any URL; Ollama, LM Studio, llama.cpp, vLLM) → Protocol → API key or URL → Test. All fields are
// always there (nothing moves when the Provider changes): a named service needs its key and shows its fixed URL and
// protocol read-only; "Other" needs a URL and takes a Protocol (a server of one's own on the chat or decision protocol may
// take no key); a local server needs its URL, a key is optional. What it adds (accounts.add / accounts.test, which write
// settings.json's providers) and when it is complete. Switching to another vendor clears a typed key (keyStays).
// Owns: these rules. Never: checks reachability (accounts.test), keeps a key, or renders.

import { PROTOCOL_ABOUT, PROVIDER_PROTOCOLS, protocolOfProvider, providerOfProtocol, type ProviderProtocol } from '../../shared/model/provider-entries.ts';
import type { ProviderId } from '../../shared/model/providers.ts';
import { API_SERVICES, connectService, hostOf, LOCAL_SERVICES, type ConnectService } from '../../shared/model/providers-connect.ts';

/** What a media-only service shows in the Protocol field. */
export const OWN_PROTOCOL = 'own';

const PROTOCOL_NAMES: Readonly<Record<ProviderProtocol, string>> = {
  'openai-chat': 'OpenAI chat', 'openai-responses': 'OpenAI responses', anthropic: 'Anthropic messages', decision: 'Decision',
};

/** The Protocol select's options. */
export const PROTOCOL_OPTIONS: Array<{ value: string; label: string; hint?: string }> = [
  ...PROVIDER_PROTOCOLS.map((protocol) => ({ value: protocol as string, label: PROTOCOL_NAMES[protocol], hint: PROTOCOL_ABOUT[protocol] })),
  { value: OWN_PROTOCOL, label: 'Its own API' },
];

export type FormKind = 'api' | 'local';

/** The Provider list of a form. */
export function servicesOf(kind: FormKind): readonly ConnectService[] {
  return kind === 'api' ? API_SERVICES : LOCAL_SERVICES;
}

/** What the person typed. */
export interface FormInput {
  service: string;
  key: string;
  url: string;
  /** "Other": what the server speaks (default: OpenAI chat). */
  protocol?: ProviderProtocol;
}

/** What accounts.add and accounts.test get (the key only when typed). */
export interface FormTarget {
  provider: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  label: string;
}

export interface FormView {
  service?: ConnectService;
  /** What the Protocol field shows; only "Other" can change it. */
  protocol: string;
  protocolEditable: boolean;
  /** Add needs a key (a named service, a URL on OpenAI's or Anthropic's own protocol). */
  needsKey: boolean;
  /** The person types the URL ("Other", local servers); else it shows the service's fixed URL. */
  urlEditable: boolean;
  /** What the URL field shows. */
  url: string;
  /** Test can list the models (not for a media-only key). */
  testable: boolean;
  /** Complete: Add (and Test) may run. */
  valid: boolean;
  target?: FormTarget;
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');
const isUrl = (raw: string): boolean => hostOf(raw) !== undefined;

/** The form's state for what was typed. */
export function connectionForm(input: FormInput): FormView {
  const service = connectService(input.service);
  if (!service) return { protocol: 'openai-chat', protocolEditable: false, needsKey: false, urlEditable: true, url: input.url, testable: false, valid: false };
  const local = service.kind === 'local';
  const other = !service.base;
  const typedUrl = other || local;
  const protocol = other ? input.protocol ?? 'openai-chat' : protocolOfProvider(service.provider);
  const provider = other ? providerOfProtocol(protocol) : service.provider;
  const needsKey = !local && (!other || protocol === 'anthropic' || protocol === 'openai-responses');
  const url = typedUrl ? trimSlash(input.url) : '';
  const key = input.key.trim();
  const valid = (!typedUrl || isUrl(url)) && (!needsKey || key.length > 0);
  const baseUrl = typedUrl ? url : provider === 'compatible' ? service.base : undefined;
  const label = typedUrl && !local ? hostOf(url) ?? service.name : service.name;
  const target: FormTarget | undefined = valid
    ? { provider, ...(baseUrl ? { baseUrl } : {}), ...(key ? { apiKey: key } : {}), label }
    : undefined;
  return {
    service, protocol: service.kind === 'media' ? OWN_PROTOCOL : protocol, protocolEditable: other, needsKey, urlEditable: typedUrl, url: typedUrl ? input.url : service.base,
    testable: valid && service.kind !== 'media' && protocol !== 'decision', valid, ...(target ? { target } : {}),
  };
}

/** The URL a picked service starts with (a local server's default address; "Other" keeps what was typed). */
export function startUrl(service: string, typed: string): string {
  const picked = connectService(service);
  if (!picked) return typed;
  return picked.kind === 'local' ? picked.base : picked.base ? '' : typed;
}

/**
 * B-059: whether a typed key may stay when the Provider switches from `before` to `after` – only within one vendor
 * (the same host, or "Other" to "Other"); any other switch clears it, so a key is never saved for, or sent to,
 * another vendor.
 */
export function keyStays(before: string, after: string): boolean {
  const from = connectService(before);
  const to = connectService(after);
  if (!from || !to) return !from;
  if (!from.base || !to.base) return !from.base && !to.base;
  return hostOf(from.base) === hostOf(to.base);
}

/** "3 models: a, b, c, …" for a passed Test. */
export function modelsText(models: readonly string[], shown = 3): string {
  if (!models.length) return 'The server is reachable, but lists no models.';
  return `${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, shown).join(', ')}${models.length > shown ? ', …' : ''}`;
}
