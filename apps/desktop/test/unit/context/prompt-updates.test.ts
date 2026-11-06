// Owns: default-following and durable review delivery for customized global prompts.
// Never: calls live models or changes real user data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { reviewPromptOverrides, promptUpdateReference } from '../../../src/runtime/context/prompt-updates.ts';
import { OVERRIDABLE, PromptTemplates, type PromptName } from '../../../src/runtime/context/templates.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';
import { clock, tempDir } from '../store/helpers.ts';

type Services = Parameters<typeof reviewPromptOverrides>[0];
const DEFAULT = '# Team rules\nWork toward the result.';
const NEXT = '# Team rules\nWork toward the result and report evidence.';

function setup() {
  const temp = tempDir('wf-prompt-updates-');
  const data = path.join(temp.dir, 'data');
  const resources = path.join(temp.dir, 'resources');
  mkdirSync(path.join(resources, 'prompts'), { recursive: true });
  mkdirSync(path.join(data, 'prompts'), { recursive: true });
  const database = path.join(data, 'test.db');
  let db = new Db(database);
  migrate(db);
  const time = clock();
  let queue = new WakeQueueImpl({ db, clock: time });
  const warnings: unknown[] = [];
  let agents = [{ id: 'manager', template: 'manager' }, { id: 'other' }] as Agent[];
  const s = {
    db, clock: time, paths: { data, resources },
    wakes: queue, org: { list: () => agents },
    log: { warn: (...args: unknown[]) => warnings.push(args) },
  } as unknown as Services;
  const file = (name: PromptName) => path.join(data, 'prompts', `${name}.md`);
  const ship = (text: string, name: PromptName = 'rules') => writeFileSync(path.join(resources, 'prompts', `${name}.md`), text);
  const own = (text: string, name: PromptName = 'rules') => writeFileSync(file(name), text);
  const templates = () => new PromptTemplates(() => path.join(resources, 'prompts'), () => undefined, { data: () => data });
  return {
    s, get db() { return db; }, get queue() { return queue; }, warnings, file, ship, own, templates,
    agents: (next: Agent[]) => { agents = next; },
    restart: () => {
      db.close();
      db = new Db(database);
      queue = new WakeQueueImpl({ db, clock: time });
      Object.assign(s, { db, wakes: queue });
    },
    done: () => { db.close(); temp.cleanup(); },
  };
}

test('plain defaults use the newest release without writing an override or waking an agent', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(DEFAULT); reviewPromptOverrides(f.s);
  f.ship(NEXT); reviewPromptOverrides(f.s);
  assert.equal(f.templates().text('rules'), NEXT);
  assert.equal(existsSync(f.file('rules')), false);
  assert.equal(f.queue.pending(), 0);
});

test('an unchanged copied default follows an update, including cleaned comments and CRLF', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(DEFAULT); f.own(`<!-- own copy -->\r\n${DEFAULT.replaceAll('\n', '\r\n')}\r\n`);
  reviewPromptOverrides(f.s);
  f.ship(NEXT); reviewPromptOverrides(f.s);
  assert.equal(readFileSync(f.file('rules'), 'utf8'), `${NEXT}\n`);
  assert.equal(f.queue.pending(), 0);
});

test('a custom override remains byte-for-byte intact and is offered only once across database reopen', (t) => {
  const f = setup(); t.after(f.done);
  const custom = '<!-- local agreement -->\r\nUse our agreed invoice wording.\r\n';
  f.ship(DEFAULT); f.own(custom); reviewPromptOverrides(f.s);
  const wake = f.queue.list('manager')[0];
  assert.equal(wake.reason, 'review');
  assert.equal(wake.origin?.source, 'system-prompt:rules');
  assert.match(wake.note!, /current configured model/);
  assert.ok(wake.note!.includes(f.file('rules')));
  assert.match(wake.note!, /replace.*adapt.*keep/s);
  assert.equal(readFileSync(f.file('rules'), 'utf8'), custom);
  f.queue.done([wake.id]);
  f.restart();
  reviewPromptOverrides(f.s);
  assert.equal(f.queue.pending(), 0);
  assert.equal(readFileSync(f.file('rules'), 'utf8'), custom);
});

test('the next default revision brings another complete reference and exactly one new review', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(DEFAULT); f.own('Custom team instructions.'); reviewPromptOverrides(f.s);
  f.queue.done(f.queue.list('manager').map((wake) => wake.id));
  const long = `${NEXT}\n${'New instructions.\n'.repeat(300)}`.trim();
  f.ship(long); reviewPromptOverrides(f.s); reviewPromptOverrides(f.s);
  const wakes = f.queue.list('manager');
  assert.equal(wakes.length, 1);
  const reference = promptUpdateReference(f.s.paths, 'rules', long);
  assert.ok(wakes[0].note!.includes(reference));
  assert.equal(readFileSync(reference, 'utf8'), `${long}\n`);
  assert.ok(wakes[0].note!.length < 4000);
});

test('a current default copied into the override needs no review', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(NEXT); f.own(NEXT); reviewPromptOverrides(f.s);
  assert.equal(f.queue.pending(), 0);
});

test('editing a prompt against an observed default waits for a new shipped revision before asking', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(DEFAULT); reviewPromptOverrides(f.s);
  f.own('Our intentionally customized team instructions.');
  f.restart(); reviewPromptOverrides(f.s);
  assert.equal(f.queue.pending(), 0);
  f.ship(NEXT); reviewPromptOverrides(f.s); reviewPromptOverrides(f.s);
  assert.equal(f.queue.list('manager').length, 1);
  assert.equal(readFileSync(f.file('rules'), 'utf8'), 'Our intentionally customized team instructions.');
});

test('no active reviewer leaves the offer retryable, then chooses a manager before the first agent', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(DEFAULT); f.own('Custom instructions.');
  f.agents([{ id: 'archived', template: 'manager', archivedAt: 1 }] as Agent[]);
  reviewPromptOverrides(f.s);
  assert.equal(new KvRepo(f.db).get('prompt-defaults', 'rules'), undefined);
  f.agents([{ id: 'first' }, { id: 'manager', template: 'manager' }] as Agent[]);
  reviewPromptOverrides(f.s);
  assert.equal(f.queue.list('manager').length, 1);
  assert.equal(f.queue.list('first').length, 0);
});

test('a wake failure rolls back its row and marker, so the next start retries', (t) => {
  const f = setup(); t.after(f.done);
  f.ship(DEFAULT); f.own('Custom instructions.');
  const wakes = { wake: (request: Parameters<RuntimeServices['wakes']['wake']>[0]) => { f.queue.wake(request); throw new Error('wake failed'); } } as unknown as RuntimeServices['wakes'];
  reviewPromptOverrides({ ...f.s, wakes });
  assert.equal(f.queue.pending(), 0);
  assert.equal(new KvRepo(f.db).get('prompt-defaults', 'rules'), undefined);
  assert.equal(f.warnings.length, 1);
  reviewPromptOverrides(f.s);
  assert.equal(f.queue.pending(), 1);
});

test('every overridable shipped prompt has its own reference and review source', (t) => {
  const f = setup(); t.after(f.done);
  for (const name of OVERRIDABLE) { f.ship(`${DEFAULT} ${name}`, name); f.own(`Custom ${name}`, name); }
  reviewPromptOverrides(f.s);
  const wakes = f.queue.list('manager');
  assert.equal(wakes.length, OVERRIDABLE.size);
  assert.equal(new Set(wakes.map((wake) => wake.origin?.source)).size, OVERRIDABLE.size);
  for (const name of OVERRIDABLE) assert.ok(wakes.some((wake) => wake.note!.includes(`${name}-`)));
});
