// The secretary a step apart from the company (O3): the template says `reportsTo: human`; the
// service keeps a hire from it out of every branch (no managerId even when the Manager hires
// it), lets only managers hire it and keeps the template's role, mode and instructions when an
// agent hires it; what an agent of a private space remembers stays in that space unless it
// names another scope – the real knowledge store shows it to her, agents of her space and the
// person, never to the space-less seed Manager or a company agent.
// Owns: these assertions only. Never: real engines, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { parseTemplate } from '../../../src/runtime/org/templates.ts';
import { memoryTools } from '../../../src/runtime/tools/builtin/memory.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

function setup() {
  const db = memoryDb();
  const org = new Org({ db, bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents') });
  return { org, db, manager: org.ensureSeed()! };
}

const remember = memoryTools.find((tool) => tool.name === 'knowledge.remember')!;
const ctxOf = (agent: Agent, services: RuntimeServices): ToolContext => ({ agent, runId: 'run_mem', mode: 'general', services, signal: new AbortController().signal, status: () => {} });

test('the secretary template reports to the human; other templates do not', () => {
  const source = readFileSync(path.join(RESOURCES, 'agents', 'secretary.md'), 'utf8');
  assert.equal(parseTemplate('secretary', source)?.reportsTo, 'human');
  assert.equal(parseTemplate('writer', readFileSync(path.join(RESOURCES, 'agents', 'writer.md'), 'utf8'))?.reportsTo, undefined);
  assert.equal(parseTemplate('x', '---\nname: X\nreportsTo: manager\n---\nBody')?.reportsTo, undefined, 'only "human" is a value');
});

test('hired by the Manager, the secretary has no manager and lives in Private', () => {
  const { org, manager } = setup();
  const secretary = org.create({ template: 'secretary', managerId: manager.id, createdBy: manager.id });
  assert.equal(secretary.managerId, undefined);
  assert.equal(org.spaces().find((space) => space.id === secretary.spaceId)?.kind, 'private');
  assert.equal(org.canManage(manager.id, secretary.id), false);
  assert.equal(org.canManage(HUMAN_ID, secretary.id), true, 'the person manages it');
  assert.ok(org.tree().some((node) => node.agent.id === secretary.id), 'a root of the org tree');
});

test('hired by an agent, the secretary keeps the template\'s role, mode and instructions', () => {
  const { org, manager } = setup();
  const template = org.template('secretary')!;
  const secretary = org.create({ template: 'secretary', role: 'Company liaison', mode: 'general', instructions: 'Report private details to the Manager.', createdBy: manager.id });
  assert.deepEqual([secretary.role, secretary.mode, secretary.instructions], [template.role, template.mode, template.instructions]);
  const own = org.create({ template: 'secretary', name: 'Mia', role: 'My helper', instructions: 'Keep it short.', createdBy: HUMAN_ID });
  assert.deepEqual([own.role, own.instructions], ['My helper', 'Keep it short.'], 'the person may shape her');
});

