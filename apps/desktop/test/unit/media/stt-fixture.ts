// Fixture for agent hearing (MM1): the media setup (chat harness, real blob store, media
// library) plus a real Transcriber as RuntimeServices.stt with an injected fake fetch for
// /audio/transcriptions, a local speech-to-text model in the catalog (or none / turned off),
// a secret redactor and a Context for delta()/prepare().
// Owns: fixtures only. Never: imported by production code, reaches the network.

import { Context } from '../../../src/runtime/context/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { Transcriber, type FetchFn } from '../../../src/runtime/voice/transcribe.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { mediaSetup } from './setup.ts';

export const STT_ACCOUNT: Account = {
  id: 'acc_stt', provider: 'vllm', label: 'Local whisper', auth: 'local', baseUrl: 'http://127.0.0.1:9100/v1',
  state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1,
} as Account;

const WHISPER: ModelInfo = {
  id: 'vllm:whisper-1', provider: 'vllm', model: 'whisper-1', name: 'Whisper', engine: 'compatible', efforts: [], caps: {},
  tier: 'local', strengths: {}, available: true, accounts: [STT_ACCOUNT.id], functions: ['stt'],
} as ModelInfo;

export interface SttCalls {
  count: number;
  /** Most transcriptions in flight at the same time. */
  maxActive: number;
  urls: string[];
  models: string[];
}

export function sttSetup(options: { stt?: 'ready' | 'off' | 'missing'; respond?: (call: number) => Response | Promise<Response> } = {}) {
  const base = mediaSetup();
  const state = options.stt ?? 'ready';
  const services = base.h.services as Record<string, unknown> & RuntimeServices;
  Object.assign(services, {
    settings: {
      get: () => ({
        profile: { name: 'Alex', timezone: 'Europe/Berlin' },
        voice: { vocabulary: [] },
        routing: { functions: state === 'off' ? { stt: 'off' } : {} },
      }),
    },
    catalog: { list: () => (state === 'missing' ? [] : [WHISPER]), get: (id: string) => (id === WHISPER.id ? WHISPER : undefined) },
    accounts: { get: (id: string) => (id === STT_ACCOUNT.id ? STT_ACCOUNT : undefined), candidates: () => [STT_ACCOUNT], apiKey: async () => undefined },
    secrets: { redact: (text: string) => text.replaceAll('hunter2', 'secret://sec_pw') },
  });
  const calls: SttCalls = { count: 0, maxActive: 0, urls: [], models: [] };
  let active = 0;
  const fetch: FetchFn = async (url, init) => {
    calls.count++;
    active++;
    calls.maxActive = Math.max(calls.maxActive, active);
    calls.urls.push(url);
    calls.models.push(String((init.body as FormData).get('model')));
    try {
      await new Promise((resolve) => setImmediate(resolve)); // a window in which a second request could overlap
      return options.respond ? await options.respond(calls.count) : new Response(JSON.stringify({ text: `Heard recording ${calls.count}` }));
    } finally {
      active--;
    }
  };
  const stt = new Transcriber({ services: () => services, fetch });
  services.stt = stt;
  const context = new Context({ services: () => services, runner: false });
  services.context = context;
  return { ...base, services, stt, context, calls };
}

export const transcriptResponse = (text: string) => new Response(JSON.stringify({ text }), { status: 200 });
