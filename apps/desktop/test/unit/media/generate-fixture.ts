// Fixture for the media generation tests (MM3, B-058 G11–G13): accounts and function models for the target
// pick, a recording fake fetch, a local 127.0.0.1 OpenAI-compatible server, a fake adapter (music, sound,
// video), a fake Codex engine (the plan image), a fake local voice and the media tools on the media harness
// with a recording spend ledger.
// Owns: fixtures only. Never: imported by production code, a real provider or the network beyond 127.0.0.1.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetchFn, GenerateServices } from '../../../src/runtime/media/generate.ts';
import type { Generated, GenerationContext, GenerationKind, GenerationRequest, MediaAdapter } from '../../../src/runtime/media/providers/types.ts';
import type { EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import { mediaTools } from '../../../src/runtime/tools/builtin/media.ts';
import type { ActionDescription, ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Account, ModelFunction, ModelInfo } from '../../../src/shared/model/providers.ts';
import { mediaSetup } from './setup.ts';

export const KEY = 'sk-test-generate-123';
export const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 7)]);
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)]);

export function account(id: string, auth: Account['auth'], baseUrl: string, provider: Account['provider'] = auth === 'api_key' ? 'openai' : 'vllm', extra: Partial<Account> = {}): Account {
  return { id, provider, label: id, auth, baseUrl, state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1, ...extra } as Account;
}

export function model(id: string, fn: ModelFunction, accountId: string, provider: string, engine = 'compatible'): ModelInfo {
  return {
    id, provider, model: id.split(':')[1], name: id, engine, efforts: [], caps: {}, tier: 'local', strengths: {},
    available: true, accounts: [accountId], functions: [fn],
  } as unknown as ModelInfo;
}

/** Catalog, accounts and settings for one image model (`imageModel`) and one speech model on `accounts[0]`, plus `more` models. */
export function services(accounts: Account[], functions: Record<string, string> = {}, imageModel = 'gpt-image-1', more: ModelInfo[] = []): GenerateServices {
  const first = accounts[0];
  const models = first.provider === 'codex' ? more : [model(`${first.provider}:${imageModel}`, 'image', first.id, first.provider), model(`${first.provider}:tts-1`, 'tts', first.id, first.provider), ...more];
  return {
    catalog: { list: () => models, get: (id: string) => models.find((entry) => entry.id === id) },
    accounts: {
      get: (id: string) => accounts.find((entry) => entry.id === id),
      candidates: () => accounts,
      apiKey: async (id: string) => (accounts.find((entry) => entry.id === id)?.auth === 'api_key' ? KEY : undefined),
    },
    settings: { get: () => ({ routing: { functions, allowPaidFallback: true }, voice: {}, profile: { language: 'en' } }) },
  } as unknown as GenerateServices;
}

export function recorder(respond: (url: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string>; redirect?: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, headers: init.headers as Record<string, string>, redirect: init.redirect });
    return respond(url, body);
  };
  return { calls, fetch };
}

export const imageAnswer = (bytes: Uint8Array, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(bytes).toString('base64'), ...extra }] }), { headers: { 'content-type': 'application/json' } });

/** A 200 answer whose body sends a few bytes and then never ends. */
export const endlessAnswer = (type = 'audio/mpeg') => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(32)); } }), { headers: { 'content-type': type } });

type Answer = { status?: number; type: string; body: Buffer | string } | ((res: ServerResponse) => void);

/** A local OpenAI-compatible server; `handler` answers, or takes the response itself (e.g. to stall). */
export async function listen(handler: (req: IncomingMessage, body: Record<string, unknown>) => Answer): Promise<{ server: Server; base: string; seen: Array<Record<string, unknown>> }> {
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      seen.push({ path: req.url, auth: req.headers.authorization, ...body });
      const answer = handler(req, body);
      if (typeof answer === 'function') { answer(res); return; }
      res.writeHead(answer.status ?? 200, { 'content-type': answer.type });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

/** A fake media adapter for `kinds`: records every estimate and call; `make` answers (default: MP3 / MP4 bytes). */
export function fakeAdapter(kinds: GenerationKind[], make?: (kind: GenerationKind, request: GenerationRequest, ctx: GenerationContext) => Promise<Generated>, price = 0.3) {
  const estimates: Array<{ kind: GenerationKind; request: GenerationRequest }> = [];
  const calls: Array<{ kind: GenerationKind; request: GenerationRequest; model: string; key?: string; leftMs: number }> = [];
  const adapter: MediaAdapter = {
    provider: 'fal',
    kinds: () => kinds,
    estimateUsd: (kind, request) => { estimates.push({ kind, request }); return price; },
    async generate(kind, request, target, ctx) {
      calls.push({ kind, request, model: target.model, key: await target.key?.(), leftMs: ctx.deadlineMs - Date.now() });
      if (make) return make(kind, request, ctx);
      const tail = Buffer.from(`${kind}-${calls.length}`); // distinct bytes per call (the blob store keeps one row per content)
      return kind === 'video' ? { bytes: Buffer.concat([MP4, tail]), mime: 'video/mp4', extension: 'mp4', durationMs: 5000 } : { bytes: Buffer.concat([MP3, tail]), mime: 'audio/mpeg', extension: 'mp3', durationMs: 12_000 };
    },
  };
  return { adapter, estimates, calls };
}

/** A fake Codex engine: `answer` gets the turn input; deleted thread refs are recorded. */
export function fakeCodex(answer: (input: EngineTurnInput) => Promise<EngineTurnResult>) {
  const turns: EngineTurnInput[] = [];
  const deleted: string[] = [];
  const engine = {
    id: 'codex', run: async (input: EngineTurnInput) => { turns.push(input); return answer(input); },
    deleteSession: async (_account: Account, ref: string) => { deleted.push(ref); return 'deleted' as const; },
  };
  return { engines: { get: () => engine, all: () => [engine], disposeIdle: async () => undefined }, turns, deleted };
}

/**
 * A fake local voice: `installed` says whether Supertonic is downloaded, a pull chooses it in `voice` (the
 * settings' voice section, as the real pull does); every line comes back as PCM16 at 24 kHz.
 */
export function fakeVoice(options: { installed?: boolean; ready?: boolean; voice?: { localTts?: string } } = {}) {
  const lines: Array<{ text: string; voice?: string; language?: string }> = [];
  const pulls: string[] = [];
  let installed = options.installed ?? true;
  const stt = {
    localModels: () => ({
      engine: { ready: options.ready ?? true },
      models: [{ id: 'supertonic-3-int8', purpose: 'tts', label: 'Supertonic 3', downloadMb: 129, installed, recommended: true }],
    }),
    pullLocal: async (id: string) => { pulls.push(id); installed = true; if (options.voice) options.voice.localTts = id; return { ok: true as const }; },
    speak: async (input: { text: string; voice?: string; language?: string }) => {
      lines.push(input);
      const pcm = Buffer.alloc(2400 * 2, 1); // 0.1 s at 24 kHz
      return { audio: pcm.toString('base64'), sampleRate: 24_000, durationMs: 100 };
    },
  };
  return { stt, lines, pulls };
}

/** The media harness with generation services on `accounts`, a recording spend ledger and tool contexts. */
export function toolSetup(accounts: Account[], extra: Record<string, unknown> = {}) {
  const t = mediaSetup();
  const spends: Array<Record<string, unknown>> = [];
  Object.assign(t.h.services, services(accounts), {
    secrets: { redact: (text: string) => text },
    spend: { record: (input: Record<string, unknown>) => spends.push(input) },
    stt: fakeVoice({ ready: false }).stt,
    paths: { temp: t.temp.dir },
  }, extra);
  const ctx = (agentId = 'ag_ada', conversationId: string | undefined = t.chat.id, signal = new AbortController().signal): ToolContext => ({
    agent: t.h.org.require(agentId), runId: 'run_1', conversationId, mode: 'general', services: t.h.services, signal, status() {},
  });
  return { ...t, spends, ctx };
}

export const tool = (name: string) => mediaTools.find((entry) => entry.name === name)!;
export const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

/** describe() then run() with the same args object, as the registry calls a tool. */
export async function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ action: ActionDescription; out: ToolOutput }> {
  const action = tool(name).describe!(args, ctx);
  return { action, out: await tool(name).run(args, ctx) };
}
