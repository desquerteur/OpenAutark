// Test fixture for tasks with an org: the chat/task harness with a real chain-of-command canManage, spaces, a
// scripted decision backend that records every request, tool contexts, quick tasks (src/runtime/tasks/quick.ts) and a
// settle helper. Used by the task, day and quick-task tests.
// Owns: fixtures only. Never imported by src/.

import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Agent, Space } from '../../../src/shared/model/org.ts';
import type { DecisionRequest, DecisionResult, DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import { quickCreate } from '../../../src/runtime/tasks/quick.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { agent, harness, tick } from '../chat/harness.ts';

export { agent, tick };

export type Answer = DecisionResult | Error | ((request: DecisionRequest) => DecisionResult | Error | Promise<DecisionResult>);

export function scriptedDecisions(answer: Answer, available = true): DecisionService & { asked: DecisionRequest[] } {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    available: () => available,
    decide: async (request) => {
      asked.push(request);
      const result = typeof answer === 'function' ? await answer(request) : answer;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export interface CenterOptions {
  decisions?: DecisionService;
  spaces?: Space[];
}

export function center(options: CenterOptions = {}) {
  const h = harness({ decisions: options.decisions });
  const spaces = options.spaces ?? [];
  Object.assign(h.org, {
    spaces: () => spaces,
    canManage: (viewer: string, target: string) => viewer === HUMAN_ID || (viewer !== target && h.org.managers(target).some((boss: Agent) => boss.id === viewer)),
  });
  const s = h.services as RuntimeServices;
  /** The microtasks of the last writes ran. */
  const settle = async () => { await tick(); await tick(); };
  const tool = (name: string): ToolDef => taskTools.find((item) => item.name === name)!;
  const ctxFor = (agentId: string, extra: Partial<ToolContext> = {}): ToolContext => ({
    agent: h.org.get(agentId)!, runId: `run_${agentId}`, mode: 'general', services: s, signal: new AbortController().signal, status: () => {}, ...extra,
  }) as ToolContext;
  const call = async (agentId: string, name: string, args: Record<string, unknown>, extra: Partial<ToolContext> = {}) => {
    const out = await tool(name).run(args as never, ctxFor(agentId, extra));
    const text = (out.content[0] as { text: string }).text;
    return { error: out.isError === true, text, data: out.isError ? undefined : (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; } })() };
  };
  const quick = (text: string, extra: Record<string, unknown> = {}) => quickCreate(s, { text, ...extra }, HUMAN_ID);
  return { ...h, s, settle, call, quick };
}

/** A small company: Mara (manager), Tom (video editor) and Lea (web developer) report to her. */
export function company(h: ReturnType<typeof center>): void {
  h.org.add(agent('ag_mara', 'Mara', { role: 'Manager', mode: 'manager', template: 'manager', createdAt: 1 }));
  h.org.add(agent('ag_tom', 'Tom', { role: 'Video editor', mode: 'video', managerId: 'ag_mara', team: 'Media', createdAt: 2 }));
  h.org.add(agent('ag_lea', 'Lea', { role: 'Web developer', skills: ['website-builder'], managerId: 'ag_mara', team: 'Web', createdAt: 3 }));
}
