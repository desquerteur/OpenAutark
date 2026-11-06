// Test setup for the dispatcher: the chat harness (real chats, delivery, wakes, scheduler on
// fake timers) plus a controllable fake turn executor, fake runs/settings/host and
// an org fake with setStatus. Owns: nothing in production. Never imported by src/.

import { harness, tick } from '../chat/harness.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import type { TurnOutcome, TurnRequest } from '../../../src/runtime/agents/turn-types.ts';
import type { RunJournal, SettingsService } from '../../../src/runtime/contracts.ts';
import type { AgentStatus } from '../../../src/shared/model/org.ts';

export interface FakeCall {
  request: TurnRequest;
  /** Ends the turn (default status 'done'). Idempotent. */
  finish(outcome?: Partial<TurnOutcome>): void;
  done: boolean;
}

export class FakeExecutor {
  readonly calls: FakeCall[] = [];
  running = 0;
  maxRunning = 0;
  throwNext = false;

  execute(request: TurnRequest): Promise<TurnOutcome> {
    if (this.throwNext) { this.throwNext = false; return Promise.reject(new Error('boom')); }
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    return new Promise<TurnOutcome>((resolve) => {
      const call: FakeCall = {
        request, done: false,
        finish: (outcome = {}) => {
          if (call.done) return;
          call.done = true;
          this.running--;
          resolve({ runId: request.runId, status: 'done', ...outcome });
        },
      };
      this.calls.push(call);
      // Like the engines: an aborted turn ends as 'interrupted'.
      request.signal.addEventListener('abort', () => call.finish({ status: 'interrupted' }), { once: true });
    });
  }

  last(): FakeCall {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('no turn started');
    return call;
  }
}

export function setup(options: { maxConcurrent?: number } = {}) {
  const h = harness();
  const statuses: Array<{ id: string; status: AgentStatus; note?: string }> = [];
  const org = Object.assign(h.org, {
    setStatus(id: string, status: AgentStatus, note?: string) {
      const agent = h.org.require(id);
      agent.status = status;
      agent.statusNote = note;
      statuses.push({ id, status, note });
      h.bus.emit('agent.upserted', agent);
    },
  });
  const runItems: Array<{ runId: string; kind: string; data: Record<string, unknown> }> = [];
  const finishedRuns: Array<{ runId: string; status?: string }> = [];
  const runStatus = new Map<string, string>();
  h.services.runs = {
    item: (runId: string, item: { kind: string; data: Record<string, unknown> }) => { runItems.push({ runId, ...item }); return { id: 'ri_1', runId, seq: runItems.length, createdAt: 0, ...item }; },
    get: (runId: string) => (runStatus.has(runId) ? { id: runId, status: runStatus.get(runId) } : undefined),
    finish: (runId: string, patch: { status?: string }) => { finishedRuns.push({ runId, status: patch.status }); runStatus.set(runId, patch.status ?? 'done'); return { id: runId }; },
  } as unknown as RunJournal;
  h.services.settings = { get: () => ({ profile: { name: 'Lena', timezone: 'UTC' } }) } as unknown as SettingsService;
  const awake = { acquired: 0, released: 0 };
  Object.assign(h.services.host, { keepAwake: () => { awake.acquired++; return () => { awake.released++; }; } });
  const admitted: AbortSignal[] = [];
  const supervisor = { admit: async (signal?: AbortSignal) => { if (signal) admitted.push(signal); return () => {}; } };
  const executor = new FakeExecutor();
  const dispatcher = new DispatcherImpl({ services: () => h.services, executor, supervisor, maxConcurrent: options.maxConcurrent ?? 2 });
  h.services.dispatcher = dispatcher;
  h.scheduler.start();
  return { ...h, org, statuses, runItems, finishedRuns, runStatus, awake, admitted, executor, dispatcher };
}

/** Lets microtasks, immediates and the fake executor's promise chains settle. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

export function openWakes(db: ReturnType<typeof harness>['db']): Array<{ agent_id: string; reason: string; conversation_id: string | null; due_at: number; claimed_at: number | null }> {
  return db.all('SELECT agent_id, reason, conversation_id, due_at, claimed_at FROM wakes ORDER BY due_at');
}
