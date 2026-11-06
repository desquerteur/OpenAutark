// Test setup for the work presence (B-055 G): a real bus and run journal (in-memory DB), a manual clock at real time
// (file mtimes compare sensibly), a temp workspace, three agents, and the WorkPresence wired like compose/services.ts
// (start(): the bus listeners). journalEvent writes an engine's own tool_start the way agents/turn-attempt.ts does
// (kind tool_call, own: true, args as the redacted 2,000-character preview).
// Owns: fixtures only. Never imported by src/.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Bus } from '../../../src/runtime/bus.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { preview } from '../../../src/runtime/tools/outputs.ts';
import { WorkPresence } from '../../../src/runtime/work-presence/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { EngineEvent } from '../../../src/runtime/engines/types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { memoryDb, tempDir } from '../store/helpers.ts';

export const MIN = 60_000;

export function presenceSetup() {
  const db = memoryDb();
  const bus = new Bus((error) => { throw error; });
  const clock = new ManualClock(Date.now());
  const temp = tempDir('wf-presence-');
  const workspace = path.join(temp.dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const agents = new Map([['ag_ada', { id: 'ag_ada', name: 'Ada' }], ['ag_bob', { id: 'ag_bob', name: 'Bob' }], ['ag_cy', { id: 'ag_cy', name: 'Cy' }]]);
  const journal = new Journal({ db, bus, clock });
  const secrets = { redact: (text: string) => text };
  const homes = new Map<string, string>();
  const services = {
    db, bus, clock, runs: journal, secrets, paths: { workspace },
    org: { get: (id: string) => agents.get(id) },
    tasks: { get: () => undefined },
    agentCore: { homes: { usable: (id: string) => homes.get(id) } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as RuntimeServices;
  const presence = new WorkPresence({ services: () => services });
  services.workPresence = presence;
  const stop = presence.start();
  let runs = 0;
  /** A running turn of `agentId` (run.upserted running). */
  const turn = (agentId: string, conversationId = 'c_1') => {
    const runId = `run_${++runs}`;
    journal.start({ id: runId, agentId, conversationId, trigger: 'message' });
    return runId;
  };
  const end = (runId: string) => journal.finish(runId, { status: 'done' });
  const journalEvent = (runId: string, event: EngineEvent) => {
    if (event.type !== 'tool_start' || !event.own) return undefined;
    return journal.item(runId, { kind: 'tool_call', name: event.name, effectStatus: 'none', data: { callId: event.callId, own: true, args: preview(secrets as never, event.args) } });
  };
  /** A file in the workspace (folders created); its absolute path. */
  const file = (relative: string, content: string) => {
    const target = path.join(workspace, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    return target;
  };
  /** A ToolContext of `agentId` in run `runId` for our files tools. */
  const ctx = (agentId: string, runId: string, extra: Record<string, unknown> = {}) => ({
    services, agent: agents.get(agentId)!, runId, conversationId: 'c_1', mode: 'general', signal: new AbortController().signal, status: () => undefined, ...extra,
  }) as unknown as ToolContext;
  return { db, bus, clock, temp, workspace, journal, services, presence, homes, agents, turn, end, journalEvent, file, ctx, cleanup: () => { stop(); temp.cleanup(); } };
}
