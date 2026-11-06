// Test fixture for the team patterns: real Org (with resources/agents templates), KnowledgeStore,
// blob store and pattern library on a temp data folder; a mode list, a small skill library and fake
// chats (members, settings, space)/tasks/wakes (a coalesced queue with claim/finish).
// Owns: fixtures only. Never: imported by production code.

import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { createPaths, ensurePaths } from '../../../src/runtime/system/paths.ts';
import type { RuntimeServices, WakeRequest } from '../../../src/runtime/contracts.ts';
import '../../../src/runtime/contracts/team-start.ts';
import { PatternLibrary } from '../../../src/runtime/patterns/library.ts';
import type { FetchText } from '../../../src/runtime/patterns/fetch.ts';
import type { Task } from '../../../src/shared/model/tasks.ts';
import type { ConversationSettings, StatusLine } from '../../../src/shared/model/chat.ts';
import { clock, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';

export const MODES = ['general', 'manager', 'research', 'writing', 'video', 'web', 'social', 'secretary', 'finance'];
export const SKILLS = ['research-report', 'writing-style', 'ceo-assistant', 'reference-curator', 'representation'];

export function teamFixture(options: { fetch?: FetchText } = {}) {
  const temp = tempDir('wf-team-');
  const paths = ensurePaths(createPaths({ data: path.join(temp.dir, 'data'), resources: RESOURCES, workspace: path.join(temp.dir, 'workspace') }));
  const db = new Db(':memory:');
  migrate(db);
  const recorder = recordingBus();
  const time = clock();
  const log = new MemoryLogger();
  const org = new Org({ db, bus: recorder.bus, clock: time, templatesDir: path.join(RESOURCES, 'agents') });
  const knowledge = new KnowledgeStore({ db, clock: time, bus: recorder.bus });
  const files = new Blobs({ db, blobs: paths.blobs, clock: time, log });
  const modes = { list: () => MODES.map((key) => ({ key })), get: (key: string) => { if (!MODES.includes(key)) throw new Error('unknown mode'); return { key }; } };
  const skills = { list: () => SKILLS.map((name) => ({ name, description: name })), remove: () => {} };
  const tasks = new Map<string, Task>();
  const members = new Map<string, Array<{ memberId: string; kind: string; leftAt?: number }>>();
  const convs = new Map<string, { id: string; spaceId?: string; settings: ConversationSettings }>();
  const conv = (id: string) => { let entry = convs.get(id); if (!entry) convs.set(id, (entry = { id, settings: {} })); return entry; };
  const wakes: WakeRequest[] = [];
  /** Waiting or claimed coalesced wakes by agent|key (claimedAt set once the agent's turn took it). */
  const queue = new Map<string, { agentId: string; conversationId?: string; claimedAt?: number }>();
  const lines: Array<{ conversationId: string; line: StatusLine }> = [];
  const s = {
    db, bus: recorder.bus, clock: time, log, paths, org, knowledge, files, modes, skills,
    secrets: { redact: (text: string) => text, list: () => [] },
    tasks: { get: (id: string) => tasks.get(id) },
    chats: {
      get: (id: string) => conv(id),
      update: (id: string, patch: { settings?: Partial<ConversationSettings> }) => { const entry = conv(id); entry.settings = { ...entry.settings, ...patch.settings }; return entry; },
      members: (id: string) => (members.get(id) ?? []).filter((member) => member.leftAt === undefined),
      setMembers: (id: string, change: { add?: string[]; remove?: string[] }) => {
        const list = (members.get(id) ?? []).filter((member) => member.leftAt === undefined);
        members.set(id, [...list.map((member) => (change.remove?.includes(member.memberId) ? { ...member, leftAt: 1 } : member)), ...(change.add ?? []).map((memberId) => ({ memberId, kind: 'agent' }))]);
        return [];
      },
      status: (conversationId: string, line: StatusLine) => { lines.push({ conversationId, line }); return {}; },
    },
    wakes: {
      wake: (request: WakeRequest) => { wakes.push(request); if (request.coalesceKey) queue.set(`${request.agentId}|${request.coalesceKey}`, { agentId: request.agentId, conversationId: request.conversationId }); },
      cancelKey: (agentId: string, key: string) => { const entry = queue.get(`${agentId}|${key}`); if (!entry || entry.claimedAt !== undefined) return false; return queue.delete(`${agentId}|${key}`); },
      list: (agentId: string) => [...queue.values()].filter((entry) => entry.agentId === agentId),
    },
    tools: { register: () => {} },
  } as unknown as RuntimeServices;
  const services = () => s;
  s.patterns = new PatternLibrary({ services, dir: path.join(RESOURCES, 'patterns'), fetch: options.fetch });
  const manager = org.ensureSeed()!;
  return {
    s, db, org, knowledge, files, time, log, manager, tasks, members, convs: conv, wakes, queue, lines, events: recorder,
    patterns: s.patterns,
    /** The waiting wakes were claimed (the agents' turns started): a new request no longer merges. */
    claim: () => { for (const entry of queue.values()) entry.claimedAt ??= 1; },
    /** The claimed wakes of `agentId` are done (after its run.upserted, as the dispatcher does). */
    finish: (agentId: string) => { for (const [key, entry] of queue) if (entry.agentId === agentId && entry.claimedAt !== undefined) queue.delete(key); },
    cleanup: () => { try { db.close(); } catch { /* closed */ } temp.cleanup(); },
  };
}

export type TeamFixture = ReturnType<typeof teamFixture>;

/** A task row in the fake task map. */
export function task(f: TeamFixture, input: Partial<Task> & { id: string; assigneeId: string }): Task {
  const row = {
    title: 'Write the launch post', notes: '', status: 'working', assigneeKind: 'agent', conversationId: 'ch_1', ledger: {},
    ...input,
  } as unknown as Task;
  f.tasks.set(row.id, row);
  return row;
}
