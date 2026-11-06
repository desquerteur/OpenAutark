// B-078 (D15): the personal manager is the agent from the manager template – a department head in mode manager beside
// it is never taken for it; when an employee joins, that personal manager gets one wake to set up a personal manager
// for them (org/member-welcome.ts), once per person, without hiring anyone itself.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { managerAgent } from '../../../src/shared/text/manager-chat.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { canWelcome, markExistingMembers, welcomeMember } from '../../../src/runtime/org/member-welcome.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

function setup() {
  const db = memoryDb();
  const time = clock();
  const org = new Org({ db, bus: recordingBus().bus, clock: time, templatesDir: path.join(RESOURCES, 'agents') });
  const wakes = new WakeQueueImpl({ db, clock: time });
  return { db, time, org, wakes, s: { db, org, wakes, clock: time } };
}

test('managerAgent: the manager template wins over an older department head in mode manager', () => {
  const { org } = setup();
  const head = org.create({ template: 'head', name: 'Paula', role: 'Head of programming', createdBy: HUMAN_ID });
  const seed = org.create({ template: 'manager', name: 'Konrad', createdBy: HUMAN_ID });
  assert.equal(head.mode, 'manager');
  assert.equal(head.managerId, undefined, 'the head reports to the person');
  assert.equal(managerAgent(org.list())?.id, seed.id);
  org.archive(seed.id);
  assert.equal(managerAgent(org.list())?.id, head.id, 'without the seed a manager-mode root still answers');
});

test('welcomeMember: one wake for the personal manager per person, in its own voice; nothing without a manager', () => {
  const { org, wakes, s } = setup();
  assert.equal(canWelcome(s), true);
  assert.equal(canWelcome({ tasks: {} }), false, 'a narrower service view welcomes nobody');
  assert.equal(welcomeMember(s, { id: 'per_anna', label: 'Anna Berg · Designer' }), false, 'no agent yet');
  const seed = org.ensureSeed()!;
  assert.equal(welcomeMember(s, { id: 'per_anna', label: 'Anna Berg · Designer' }), true);
  assert.equal(welcomeMember(s, { id: 'per_anna', label: 'Anna Berg · Designer' }), false, 'a second device of hers: no second wake');
  const [wake] = wakes.list(seed.id);
  assert.equal(wakes.list(seed.id).length, 1);
  assert.equal(wake.reason, 'event');
  assert.deepEqual(wake.origin, { source: 'people', label: 'Someone joined' }, 'no person in the origin');
  assert.match(wake.note!, /^Anna Berg · Designer \(per_anna\) just joined our organisation\. A personal manager or assistant of their own is mine to set up/);
  assert.match(wake.note!, /one line to Anna Berg saying who works for them now\.$/);
  assert.equal(org.list().length, 1, 'nobody hired by the app');
  assert.equal(welcomeMember(s, { id: 'per_ben', label: 'Ben' }), true, 'another person gets their own wake');
});

test('markExistingMembers: people active before B-078 count as welcomed once; someone invited then is welcomed when they join', () => {
  const { db, org, wakes, s } = setup();
  const seed = org.ensureSeed()!;
  db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES ('per_old', 'Olga', 'active', 0, 0), ('per_inv', 'Ivo', 'invited', 0, 0), ('per_gone', 'Gus', 'revoked', 0, 0)`);
  assert.equal(markExistingMembers(s), 1);
  assert.equal(markExistingMembers(s), 0, 'once');
  assert.equal(welcomeMember(s, { id: 'per_old', label: 'Olga' }), false, 'her second phone after the update: no wake');
  assert.equal(welcomeMember(s, { id: 'per_inv', label: 'Ivo' }), true, 'he joins now');
  assert.equal(wakes.list(seed.id).length, 1);
});
