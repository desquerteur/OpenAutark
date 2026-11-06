// In-process runtime for integration tests (T12): the real chain – ChatService, Delivery,
// TaskService, Ownership, WakeQueue, Scheduler (on fake timers), RunJournal, Dispatcher and
// TurnExecutor – on one SQLite database with a ManualClock and a scripted FakeEngine. Our task,
// schedule and human.ask tools run directly (internal 'think' tools); the
// context is a plain delta of the chat lines the agent has not seen. boot() on the database of a
// previous boot is a restart: start() reconciles runs, wakes and streaming messages and runs
// ownership.recover() like runtime/main.ts.
// Owns: nothing in production. Never imported by src/; no real timers, sleeps or network.

import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Bus } from '../../../src/runtime/bus.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { ChatServiceImpl } from '../../../src/runtime/chat/service.ts';
import { DeliveryServiceImpl } from '../../../src/runtime/chat/delivery.ts';
import { TaskServiceImpl } from '../../../src/runtime/tasks/service.ts';
import { OwnershipServiceImpl } from '../../../src/runtime/tasks/ownership.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { SchedulerImpl } from '../../../src/runtime/schedules/scheduler.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { DispatcherImpl } from '../../../src/runtime/agents/dispatcher.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { FakeEngine } from '../../../src/runtime/engines/fake.ts';
import { outputText } from '../../../src/runtime/engines/shared.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { taskTools } from '../../../src/runtime/tools/builtin/tasks.ts';
import { scheduleTools } from '../../../src/runtime/tools/builtin/schedule.ts';
import { humanTools } from '../../../src/runtime/tools/builtin/human.ts';
import { verifyResult } from '../../../src/runtime/subconscious/verify.ts';
import type { NotificationService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { EngineTurnInput } from '../../../src/runtime/engines/types.ts';
import type { ToolContext, ToolDef } from '../../../src/runtime/tools/types.ts';
import type { Agent, AgentStatus } from '../../../src/shared/model/org.ts';
import type { RouteDecision } from '../../../src/shared/model/providers.ts';
import type { WakeReason } from '../../../src/shared/model/runs.ts';
import { FakeOrg, FakeTimers, tick } from '../chat/harness.ts';
import { account } from '../models/harness.ts';

/** One engine turn as the agent saw it. */
export interface Turn {
  agentId: string;
  runId: string;
  taskId?: string;
  reason?: WakeReason;
  at: number;
  input: string;
}

/** The agent's side of a turn: its tool calls and its answer (or a turn that never ends). */
export interface TurnContext extends Turn {
  services: RuntimeServices;
  /** Calls one of our tools like the engine would; returns the parsed JSON (or the text). */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
export type Brain = (turn: TurnContext) => Promise<{ text?: string; hang?: boolean }>;

class LiveOrg extends FakeOrg {
  bus?: Bus;
  setStatus(id: string, status: AgentStatus, note?: string): void {
    const agent = this.require(id);
    agent.status = status;
    agent.statusNote = note;
    this.bus?.emit('agent.upserted', agent);
  }
}

const TOOLS = new Map<string, ToolDef>([...taskTools, ...scheduleTools, ...humanTools].map((tool) => [tool.name, tool]));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export function boot(options: { agents: Agent[]; db?: Db; clock?: ManualClock; brain: Brain }) {
  const db = options.db ?? new Db(':memory:');
  if (!options.db) migrate(db);
  const clock = options.clock ?? new ManualClock(Date.UTC(2026, 9, 20, 9, 0, 0));
  const bus = new Bus((error) => { throw error; });
  const org = new LiveOrg();
  for (const item of options.agents) org.add(structuredClone(item));
  org.bus = bus;
  const notified: Array<Parameters<NotificationService['notify']>[0]> = [];
  const timers = new FakeTimers();
  const turns: Turn[] = [];
  const state = { brain: options.brain };

  const services = {
    db, bus, clock, org, log: quiet, decisions: undefined,
    notifications: { notify: (input) => { notified.push(input); } } satisfies NotificationService,
    host: { onPower: () => () => {} },
  } as unknown as RuntimeServices;
  services.wakes = new WakeQueueImpl({ db, clock });
  services.chats = new ChatServiceImpl(services);
  services.delivery = new DeliveryServiceImpl(services);
  services.tasks = new TaskServiceImpl(services);
  services.ownership = new OwnershipServiceImpl(services);
  services.scheduler = new SchedulerImpl(services, { timers });
  services.runs = new Journal({ db, bus, clock });

  const acc = account('acc_demo', 'compatible');
  const route: RouteDecision = { modelId: 'fake:fake-1', engine: 'fake', accountId: acc.id, effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  let calls = 0;
  const engine = new FakeEngine({
    script: async (input: EngineTurnInput) => {
      const run = services.runs.get(input.runId);
      const text = input.input.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
      const turn: Turn = { agentId: input.agentId, runId: input.runId, taskId: run?.taskId, reason: run?.trigger, at: clock.now(), input: text };
      turns.push(turn);
      const call = async (name: string, args: Record<string, unknown>) => {
        const out = outputText(await input.callTool(name, args, `call_${++calls}`));
        try { return JSON.parse(out) as Record<string, unknown>; } catch { return { text: out }; }
      };
      const reply = await state.brain({ ...turn, services, call });
      if (reply.hang) {
        // Never ends by itself: only a stop (or the process dying) ends it.
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { text: '', stop: 'interrupted' };
      }
      const answer = reply.text ?? '';
      return { text: answer, stop: 'done', usage: { inputTokens: text.length, outputTokens: answer.length } };
    },
  });

  Object.assign(services, {
    modes: { get: (key: string) => { if (key === 'general') return GENERAL_MODE; throw new Error(`unknown mode ${key}`); }, list: () => [GENERAL_MODE] },
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), list: () => [acc], markLimited: () => {}, markUnavailable: () => false, updateLimits: () => {} },
    catalog: { get: () => undefined, list: () => [] },
    settings: { get: () => ({ profile: { name: 'Lena', timezone: 'UTC' } }) },
    paths: { workspace: 'workspace', temp: 'temp' },
    secrets: { redact: (value: string) => value },
    mcp: { lease: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'lease', release: () => {} }) },
    subconscious: {
      widgetFor: async () => ({ type: 'confirm' }),
      verify: (task: Parameters<typeof verifyResult>[1], result: Parameters<typeof verifyResult>[2]) => verifyResult(services, task, result),
    },
    context: {
      prompt: () => ({ stable: 'You are an agent of the workforce.', volatile: '' }),
      prepare: async () => {},
      compact: async () => {},
      delta: (input: { agent: Agent; conversationId: string; sinceSeq: number }) => {
        const after = services.chats.messages(input.conversationId, { afterSeq: input.sinceSeq, limit: 200 });
        const lines = after.filter((message) => message.authorId !== input.agent.id && message.kind !== 'status' && message.state !== 'streaming');
        return { text: lines.map((message) => `${message.authorId}: ${message.body}`).join('\n'), images: [], lastSeq: after.at(-1)?.seq ?? input.sinceSeq };
      },
    },
    tools: {
      get: (name: string) => TOOLS.get(name),
      specsFor: () => [...TOOLS.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      call: async (name: string, args: unknown, ctx: Omit<ToolContext, 'services'>) => {
        const tool = TOOLS.get(name);
        if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${name}.` }], isError: true };
        try { return await tool.run(args as Record<string, unknown>, { ...ctx, services }); } catch (error) {
          return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      },
    },
  });
  const dispatcher = new DispatcherImpl({ services: () => services, executor: new TurnExecutor(() => services), supervisor: { admit: async () => () => {} }, maxConcurrent: 2 });
  services.dispatcher = dispatcher;

  /** Lets turns, microtasks and immediates run until nothing is running or due (bounded). */
  const settle = async (rounds = 400) => {
    let idle = 0;
    for (let i = 0; i < rounds && idle < 4; i++) {
      await tick();
      idle = dispatcher.activity().length === 0 && services.wakes.dueAgents().length === 0 ? idle + 1 : 0;
    }
  };
  /** The scheduler's single timer: moves the clock to it, fires it and settles. Returns the wait. */
  const step = async () => {
    const timer = timers.only();
    if (!timer) throw new Error('nothing is armed');
    clock.advance(timer.ms);
    timers.fire();
    await settle();
    return timer.ms;
  };
  /** Startup like runtime/main.ts: reconcile, recover, then the event-driven parts. */
  const start = () => {
    services.chats.reconcileStreaming();
    const runs = services.runs.reconcile();
    const wakes = services.wakes.reconcile();
    const continued = services.ownership.recover({ interruptedRuns: runs.runIds });
    services.scheduler.start();
    dispatcher.start();
    return { runs, wakes, continued };
  };
  /** The process dies: no timer fires any more and nothing is shut down cleanly. */
  const crash = () => { services.scheduler.stop(); };

  return { db, clock, bus, org, services, tasks: services.tasks, chats: services.chats, wakes: services.wakes, scheduler: services.scheduler, runs: services.runs, dispatcher, engine, timers, turns, notified, state, settle, step, start, crash };
}

export type World = ReturnType<typeof boot>;
