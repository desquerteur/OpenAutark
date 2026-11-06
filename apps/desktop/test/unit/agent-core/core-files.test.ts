// Wave 3: SYSTEM.md in <data>/agents/<id>/ is the one source of an agent's instructions.
// - start: every agent (archived too) gets its folder once from its stored instructions; a second start changes nothing;
// - an edit in the app writes SYSTEM.md first and is an agent revision; an edit without new instructions leaves it alone;
//   a folder that cannot be written refuses the edit (nothing saved);
// - an edit on disk becomes the person's edit with undo; the prompt uses the file's text at once;
// - too large, binary, non-UTF-8 or unreadable files keep the last good text in use with a quiet notice; fixing clears it;
//   the app replacing such a file keeps it once as SYSTEM.rejected.md;
// - a deleted SYSTEM.md is written again (never dropped); an empty file means no instructions;
// - an app edit while an outside edit waits is a conflict, never an overwrite;
// - the data folder watcher hands SYSTEM.md and Main Skill changes under agents/ over (temporary files ignored).
// Owns: these assertions only. Never: real timers beyond a debounce of 1 ms, or the person's folders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REJECTED_FILE } from '../../../src/runtime/agent-core/service.ts';
import { classify } from '../../../src/runtime/agent-core/watch.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { coreFixture, fakeWatch, skillMd } from './fixture.ts';

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;
const read = (file: string) => readFileSync(file, 'utf8');

test('start: every agent gets its folder once from its instructions; a second start changes nothing', () => {
  const f = coreFixture();
  try {
    const manager = f.org.ensureSeed()!;
    const writer = f.org.create({ name: 'Writer', role: 'Copywriter', instructions: 'Write short.\r\nNo jargon.  ', createdBy: 'human' });
    const old = f.org.create({ name: 'Old', instructions: 'Old ways.', createdBy: 'human' });
    f.org.archive(old.id);
    const counts = f.core.start();
    assert.equal(counts.created, 3);
    assert.equal(read(f.file(writer.id)), 'Write short.\nNo jargon.\n');
    assert.equal(read(f.file(old.id)), 'Old ways.\n', 'archived agents keep their folder');
    assert.equal(read(f.file(manager.id)), manager.instructions.trim() ? `${manager.instructions.replace(/\r\n?/g, '\n').trimEnd()}\n` : '');
    const label = JSON.parse(read(path.join(f.data, 'agents', writer.id, 'agent.json')));
    assert.deepEqual(label, { format: 'workforce-agent-core', version: 1, id: writer.id, name: 'Writer', role: 'Copywriter' });
    const mtime = statSync(f.file(writer.id)).mtimeMs;
    f.core.stop();

    const again = f.restart();
    const second = again.start();
    again.stop();
    assert.deepEqual([second.created, second.updated, second.same, second.problem], [0, 0, 3, 0]);
    assert.equal(statSync(f.file(writer.id)).mtimeMs, mtime, 'idempotent: the file is not written again');
    assert.equal(f.org.get(writer.id)!.instructions, 'Write short.\r\nNo jargon.  ', 'the stored text stays as it was');
  } finally { f.cleanup(); }
});

test('an edit in the app writes SYSTEM.md first; other edits leave the file alone', () => {
  const f = coreFixture();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Old.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    f.org.update(writer.id, { instructions: 'Be brief.' });
    assert.equal(read(f.file(writer.id)), 'Be brief.\n');
    const mtime = statSync(f.file(writer.id)).mtimeMs;
    f.org.update(writer.id, { role: 'Editor', name: 'Wren' });
    assert.equal(statSync(f.file(writer.id)).mtimeMs, mtime);
    assert.deepEqual(JSON.parse(read(path.join(f.data, 'agents', writer.id, 'agent.json'))).name, 'Wren', 'agent.json follows a rename');
    // A hire gets its folder at once.
    const hired = f.org.create({ name: 'Hired', instructions: 'Hello.', createdBy: 'human' });
    assert.equal(read(f.file(hired.id)), 'Hello.\n');
  } finally { f.cleanup(); }
});

test('a folder that cannot be written refuses the edit; nothing is saved and the view gets a notice', () => {
  const f = coreFixture();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Keep me.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    const folder = path.join(f.data, 'agents', writer.id);
    rmSync(folder, { recursive: true, force: true });
    writeFileSync(folder, 'a file where the folder belongs');
    assert.throws(() => f.org.update(writer.id, { instructions: 'Lost?' }), code('unavailable'));
    assert.equal(f.org.get(writer.id)!.instructions, 'Keep me.');
    const info = f.core.info(writer.id, true);
    assert.equal(info.notice?.problem, 'unwritable');
    assert.equal(info.inUse, false);
    assert.equal(f.core.instructions(f.org.get(writer.id)!), 'Keep me.', 'the prompt keeps the stored text');
  } finally { f.cleanup(); }
});

test('an edit on disk becomes the person\'s edit with undo; the prompt uses the file at once', () => {
  const f = coreFixture();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Original.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    writeFileSync(f.file(writer.id), '﻿Use British spelling.\r\n');
    assert.equal(f.core.instructions(f.org.get(writer.id)!), 'Use British spelling.', 'before the stored text caught up');
    assert.equal(f.deferred.length, 1, 'one follow-up takes it over');
    f.runDeferred();
    assert.equal(f.org.get(writer.id)!.instructions, 'Use British spelling.');
    assert.ok(read(f.file(writer.id)).startsWith('﻿'), 'the person\'s bytes are not rewritten by the take-over');
  } finally { f.cleanup(); }
});

test('too large, binary, non-UTF-8 files keep the last good instructions with a quiet notice; fixing clears it', () => {
  const f = coreFixture();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Good.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    const cases: Array<[string | Buffer, string]> = [
      ['x'.repeat(20_001), 'too-large'],
      [Buffer.alloc(140 * 1024, 0x61), 'too-large'],
      [Buffer.from([0x41, 0x00, 0x42]), 'not-text'],
      [Buffer.from([0xff, 0xfe, 0x41]), 'not-text'],
    ];
    for (const [content, problem] of cases) {
      writeFileSync(f.file(writer.id), content);
      const info = f.core.info(writer.id, false);
      assert.equal(info.notice?.problem, problem);
      assert.equal(info.inUse, false);
      assert.equal(info.folder, undefined, 'no path without the owner');
      assert.equal(f.org.get(writer.id)!.instructions, 'Good.');
      assert.equal(f.core.instructions(f.org.get(writer.id)!), 'Good.');
    }
    assert.ok(f.events.of('agentCore.changed').length >= 2, 'the view hears about it');
    writeFileSync(f.file(writer.id), 'Fixed.');
    const fixed = f.core.info(writer.id, true);
    assert.equal(fixed.notice, undefined);
    assert.equal(fixed.inUse, true);
    assert.equal(fixed.folder, path.join(f.data, 'agents', writer.id));
    assert.equal(f.org.get(writer.id)!.instructions, 'Fixed.');
    // The app replacing a problem file keeps it once.
    writeFileSync(f.file(writer.id), 'y'.repeat(20_001));
    f.core.info(writer.id, false);
    f.org.update(writer.id, { instructions: 'From the app.' });
    assert.equal(read(f.file(writer.id)), 'From the app.\n');
    assert.equal(read(path.join(f.data, 'agents', writer.id, REJECTED_FILE)), 'y'.repeat(20_001));
    assert.equal(f.core.info(writer.id, false).notice, undefined);
  } finally { f.cleanup(); }
});

test('a deleted SYSTEM.md is written again from the last good text; an empty file means no instructions', () => {
  const f = coreFixture();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Never drop me.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    rmSync(f.file(writer.id));
    assert.equal(f.core.instructions(f.org.get(writer.id)!), 'Never drop me.');
    f.runDeferred();
    assert.equal(read(f.file(writer.id)), 'Never drop me.\n');
    assert.equal(f.core.info(writer.id, false).notice?.problem, 'missing', 'the recreated file is named once');
    writeFileSync(f.file(writer.id), '');
    const info = f.core.info(writer.id, false);
    assert.equal(info.notice, undefined, 'an edit by the person clears the notice');
    assert.equal(f.org.get(writer.id)!.instructions, '');
    // A folder removed while the app was off: written again at the next start, with the notice.
    f.core.stop();
    rmSync(f.file(writer.id));
    const again = f.restart();
    again.start();
    assert.equal(again.info(writer.id, false).notice?.problem, 'missing');
    rmSync(f.file(writer.id));
    const rewritten = again.info(writer.id, false);
    assert.deepEqual([rewritten.notice?.problem, rewritten.inUse], ['missing', true], 'written again by this very call: in use');
    again.stop();
  } finally { f.cleanup(); }
});

test('an app edit while an outside edit waits is a conflict; the outside text is taken over first', () => {
  const f = coreFixture();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Base.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    writeFileSync(f.file(writer.id), 'Outside.');
    assert.throws(() => f.org.update(writer.id, { instructions: 'App.' }), code('conflict'));
    assert.equal(read(f.file(writer.id)), 'Outside.', 'never overwritten unseen');
    f.runDeferred();
    assert.equal(f.org.get(writer.id)!.instructions, 'Outside.');
    f.org.update(writer.id, { instructions: 'App.' });
    assert.equal(read(f.file(writer.id)), 'App.\n');
  } finally { f.cleanup(); }
});

test('the folder watcher hands SYSTEM.md and Main Skill changes over; temporary files are ignored', () => {
  const fake = fakeWatch();
  const f = coreFixture({ watch: fake.watch });
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Before.', createdBy: 'human' });
    f.org.setCoreFiles(f.core);
    f.core.start();
    assert.deepEqual(fake.targets, [f.data], 'one recursive watch on the data folder');
    writeFileSync(f.file(writer.id), 'Watched.');
    fake.fire(`agents${path.sep}${writer.id}${path.sep}SYSTEM.md.42.tmp`);
    f.core.flush();
    assert.equal(f.org.get(writer.id)!.instructions, 'Before.', 'a temporary file hands nothing over');
    fake.fire(`agents${path.sep}${writer.id}${path.sep}SYSTEM.md`);
    f.core.flush();
    assert.equal(f.org.get(writer.id)!.instructions, 'Watched.');

    const before = f.events.of('skills.changed').length;
    const skillDir = path.join(f.data, 'agents', writer.id, 'skills', 'house-style');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd('house-style', 'Our house style for every text.'));
    fake.fire(`agents/${writer.id}/skills/house-style/SKILL.md`);
    f.core.flush();
    assert.equal(f.events.of('skills.changed').length, before + 1);
    assert.ok(f.events.of('agentCore.changed').some((event) => (event as { agentId: string }).agentId === writer.id));
    fake.fire(`agents/${writer.id}/skills/house-style/SKILL.md`);
    f.core.flush();
    assert.equal(f.events.of('skills.changed').length, before + 1, 'an unchanged folder says nothing again');
    fake.fire(null); // no file name: every agent is checked
    f.core.flush();
    assert.ok(existsSync(f.file(writer.id)));
  } finally { f.cleanup(); }
});

test('classify: which agent and part of its folder an event names', () => {
  assert.deepEqual(classify('ag_1\\SYSTEM.md'), { agentId: 'ag_1', change: { system: true, skills: false, all: false } });
  assert.deepEqual(classify('ag_1/skills/a/SKILL.md'), { agentId: 'ag_1', change: { system: false, skills: true, all: false } });
  assert.deepEqual(classify('ag_1'), { agentId: 'ag_1', change: { system: true, skills: true, all: true } });
  assert.deepEqual(classify('ag_1/agent.json'), { agentId: 'ag_1', change: { system: false, skills: false, all: false, manifest: true } }); // B-044: its home
  assert.equal(classify('ag_1/agent.json/x'), undefined);
  assert.equal(classify('ag_1/SYSTEM.md.7.tmp'), undefined);
  assert.equal(classify('../x/SYSTEM.md'), undefined);
});
