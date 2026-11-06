// Test fixture for portability: real Org, KnowledgeStore and blob store on a temp data folder,
// a minimal mode list and a secret redactor; services are late-bound like the composition root.
// Owns: fixtures only. Never: imported by production code.

import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { Portability } from '../../../src/runtime/portability/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { createPaths, ensurePaths } from '../../../src/runtime/system/paths.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { clock, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';

const MODES = new Set(['general', 'manager', 'writing', 'research', 'video']);
export const SECRET_VALUE = 'sk-live-0123456789';

export function portabilityFixture(options: { fileDb?: boolean } = {}) {
  const temp = tempDir('wf-port-');
  const paths = ensurePaths(createPaths({ data: path.join(temp.dir, 'data'), resources: RESOURCES, workspace: path.join(temp.dir, 'workspace') }));
  const db = new Db(options.fileDb ? path.join(paths.data, 'workforce.db') : ':memory:');
  migrate(db);
  const recorder = recordingBus();
  const time = clock();
  const log = new MemoryLogger();
  const org = new Org({ db, bus: recorder.bus, clock: time, templatesDir: path.join(RESOURCES, 'agents') });
  const knowledge = new KnowledgeStore({ db, clock: time, bus: recorder.bus });
  const files = new Blobs({ db, blobs: paths.blobs, clock: time, log });
  const modes = { list: () => [], get: (key: string) => ({ key: MODES.has(key) ? key : 'general' }) };
  const secrets = { redact: (text: string) => text.replaceAll(SECRET_VALUE, 'secret://sec_1'), list: () => [] };
  const s = { db, bus: recorder.bus, clock: time, log, paths, org, knowledge, files, modes, secrets } as unknown as RuntimeServices;
  const portability = new Portability({ services: () => s });
  const manager = org.ensureSeed()!;
  return {
    s, db, org, knowledge, files, paths, log, time, portability, manager, events: recorder,
    cleanup: () => { try { db.close(); } catch { /* already closed */ } temp.cleanup(); },
    root: temp.dir,
  };
}

export type PortabilityFixture = ReturnType<typeof portabilityFixture>;

/** An agent-scoped knowledge row written by the human. */
export function remember(f: PortabilityFixture, agentId: string, title: string, body: string, extra: Record<string, unknown> = {}) {
  return f.knowledge.save({ scope: 'agent', scopeId: agentId, title, body, kind: 'fact', createdBy: 'human', ...extra });
}
