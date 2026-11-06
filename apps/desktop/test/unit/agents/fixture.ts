// Test setup for the turn phases (plan → build → attempt → finish) without a dispatcher: the
// chat harness (real chats, tasks, ownership, wakes) plus recording fakes for modes, runs,
// catalog, context, engines, accounts, tools, the MCP hub and permissions.
// Owns: nothing in production. Never imported by src/.

import { agent, harness } from '../chat/harness.ts';
import { account } from '../models/harness.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { ContextService } from '../../../src/runtime/contracts.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Run } from '../../../src/shared/model/runs.ts';
import type { AttemptResult, RoutedTurn, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';

export type Script = (input: EngineTurnInput) => Promise<EngineTurnResult>;

export function setup(caps: Partial<EngineCaps> = {}) {
  const h = harness({ subconscious: {} });
  const tom = h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: [tom.id], createdBy: 'human' });
  const acc = account('acc_claude', 'claude');
  const runs: Array<Partial<Run>> = [];
  const items: Array<{ kind: string; data?: unknown }> = [];
  const contextCalls: string[] = [];
  const state: { script: Script } = { script: async () => ({ text: 'Hi', stop: 'done' }) };

  const engine = {
    id: 'claude',
    caps: { sessions: false, dynamicTools: false, mcp: true, images: false, rebase: false, structured: false, ownTools: true, ...caps },
    run: (input: EngineTurnInput) => state.script(input),
  } as unknown as Engine;
  const context: Pick<ContextService, 'prompt' | 'delta' | 'prepare'> = {
    prompt: () => ({ stable: 'stable', volatile: 'volatile' }),
    delta: (input) => { contextCalls.push('delta'); return { text: 'Lena: see the attached PDF', images: [], lastSeq: input.sinceSeq }; },
    prepare: async (input) => {
      await new Promise<void>((resolve) => setImmediate(resolve)); // real extraction is async
      contextCalls.push(`prepare:${input.conversationId}:${input.sinceSeq}`);
    },
  };

  Object.assign(h.services, {
    modes: { get: (key: string) => { if (key === 'general') return GENERAL_MODE; throw new Error(`unknown mode ${key}`); } },
    runs: {
      list: (agentId: string) => runs.filter((run) => run.agentId === agentId),
      start: () => {}, finish: () => {}, item: (_runId: string, item: { kind: string; data?: unknown }) => { items.push(item); },
    },
    catalog: { get: () => undefined },
    spend: { record: () => {} },
    context,
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), updateLimits: () => {} },
    settings: { get: () => ({ profile: { timezone: 'UTC' } }) },
    paths: { workspace: 'workspace', temp: 'temp' },
    mcp: { lease: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'lease', release: () => {} }) },
    tools: { specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
    secrets: { redact: (text: string) => text },
  });

  const route: RouteDecision = {
    modelId: 'claude:claude-opus-5-5', engine: 'claude', accountId: acc.id, effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [],
  };
  const request = (patch: Partial<TurnRequest> = {}): TurnRequest => ({
    runId: 'run_1', agentId: tom.id, conversationId: chat.id, reason: 'message', notes: [],
    signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 }, ...patch,
  });
  const routed = (): RoutedTurn => ({
    route, engine, account: acc, model: 'claude-opus-5-5', modelName: 'Claude Opus 5.5',
    prompt: { stable: '', volatile: '' }, input: [{ type: 'text', text: 'hi' }], lastSeq: 0,
  });
  const attempt = (result: EngineTurnResult, patch: Partial<AttemptResult> = {}): AttemptResult => ({
    result, streamed: result.text, reasoning: '', toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0 }, ms: 5, ...patch,
  });
  return { ...h, tom, chat, account: acc, engine, context, contextCalls, runs, items, state, route, request, routed, attempt };
}
