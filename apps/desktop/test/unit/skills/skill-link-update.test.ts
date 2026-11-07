// AF-007: updating a skill installed from a link – the source is read again with its kept ref and folder, the preview
// lists what changes (lines of text files, the person's own edits, new scripts, the description, the commit), the person's
// added files are kept, an apply swaps the folder in one step and refuses when the folder changed since the check; an
// uploaded skill needs its new ZIP; a renamed skill is refused; only folders skills.linked found can be updated.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SkillLinks } from '../../../src/runtime/skills/links/service.ts';
import { lineChanges, readRecord } from '../../../src/runtime/skills/links/install.ts';
import { fakeFetch, githubZip, library, skillMd, zip } from './links-fixture.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';

const URL_V = 'https://github.com/o/r/tree/main/skills/pdf';
const ARCHIVE = 'https://github.com/o/r/archive/main.zip';
const V1 = { 'skills/pdf/SKILL.md': skillMd('pdf', 'PDF forms.'), 'skills/pdf/forms.md': 'one\ntwo\nthree\n', 'skills/pdf/old.md': 'old' };
const V2 = { 'skills/pdf/SKILL.md': skillMd('pdf', 'PDF forms and tables.'), 'skills/pdf/forms.md': 'one\n2\nthree\nfour\n', 'skills/pdf/scripts/new.sh': 'echo new' };
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);

function setup() {
  const lib = library();
  const table: Record<string, Buffer | number> = { [ARCHIVE]: githubZip('r-main', V1, C1) };
  const uploads = new Map<string, { ref: FileRef; bytes: Buffer }>();
  let ids = 0;
  const links = new SkillLinks({
    fetch: fakeFetch(table), clock: lib.clock, skills: lib.skills, agents: () => [],
    files: { get: (id) => uploads.get(id)?.ref, read: async (id) => uploads.get(id)!.bytes },
    changed: () => lib.skills.invalidate(), id: () => `u${++ids}`,
  });
  const upload = (name: string, bytes: Buffer): string => {
    const id = String(uploads.size + 1).padStart(64, '0');
    uploads.set(id, { ref: { id, name, mime: 'application/zip', size: bytes.byteLength, createdAt: 0 }, bytes });
    return id;
  };
  const dir = path.join(lib.workspace, 'skills', 'pdf');
  return { ...lib, table, links, upload, dir, done: () => rmSync(lib.root, { recursive: true, force: true }) };
}

async function installV1(t: ReturnType<typeof setup>) {
  const preview = await t.links.preview({ url: URL_V });
  await t.links.install({ previewId: preview.id, routes: [''], target: { kind: 'shared' } });
}

test('the update preview lists changed, added and removed files with their lines, new scripts, the description and the commit', async () => {
  const t = setup();
  try {
    await installV1(t);
    t.table[ARCHIVE] = githubZip('r-main', V2, C2);
    const check = await t.links.checkUpdate({ path: t.dir });
    assert.deepEqual(check.changes.map((change) => [change.change, change.path]), [['changed', 'SKILL.md'], ['changed', 'forms.md'], ['added', 'scripts/new.sh'], ['removed', 'old.md']]);
    assert.deepEqual(check.changes.find((change) => change.path === 'forms.md')!.lines, { added: 2, removed: 1 });
    assert.equal(check.changes.some((change) => change.local), false);
    assert.deepEqual(check.scripts, ['scripts/new.sh']);
    assert.deepEqual(check.description, { before: 'PDF forms.', after: 'PDF forms and tables.' });
    assert.deepEqual(check.commit, { before: C1, after: C2 });
    assert.equal(check.unchanged, 0);
    assert.equal(readFileSync(path.join(t.dir, 'forms.md'), 'utf8'), 'one\ntwo\nthree\n', 'a check changes nothing');

    const linked = t.links.applyUpdate({ previewId: check.id });
    assert.equal(linked.commit, C2);
    assert.equal(readFileSync(path.join(t.dir, 'forms.md'), 'utf8'), 'one\n2\nthree\nfour\n');
    assert.ok(existsSync(path.join(t.dir, 'scripts', 'new.sh')));
    assert.equal(existsSync(path.join(t.dir, 'old.md')), false);
    assert.equal(existsSync(path.join(t.workspace, 'skills', '.installing')), false);
    const record = readRecord(t.dir)!;
    assert.equal(record.installedAt < record.updatedAt || record.installedAt === record.updatedAt, true);
    assert.deepEqual(Object.keys(record.files).sort(), ['SKILL.md', 'forms.md', 'scripts/new.sh']);
    assert.equal(t.skills.get('pdf')?.info.description, 'PDF forms and tables.');
    assert.throws(() => t.links.applyUpdate({ previewId: check.id }), /expired/, 'an applied update is used up');
    const again = await t.links.checkUpdate({ path: t.dir });
    assert.deepEqual(again.changes, [], 'up to date');
  } finally { t.done(); }
});

test('the person\'s edits are marked, the files they added are kept, and a folder changed since the check is not overwritten', async () => {
  const t = setup();
  try {
    await installV1(t);
    writeFileSync(path.join(t.dir, 'forms.md'), 'my own steps\n');
    writeFileSync(path.join(t.dir, 'my-notes.md'), 'mine');
    t.table[ARCHIVE] = githubZip('r-main', V2, C2);
    const check = await t.links.checkUpdate({ path: t.dir });
    assert.equal(check.changes.find((change) => change.path === 'forms.md')?.local, true, 'the update replaces this edit – the preview says so');
    assert.equal(check.changes.some((change) => change.path === 'my-notes.md'), false, 'a file the source never had is not the update\'s');
    writeFileSync(path.join(t.dir, 'forms.md'), 'edited again after the check\n');
    assert.throws(() => t.links.applyUpdate({ previewId: check.id }), (error: Error & { code?: string }) => error.code === 'conflict' && /changed since the check/.test(error.message));
    assert.equal(readFileSync(path.join(t.dir, 'forms.md'), 'utf8'), 'edited again after the check\n');
    const fresh = await t.links.checkUpdate({ path: t.dir });
    t.links.applyUpdate({ previewId: fresh.id });
    assert.equal(readFileSync(path.join(t.dir, 'my-notes.md'), 'utf8'), 'mine', 'kept');
    assert.equal(readFileSync(path.join(t.dir, 'forms.md'), 'utf8'), 'one\n2\nthree\nfour\n');
  } finally { t.done(); }
});

test('a renamed skill, a skill gone from its source and a folder that is no installed skill are refused', async () => {
  const t = setup();
  try {
    await installV1(t);
    t.table[ARCHIVE] = githubZip('r-main', { 'skills/pdf/SKILL.md': skillMd('pdf-tools', 'Renamed') }, C2);
    await assert.rejects(t.links.checkUpdate({ path: t.dir }), (error: Error & { code?: string }) => error.code === 'conflict' && /pdf-tools/.test(error.message));
    t.table[ARCHIVE] = githubZip('r-main', { 'README.md': 'moved away' }, C2);
    await assert.rejects(t.links.checkUpdate({ path: t.dir }), /no such folder/);
    await assert.rejects(t.links.checkUpdate({ path: path.join(t.workspace, 'skills') }), /No skill installed from a link/);
    await assert.rejects(t.links.checkUpdate({ path: t.root }), /No skill installed from a link/);
  } finally { t.done(); }
});

test('an uploaded skill is updated from its new ZIP; a linked one only from its link', async () => {
  const t = setup();
  try {
    const first = await t.links.preview({ fileId: t.upload('notes.zip', zip([{ name: 'notes/SKILL.md', data: skillMd('notes', 'Notes v1') }])) });
    await t.links.install({ previewId: first.id, routes: ['notes'], target: { kind: 'shared' } });
    const dir = path.join(t.workspace, 'skills', 'notes');
    await assert.rejects(t.links.checkUpdate({ path: dir }), /Choose its new ZIP/);
    const check = await t.links.checkUpdate({ path: dir, fileId: t.upload('notes-2.zip', zip([{ name: 'notes/SKILL.md', data: skillMd('notes', 'Notes v2') }])) });
    assert.deepEqual(check.changes.map((change) => change.path), ['SKILL.md']);
    t.links.applyUpdate({ previewId: check.id });
    assert.equal(readRecord(dir)!.source.url, 'notes-2.zip');
    await installV1(t);
    await assert.rejects(t.links.checkUpdate({ path: t.dir, fileId: t.upload('x.zip', zip([{ name: 'SKILL.md', data: skillMd('pdf', 'x') }])) }), /updated from there/);
  } finally { t.done(); }
});

test('lines that come and go', () => {
  assert.deepEqual(lineChanges('a\nb\nc', 'a\nc\nd\ne'), { added: 2, removed: 1 });
  assert.deepEqual(lineChanges('a\r\nb', 'b\na'), { added: 0, removed: 0 });
});
