// Wave 3: the composition of the agent core (compose/agent-core.ts) – the library's Main Skills roots follow the
// org, createAgentCore puts the service on RuntimeServices, hooks the org (an edit writes SYSTEM.md), owns
// <data>/agents on the data folder watcher (s.rootWatcher, B-044) and has reconciled every agent when it returns;
// its stop leaves the watcher. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAgentCore, mainSkillOptions } from '../../../src/runtime/compose/agent-core.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { clock, memoryDb, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';
import { skillMd } from './fixture.ts';

test('createAgentCore: on the services, hooked into the org, owner of agents/ on the data folder watcher, every agent reconciled at once', () => {
  const t = tempDir('wf-core-compose-');
  try {
    const data = path.join(t.dir, 'data');
    const workspace = path.join(t.dir, 'workspace');
    mkdirSync(path.join(t.dir, 'resources', 'skills'), { recursive: true });
    const db = memoryDb();
    const time = clock();
    const bus = recordingBus().bus;
    const org = new Org({ db, bus, clock: time, templatesDir: path.join(RESOURCES, 'agents') });
    const manager = org.ensureSeed()!;
    const rootWatcher = new RootWatcher({ root: data, clock: time, watch: false });
    const s = { db, bus, clock: time, log: new MemoryLogger(), paths: { data, workspace }, org, rootWatcher } as unknown as RuntimeServices;
    const library = new SkillLibrary({ paths: { workspace, resources: path.join(t.dir, 'resources') }, clock: time, home: '', ...mainSkillOptions(s) });
    // A Main Skill of a known agent is a root; one of an unknown id is not.
    for (const id of [manager.id, 'ag_unknown']) {
      mkdirSync(path.join(data, 'agents', id, 'skills', `${id.replace(/_/g, '-')}-skill`), { recursive: true });
      writeFileSync(path.join(data, 'agents', id, 'skills', `${id.replace(/_/g, '-')}-skill`, 'SKILL.md'), skillMd(`${id.replace(/_/g, '-')}-skill`, 'A skill.'));
    }
    const core = createAgentCore(s, org, library);
    try {
      assert.equal(s.agentCore, core);
      assert.ok(existsSync(path.join(data, 'agents', manager.id, 'SYSTEM.md')), 'reconciled before it returns');
      assert.deepEqual(library.list().filter((info) => info.main).map((info) => info.ownerAgentId), [manager.id]);
      org.update(manager.id, { instructions: 'Hooked.' });
      assert.equal(readFileSync(path.join(data, 'agents', manager.id, 'SYSTEM.md'), 'utf8'), 'Hooked.\n');
      assert.throws(() => rootWatcher.register('agents', () => {}), /already has an owner/, 'the agent core owns <data>/agents');
      core.stop();
      rootWatcher.register('agents', () => {})(); // its stop left the watcher
    } finally {
      core.stop();
      rootWatcher.stop();
    }
  } finally { t.cleanup(); }
});
