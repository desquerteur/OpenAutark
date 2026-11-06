// Wave 3 review fixes: the agent core never overwrites an edit unseen and follows the folder over time.
// - agents.update `base`: an editor draft that started before SYSTEM.md was changed on disk (and taken over) is
//   a conflict; a role-only save leaves the file alone; a base that is current saves;
// - agents.saveMainSkill `base`: a SKILL.md changed on disk while its editor was open is a conflict;
// - a turn-time stat goes through the watcher's debounce: an emptied or briefly missing SYSTEM.md (an editor's save
//   in progress) never reaches a prompt or the history before it settles;
// - the data folder watcher an error stopped is armed again on the next use (not before REARM_MS) and checks the folders once;
// - agent.json follows a rename after a restart; a Main Skill changed on disk is visible to the listeners at once.
// Owns: these assertions only. Never: real timers beyond a debounce of 1 ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REARM_MS } from '../../../src/runtime/root/watcher.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register as registerCore } from '../../../src/runtime/rpc/handlers/agent-core.ts';
import { register as registerOrg } from '../../../src/runtime/rpc/handlers/org.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { coreFixture, fakeWatch, skillMd } from './fixture.ts';

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;
const read = (file: string) => readFileSync(file, 'utf8');
const OWNER: ClientScope = { kind: 'owner' };

function setup() {
  const fake = fakeWatch();
  const f = coreFixture({ watch: fake.watch });
  const writer = f.org.create({ name: 'Writer', instructions: 'A.', createdBy: 'human' });
  f.org.setCoreFiles(f.core);
  f.core.start();
  const services = { org: f.org, skills: f.skills, agentCore: f.core, db: f.db, clock: f.time } as unknown as RuntimeServices;
  const table = new HandlerTable();
  registerOrg(table);
  registerCore(table);
  const call = async (method: string, params: unknown) => table.get(method)!.handler(params as never, { scope: OWNER, services, extras: {}, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext);
  return { f, fake, writer, call };
}

test('a stale editor draft never overwrites SYSTEM.md changed on disk and taken over meanwhile', async () => {
  const { f, fake, writer, call } = setup();
  try {
    writeFileSync(f.file(writer.id), 'B from my editor.');
    fake.fire(`agents/${writer.id}/SYSTEM.md`);
    f.core.flush();
    assert.equal(f.org.get(writer.id)!.instructions, 'B from my editor.', 'taken over (the old conflict window is over)');
    await assert.rejects(call('agents.update', { id: writer.id, patch: { instructions: 'A. Edited.' }, base: { instructions: 'A.' } }), code('conflict'));
    assert.equal(read(f.file(writer.id)), 'B from my editor.', 'never overwritten unseen');
    await call('agents.update', { id: writer.id, patch: { role: 'Editor' }, base: { instructions: 'A.' } });
    assert.equal(read(f.file(writer.id)), 'B from my editor.', 'a role-only save carries no instructions');
    await call('agents.update', { id: writer.id, patch: { instructions: 'B from my editor.' }, base: { instructions: 'A.' } }); // says what is there: no conflict
    await call('agents.update', { id: writer.id, patch: { instructions: 'C.' }, base: { instructions: 'B from my editor.\r\n' } });
    assert.equal(read(f.file(writer.id)), 'C.\n');
    await assert.rejects(call('agents.update', { id: writer.id, patch: { instructions: 'D.' }, base: { instructions: 'C.', extra: 1 } }), code('bad_request'));
  } finally { f.cleanup(); }
});

test('a Main Skill changed on disk while its editor was open is a conflict, never overwritten unseen', async () => {
  const { f, writer, call } = setup();
  try {
    await call('agents.saveMainSkill', { agentId: writer.id, name: 'house-style', description: 'Our house style.', body: 'Short.' });
    const file = path.join(f.data, 'agents', writer.id, 'skills', 'house-style', 'SKILL.md');
    writeFileSync(file, skillMd('house-style', 'Our house style.', 'Shorter, from my editor.'));
    f.library.invalidate();
    const stale = { agentId: writer.id, name: 'house-style', description: 'Our house style.', body: 'Short. More.', base: { description: 'Our house style.', body: 'Short.' } };
    await assert.rejects(call('agents.saveMainSkill', stale), code('conflict'));
    assert.match(read(file), /Shorter, from my editor\./);
    await call('agents.saveMainSkill', { ...stale, body: 'Shorter. More.', base: { description: 'Our house style.', body: 'Shorter, from my editor.' } });
    assert.match(read(file), /Shorter\. More\./);
    await assert.rejects(call('agents.saveMainSkill', { ...stale, modes: ['writing'] }), code('bad_request'), 'Main Skills have no modes');
  } finally { f.cleanup(); }
});

test('an emptied or briefly missing SYSTEM.md (a save in progress) waits for the debounce', () => {
  const { f, fake, writer } = setup();
  try {
    writeFileSync(f.file(writer.id), '');
    assert.equal(f.core.instructions(f.org.get(writer.id)!), 'A.', 'the prompt keeps the last good text');
    writeFileSync(f.file(writer.id), 'A. Saved.');
    fake.fire(`agents/${writer.id}/SYSTEM.md`);
    f.core.flush();
    assert.equal(f.org.get(writer.id)!.instructions, 'A. Saved.');

    rmSync(f.file(writer.id)); // an editor that deletes, then renames its temp file into place
    assert.equal(f.core.instructions(f.org.get(writer.id)!), 'A. Saved.');
    writeFileSync(f.file(writer.id), 'A. Renamed into place.');
    f.core.flush();
    assert.equal(f.org.get(writer.id)!.instructions, 'A. Renamed into place.');
    assert.equal(f.core.info(writer.id, false).notice, undefined, 'no spurious "missing" notice');

    writeFileSync(f.file(writer.id), ''); // the person really cleared it: taken over once it settled
    f.core.instructions(f.org.get(writer.id)!);
    f.core.flush();
    assert.equal(f.org.get(writer.id)!.instructions, '');
  } finally { f.cleanup(); }
});

test('a watcher an error stopped is armed again on the next use and checks the folders once', () => {
  const { f, fake, writer } = setup();
  try {
    fake.fail();
    assert.ok(f.log.entries.some((entry) => entry.message === 'data folder watcher stopped'));
    const dir = path.join(f.data, 'agents', writer.id, 'skills', 'while-off');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), skillMd('while-off', 'Written while nobody watched.'));
    const before = f.events.of('skills.changed').length;
    f.core.instructions(f.org.get(writer.id)!);
    assert.equal(fake.targets.length, 1, 'not before REARM_MS');
    f.time.advance(REARM_MS + 1);
    f.core.instructions(f.org.get(writer.id)!);
    assert.equal(fake.targets.length, 2, 'armed again');
    f.core.flush();
    assert.equal(f.events.of('skills.changed').length, before + 1, 'what changed meanwhile is told once');
    assert.ok(f.library.mainFor(f.org.get(writer.id)!).some((skill) => skill.name === 'while-off'), 'and the library sees it at once');
  } finally { f.cleanup(); }
});

test('agent.json follows a rename after a restart', () => {
  const { f, writer } = setup();
  try {
    f.core.stop();
    const again = f.restart();
    again.start();
    f.org.update(writer.id, { name: 'Renamed' });
    assert.equal(JSON.parse(read(path.join(f.data, 'agents', writer.id, 'agent.json'))).name, 'Renamed');
    again.stop();
  } finally { f.cleanup(); }
});
