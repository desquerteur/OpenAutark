// Test fixture for package R3-C (context + subconscious): the chat/task harness plus a real
// KnowledgeStore and run journal, and small fakes for settings, skills, modes, catalog,
// files, permissions and decisions. Services are late-bound like the composition root does.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '../chat/harness.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import type { Db } from '../../../src/runtime/db/database.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { Context, type ContextDeps } from '../../../src/runtime/context/service.ts';
import { SubconsciousImpl } from '../../../src/runtime/subconscious/service.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { DecisionRequest, DecisionResult, DecisionService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ModeInfo, SkillInfo } from '../../../src/shared/model/knowledge.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import type { Agent, Space } from '../../../src/shared/model/org.ts';

export const RESOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources');

export const VIDEO_MODE: ModeInfo = {
  key: 'video', name: 'Video', description: 'Edit and publish videos.', skills: ['remotion-video'], tools: ['*'], category: 'video-animation',
  verifier: 'The video file exists and plays.', instructions: '# Video mode\n\nCut tight. Export H.264.',
};

export function model(id: string, tier: ModelInfo['tier'], name = id): ModelInfo {
  return { id, provider: 'codex', model: id.split(':')[1] ?? id, name, engine: 'codex', efforts: ['low', 'medium', 'high'], caps: {}, tier, strengths: {}, available: true, accounts: ['acc_1'] };
}

export function route(modelId = 'codex:gpt-6.1-sol', effort: RouteDecision['effort'] = 'high'): RouteDecision {
  return { modelId, engine: 'codex', accountId: 'acc_1', effort, category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
}

/** A scripted decision model; `answer` gets every request, `calls` records them. */
export function fakeDecisions(answer: (request: DecisionRequest) => Partial<DecisionResult>, available = true) {
  const calls: DecisionRequest[] = [];
  const service: DecisionService = {
    available: () => available,
    decide: async (request) => { calls.push(request); return { confidence: 0.9, by: 'fake', ...answer(request) }; },
  };
  return { service, calls };
}

export interface FixtureOptions {
  profile?: Partial<Settings['profile']>;
  decisions?: DecisionService;
  skills?: SkillInfo[];
  promptsDir?: string;
  runner?: ContextDeps['runner'];
  fileText?: (id: string) => Promise<string | undefined>;
}

export function fixture(options: FixtureOptions = {}) {
  const h = harness({ decisions: options.decisions });
  const s = h.services as unknown as Record<string, unknown> & RuntimeServices;
  const profile: Settings['profile'] = { name: 'Alex', company: 'Acme GmbH', language: 'de', timezone: 'Europe/Berlin', ...options.profile };
  const spaces: Space[] = [{ id: 'sp_co', name: 'Company', kind: 'company', sort: 0, createdAt: 0 }];
  const models = new Map<string, ModelInfo>([
    ['codex:gpt-6.1-sol', model('codex:gpt-6.1-sol', 'frontier', 'GPT-6.1 Sol')],
    ['ollama:gemma', model('ollama:gemma', 'local', 'Gemma')],
    ['codex:luna', model('codex:luna', 'strong', 'Luna')],
  ]);
  const fileTexts: string[] = [];
  const knowledge = new KnowledgeStore({ db: h.db, clock: h.clock });
  Object.assign(s, {
    settings: { get: () => ({ profile, routing: { decisionBackend: 'auto' } }) as unknown as Settings, update: () => { throw new Error('read-only'); } },
    knowledge,
    runs: new Journal({ db: h.db, bus: h.bus, clock: h.clock }),
    skills: { indexFor: () => options.skills ?? [], list: () => options.skills ?? [], get: () => undefined },
    modes: { get: (key: string) => (key === 'video' ? VIDEO_MODE : GENERAL_MODE), list: () => [GENERAL_MODE, VIDEO_MODE] },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()].map((item) => ({ ...item, available: false })) },
    tools: { get: () => undefined },
    secrets: { redact: (text: string) => text.replaceAll('hunter2', 'secret://sec_pw') },
    permissions: { settings: () => ({ mode: 'standard', money: { currency: 'EUR', perActionGuardian: 20, perActionHuman: 500, dailyCap: 100 } }) },
    files: {
      path: (id: string) => path.join('/blobs', id.slice(0, 2), id),
      text: async (id: string) => { fileTexts.push(id); return options.fileText ? options.fileText(id) : 'Extracted PDF text'; },
      get: () => undefined,
    },
    paths: { resources: RESOURCES, temp: '/tmp', workspace: '/ws' },
  });
  (h.org as unknown as { spaces(): Space[] }).spaces = () => spaces;
  const manager = h.org.add(agent('ag_mia', 'Mia', { role: 'Manager' }));
  const vid = h.org.add(agent('ag_vid', 'Vic', { role: 'Video editor', managerId: manager.id, team: 'Marketing', spaceId: 'sp_co', instructions: 'Prefer short cuts. Password hunter2 is not for chats.' }));
  const context = new Context({ services: () => s, runner: options.runner ?? false, promptsDir: options.promptsDir });
  const subconscious = new SubconsciousImpl({ services: () => s });
  s.context = context;
  s.subconscious = subconscious;
  return { ...h, services: s, knowledge, context, subconscious, manager, vid, profile, fileTexts, models };
}

/** Inserts a file row (metadata only) with optional cached text. */
export function addFile(db: Db, id: string, name: string, mime: string, text?: string): void {
  db.run('INSERT INTO files (id, name, mime, size, created_at, text_preview) VALUES (?, ?, ?, ?, ?, ?)', [id, name, mime, 1234, 0, text ?? null]);
}

export function hex(char: string): string {
  return char.repeat(64);
}

export type { Agent };
