// Fixture for the media.listen tests (MM10): the media harness with a static model catalog, real
// account selection, the real router and the real CompatibleEngine against a scripted
// 127.0.0.1 chat-completions server (http-fixture.ts), plus a recording spend ledger.
// Owns: fixtures only. Never: imported by production code, a real provider or the network
// beyond 127.0.0.1.

import type { ServerResponse } from 'node:http';
import { selectCandidates } from '../../../src/runtime/accounts/candidates.ts';
import { CompatibleEngine } from '../../../src/runtime/engines/http/compatible.ts';
import { RouterImpl } from '../../../src/runtime/routing/router.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { mediaTools } from '../../../src/runtime/tools/builtin/media.ts';
import type { ActionDescription, ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Account, ModelInfo } from '../../../src/shared/model/providers.ts';
import { sendJson, sendSse, serve, type Recorded } from '../engines/http-fixture.ts';
import { mediaSetup } from './setup.ts';

export const KEY = 'sk-test-listen-0123456789';
export const CHAT_PATH = '/v1/chat/completions';

export const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'cc_1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
export const usage = (prompt: number, completion: number, extra: Record<string, unknown> = {}) => ({ id: 'cc_1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...extra } });

/** A streamed answer `text` with token usage (and `extra` usage fields such as OpenRouter's cost). */
export const answer = (text: string, extra: Record<string, unknown> = {}) => (res: ServerResponse) =>
  sendSse(res, [chunk({ role: 'assistant', content: '' }), chunk({ content: text }), chunk({}, 'stop'), usage(900, 12, extra), '[DONE]']);

export function account(id: string, provider: Account['provider'], auth: Account['auth'], baseUrl: string): Account {
  return { id, provider, label: id, auth, baseUrl, state: 'ok', priority: 0, rotation: false, enabled: true, detected: false, createdAt: 1 };
}

/** A catalog entry "<provider>:<model>" on one account (engine as the catalog assigns it). */
export function model(id: string, accountId: string, patch: Partial<ModelInfo> = {}): ModelInfo {
  const at = id.indexOf(':');
  const provider = id.slice(0, at) as ModelInfo['provider'];
  return {
    id, provider, model: id.slice(at + 1), name: id, engine: provider === 'openai' ? 'openai' : 'compatible', efforts: ['none'], caps: {},
    tier: 'local', relCost: 0, strengths: {}, available: true, accounts: [accountId], ...patch,
  };
}

export interface ListenSetup {
  models: (base: string) => ModelInfo[];
  accounts: (base: string) => Account[];
  allowPaid?: boolean;
  /** Answers chat completions (the default: "A calm solo piano."). */
  respond?: (req: Recorded, res: ServerResponse) => void;
}

export async function listenSetup(options: ListenSetup) {
  const server = await serve((req, res) => {
    if (!req.path.startsWith(CHAT_PATH)) { sendJson(res, 404, { error: { message: 'not here' } }); return; }
    (options.respond ?? ((_req, out) => answer('A calm solo piano.')(out)))(req, res);
  });
  const base = `${server.url}/v1`;
  const t = mediaSetup();
  const models = options.models(base);
  const accounts = options.accounts(base);
  const base0 = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
  const settings = { ...base0, routing: { ...base0.routing, allowPaidFallback: options.allowPaid ?? false } };
  const compatible = new CompatibleEngine({ apiKey: async (entry) => (entry.auth === 'api_key' ? KEY : undefined) });
  const spends: Array<Record<string, unknown>> = [];
  Object.assign(t.h.services, {
    settings: { get: () => settings },
    catalog: { list: () => models, get: (id: string) => models.find((entry) => entry.id === id), refresh: async () => {} },
    accounts: { list: () => accounts, get: (id: string) => accounts.find((entry) => entry.id === id), candidates: (engine: ModelInfo['engine']) => selectCandidates(accounts, engine, t.h.clock.now()) },
    engines: { get: (id: string) => { if (id === 'compatible') return compatible; throw new Error(`engine ${id} is not wired in this test`); } },
    spend: { record: (input: Record<string, unknown>) => spends.push(input) },
    paths: { temp: t.temp.dir },
  });
  t.h.services.router = new RouterImpl({ services: () => t.h.services });
  const ctx = (agentId = 'ag_ada', signal = new AbortController().signal): ToolContext => ({
    agent: t.h.org.require(agentId), runId: 'run_1', conversationId: t.chat.id, mode: 'general', services: t.h.services, signal, status() {},
  });
  const close = async () => { await server.close(); t.temp.cleanup(); };
  return { ...t, server, base, spends, ctx, close, chats: () => server.hits(CHAT_PATH) };
}

export const listenTool = mediaTools.find((entry) => entry.name === 'media.listen')!;
export const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

/** describe() then run() with the same args object, as the registry calls a tool. */
export async function call(args: Record<string, unknown>, ctx: ToolContext): Promise<{ action: ActionDescription; out: ToolOutput }> {
  const action = listenTool.describe!(args, ctx);
  return { action, out: await listenTool.run(args, ctx) };
}
