// Wave 3 review fixes: the agent core folders stay consistent with the agents and the skill library.
// - an id that cannot name a folder (an old import) keeps its instructions in the app: edits work, no folder, a notice;
// - a SYSTEM.md link is never followed (a notice, the last good text stays in use);
// - agents.core names Main Skills that sit in the wrong folder (an own copy of a shared name hides nothing, B-066) and
//   gives the skills' paths to the owner only.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { realtimeInstructions } from '../../../src/runtime/calls/realtime/setup.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { coreFixture, skillMd } from './fixture.ts';

function setup(hook = true) {
  const f = coreFixture();
  if (hook) f.org.setCoreFiles(f.core);
  return f;
}

const put = (dir: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'SKILL.md'), text); };

test('an id that cannot name a folder keeps its instructions in the app', () => {
  const f = setup(false);
  try {
    const odd = f.org.create({ name: 'Odd', instructions: 'Old import.', createdBy: 'human' });
    f.db.run('UPDATE agents SET id = ? WHERE id = ?', ['agent one', odd.id]); // ids db/import-v7.ts may keep
    f.org.setCoreFiles(f.core);
    const counts = f.core.start();
    assert.equal(counts.skipped, 1);
    assert.equal(f.org.update('agent one', { instructions: 'Edited in the app.' }).instructions, 'Edited in the app.', 'the edit is not refused');
    assert.equal(f.core.instructions(f.org.get('agent one')!), 'Edited in the app.');
    const info = f.core.info('agent one', true);
    assert.equal(info.notice?.problem, 'no-folder');
    assert.deepEqual([info.inUse, info.folder, info.mainSkills], [false, undefined, []]);
    assert.ok(!existsSync(path.join(f.data, 'agents', 'agent one')));
  } finally { f.cleanup(); }
});

test('a SYSTEM.md link is never followed', (t) => {
  const f = setup();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Mine.', createdBy: 'human' });
    f.core.start();
    const elsewhere = path.join(f.temp.dir, 'elsewhere.md');
    writeFileSync(elsewhere, 'Text from another folder.');
    rmSync(f.file(writer.id));
    try { symlinkSync(elsewhere, f.file(writer.id), 'file'); } catch { t.skip('this system does not allow file links here'); return; }
    assert.equal(f.core.instructions(f.org.get(writer.id)!), 'Mine.');
    const info = f.core.info(writer.id, false);
    assert.equal(info.notice?.problem, 'unreadable');
    assert.equal(f.org.get(writer.id)!.instructions, 'Mine.');
    f.org.update(writer.id, { instructions: 'Saved in the app.' });
    assert.equal(readFileSync(elsewhere, 'utf8'), 'Text from another folder.', 'never written through the link');
    assert.equal(readFileSync(f.file(writer.id), 'utf8'), 'Saved in the app.\n');
  } finally { f.cleanup(); }
});

test('other readers that act on the instructions read SYSTEM.md: a voice call\'s brief', () => {
  const f = setup();
  try {
    const writer = f.org.create({ name: 'Writer', instructions: 'Cached.', createdBy: 'human' });
    f.core.start();
    writeFileSync(f.file(writer.id), 'From SYSTEM.md, not taken over yet.');
    const s = { org: f.org, agentCore: f.core, chats: { get: () => ({ title: 'Plan' }) }, settings: { get: () => ({}) } } as unknown as RuntimeServices;
    const brief = realtimeInstructions(s, writer.id, 'cv_1');
    assert.ok(brief.includes('From SYSTEM.md, not taken over yet.') && !brief.includes('Cached.'), brief);
  } finally { f.cleanup(); }
});

test('agents.core names misplaced Main Skills; an own copy of a shared name is no problem (B-066 routes); skill paths only for the owner', () => {
  const f = setup();
  try {
    const one = f.org.create({ name: 'One', instructions: '', createdBy: 'human' });
    const two = f.org.create({ name: 'Two', instructions: '', createdBy: 'human' });
    f.core.start();
    put(path.join(f.resources, 'skills', 'writing-tips'), skillMd('writing-tips', 'A built-in skill.'));
    const [first, second] = [one.id, two.id].sort();
    put(path.join(f.data, 'agents', first, 'skills', 'writing-tips'), skillMd('writing-tips', 'Hides the built-in.'));
    put(path.join(f.data, 'agents', first, 'skills', 'both'), skillMd('both', 'The first agent\'s.'));
    put(path.join(f.data, 'agents', second, 'skills', 'both'), skillMd('both', 'The second agent\'s.'));
    put(path.join(f.data, 'agents', second, 'skills'), skillMd('loose', 'Directly in skills/.'));
    put(path.join(f.data, 'agents', second, 'skills', 'group', 'deep'), skillMd('deep', 'Too deep.'));
    const winner = f.core.info(first, false);
    assert.equal(winner.skillProblems, undefined, 'its own copies are no problem');
    assert.deepEqual(winner.mainSkills.map((skill) => skill.path), ['', ''], 'no paths outside the owner scope');
    assert.ok(f.core.info(first, true).mainSkills.every((skill) => skill.path.startsWith(path.join(f.data, 'agents', first))));
    assert.deepEqual(f.core.info(second, false).skillProblems, [
      { folder: '', problem: 'misplaced' }, { folder: 'group/deep', problem: 'misplaced' },
    ]);
  } finally { f.cleanup(); }
});
