// Test harness for tool tests: the chat/task harness plus real settings, a fake decision service
// (scripted answers) and fake paths/devices/secrets/runs, wired late-bound like the composition root.

import path from 'node:path';
import { agent, harness } from '../chat/harness.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import type { DecisionRequest, DecisionResult, DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ActionCategory, ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { RunItem } from '../../../src/shared/model/runs.ts';

export class FakeDecisions implements DecisionService {
  up = true;
  calls: DecisionRequest[] = [];
  answers: Array<DecisionResult | Error> = [];
  available(): boolean { return this.up; }
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request);
    const next = this.answers.shift() ?? { confidence: 0, by: 'none' };
    if (next instanceof Error) throw next;
    return next;
  }
  /** Queue answers in call order. */
  answer(...results: Array<DecisionResult | Error>): this { this.answers.push(...results); return this; }
}

export const WORKSPACE = path.resolve('test-workspace-root');

export function setup() {
  const h = harness();
  const settings = new SettingsStore({ db: h.db, bus: h.bus, clock: h.clock, env: { locale: 'en-US', timezone: 'UTC' } });
  const decisions = new FakeDecisions();
  const runItems: Array<Omit<RunItem, 'id' | 'runId' | 'seq' | 'createdAt'>> = [];
  const services = h.services as RuntimeServices;
  services.settings = settings;
  services.decisions = decisions;
  services.paths = { workspace: WORKSPACE } as RuntimeServices['paths'];
  services.secrets = { redact: (text: string) => text.replace(/sk-[a-z0-9]+/g, 'secret://sec_1') } as unknown as RuntimeServices['secrets'];
  services.devices = { self: () => ({ id: 'dev_self' }) } as unknown as RuntimeServices['devices'];
  services.runs = { item: (_runId: string, item: (typeof runItems)[number]) => { runItems.push(item); return { id: 'ri_1' }; } } as unknown as RuntimeServices['runs'];
  services.spend = { record: () => undefined };
  const org = Object.assign(h.org, {
    update: (id: string, patch: Partial<Agent>): Agent => {
      const next = { ...h.org.require(id), ...patch };
      h.org.agents.set(id, next);
      return next;
    },
  });
  const tom = h.org.add(agent('ag_tom', 'Tom', { role: 'Video editor' }));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  return { ...h, org, settings, decisions, runItems, tom, chat };
}

export type Setup = ReturnType<typeof setup>;

export function tool(name: string, category: ActionCategory, extra: Partial<ToolDef> = {}): ToolDef {
  return {
    name, category, description: name, inputSchema: { type: 'object' },
    describe: () => ({ summary: name, reversible: true, external: false }),
    run: async () => ({ content: [] }),
    ...extra,
  };
}

export function ctxFor(h: Setup, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {}, ...extra,
  };
}
