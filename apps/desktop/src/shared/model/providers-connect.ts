// How a connection is added – the one small form (provider → key or URL → Test): the API providers the form lists
// (each with its own provider id, or an OpenAI-compatible address named for it – DeepInfra, Mistral, Kimi, Qwen –,
// plus "Other" for any URL and protocol) and the local servers. Shared by the form (ui/settings/endpoint.ts), the
// comment above settings.json's providers (provider-entries.ts) and the runtime's one-time move of older accounts
// (runtime/accounts/legacy.ts).
// Owns: this table and which service an address or an account belongs to. Never: reachability (accounts.test),
// keys, or I/O.

import type { Account, ProviderId } from './providers.ts';

/** One entry of the form's Provider list. `base` '' = the person types the URL ("Other"). */
export interface ConnectService {
  id: string;
  name: string;
  provider: ProviderId;
  base: string;
  /** 'media': no chat models, no Test (ElevenLabs, fal.ai). */
  kind: 'api' | 'local' | 'media';
  /** Where its API key is made. */
  keyPage?: string;
  /** What the key is good for, one quiet line. */
  note?: string;
}

/** The API key form's Provider list, in this order. */
export const API_SERVICES: readonly ConnectService[] = [
  { id: 'openai', name: 'OpenAI', provider: 'openai', base: 'https://api.openai.com/v1', kind: 'api', keyPage: 'https://platform.openai.com/api-keys', note: 'GPT models, images, transcription, realtime voice' },
  { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', base: 'https://api.anthropic.com/v1', kind: 'api', keyPage: 'https://console.anthropic.com/settings/keys', note: 'Claude models, pay per use' },
  { id: 'google', name: 'Google Gemini', provider: 'google', base: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'api', keyPage: 'https://aistudio.google.com/apikey', note: 'Gemini; images, video, music and speech; hears audio; realtime voice' },
  { id: 'openrouter', name: 'OpenRouter', provider: 'openrouter', base: 'https://openrouter.ai/api/v1', kind: 'api', keyPage: 'https://openrouter.ai/settings/keys', note: 'Hundreds of models with one key' },
  { id: 'deepinfra', name: 'DeepInfra', provider: 'compatible', base: 'https://api.deepinfra.com/v1/openai', kind: 'api', keyPage: 'https://deepinfra.com/dash/api_keys', note: 'Open models at low prices' },
  { id: 'groq', name: 'Groq', provider: 'groq', base: 'https://api.groq.com/openai/v1', kind: 'api', keyPage: 'https://console.groq.com/keys', note: 'Very fast; free transcription (Whisper) with rate limits' },
  { id: 'mistral', name: 'Mistral', provider: 'compatible', base: 'https://api.mistral.ai/v1', kind: 'api', keyPage: 'https://console.mistral.ai/api-keys', note: 'Mistral models' },
  { id: 'xai', name: 'xAI', provider: 'xai', base: 'https://api.x.ai/v1', kind: 'api', keyPage: 'https://console.x.ai', note: 'Grok models' },
  { id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', base: 'https://api.deepseek.com/v1', kind: 'api', keyPage: 'https://platform.deepseek.com/api_keys', note: 'DeepSeek models' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', provider: 'compatible', base: 'https://api.moonshot.ai/v1', kind: 'api', keyPage: 'https://platform.moonshot.ai/console/api-keys', note: 'Kimi models' },
  { id: 'qwen', name: 'Qwen (DashScope)', provider: 'compatible', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', kind: 'api', note: 'Qwen models' },
  { id: 'elevenlabs', name: 'ElevenLabs', provider: 'elevenlabs', base: 'https://api.elevenlabs.io/v1', kind: 'media', keyPage: 'https://elevenlabs.io/app/settings/api-keys', note: 'Speech, music and sound effects (no chat)' },
  { id: 'fal', name: 'fal.ai', provider: 'fal', base: 'https://queue.fal.run', kind: 'media', keyPage: 'https://fal.ai/dashboard/keys', note: 'Video, music, sound effects and images (no chat)' },
  { id: 'other', name: 'Other', provider: 'compatible', base: '', kind: 'api', note: 'Any server: its URL and the protocol it speaks' },
];

/** The Local server form's Provider list. */
export const LOCAL_SERVICES: readonly ConnectService[] = [
  { id: 'ollama', name: 'Ollama', provider: 'ollama', base: 'http://127.0.0.1:11434/v1', kind: 'local' },
  { id: 'lmstudio', name: 'LM Studio', provider: 'lmstudio', base: 'http://127.0.0.1:1234/v1', kind: 'local' },
  { id: 'llamacpp', name: 'llama.cpp', provider: 'llamacpp', base: 'http://127.0.0.1:8080/v1', kind: 'local' },
  { id: 'vllm', name: 'vLLM', provider: 'vllm', base: 'http://127.0.0.1:8000/v1', kind: 'local' },
];

const ALL: readonly ConnectService[] = [...API_SERVICES, ...LOCAL_SERVICES];

/** The service of a form id (undefined: none). */
export function connectService(id: string): ConnectService | undefined {
  return ALL.find((service) => service.id === id);
}

/** host[:port] of an http(s) URL, lower case; undefined for anything else. */
export function hostOf(raw: string | undefined): string | undefined {
  const match = /^https?:\/\/([^/?#@\s]+)/i.exec(raw?.trim() ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/** The named API service whose host an address is on (exact host), if any. */
export function serviceAt(raw: string | undefined): ConnectService | undefined {
  const host = hostOf(raw);
  return host ? API_SERVICES.find((service) => service.base && hostOf(service.base) === host) : undefined;
}

/** The service an account belongs to: its address's named service, else the first entry of its provider. */
export function serviceOfAccount(account: Pick<Account, 'provider' | 'baseUrl'>): ConnectService | undefined {
  const at = serviceAt(account.baseUrl);
  if (at && (at.provider === account.provider || account.provider === 'compatible')) return at;
  if (account.provider === 'compatible') return undefined;
  return ALL.find((service) => service.provider === account.provider && service.base);
}
