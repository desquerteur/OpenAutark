// AF-007: the ZIP check of skill sources – entry names that would leave the folder (.., absolute, drive letters,
// backslashes, Windows device names), links, encrypted and duplicate entries, a "zip bomb" (a small claimed size that
// inflates far, a suspicious ratio), the size and file-count limits – and the skills a source lists (several, nested,
// hidden folders, names from folders, scripts, invisible characters).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryPath, fileView, LINK_LIMITS, skillBudget, zipView } from '../../../src/runtime/skills/links/archive.ts';
import { findSkills, installBytes, isScript, skillFolders } from '../../../src/runtime/skills/links/candidates.ts';
import { COMMIT, githubZip, skillMd, zip } from './links-fixture.ts';

test('entry names that would leave the skill folder or that Windows cannot hold are refused', () => {
  for (const [name, problem] of [
    ['../evil.sh', 'path outside the folder'], ['skill/../../evil.sh', 'path outside the folder'], ['skill\\..\\..\\evil.sh', 'path outside the folder'],
    ['/etc/passwd', 'absolute path'], ['\\Windows\\x.dll', 'absolute path'], ['C:/Windows/x.dll', 'absolute path'], ['c:evil', 'absolute path'],
    ['skill/CON', 'unsafe name'], ['skill/nul.txt', 'unsafe name'], ['skill/a:b', 'unsafe name'], ['skill/trailing.', 'unsafe name'], ['skill/x\u0000y', 'unsafe name'],
    ['skill/./x', 'path outside the folder'],
  ] as const) {
    assert.deepEqual(entryPath(name), { problem }, name);
  }
  assert.deepEqual(entryPath('skill\\scripts\\run.py'), { path: 'skill/scripts/run.py' });
  assert.deepEqual(entryPath('skill//SKILL.md'), { path: 'skill/SKILL.md' });
});

test('a ZIP view leaves out unsafe entries, links, devices, encrypted and same-name entries and keeps the rest', () => {
  const view = zipView(zip([
    { name: 'pdf/SKILL.md', data: skillMd('pdf', 'PDF forms') },
    { name: 'pdf/../../../outside.txt', data: 'x' },
    { name: '/abs.txt', data: 'x' },
    { name: 'pdf/link', data: '/etc/passwd', mode: 0o120777 },
    { name: 'pdf/fifo', data: '', mode: 0o010644 },
    { name: 'pdf/secret.bin', data: 'x', flags: 0x1 },
    { name: 'pdf/Readme.md', data: 'one' },
    { name: 'pdf/README.md', data: 'two' },
    { name: 'pdf/sub/', data: '', mode: 0o040755 },
  ]));
  assert.deepEqual([...view.files.keys()], ['pdf/SKILL.md', 'pdf/Readme.md']);
  assert.deepEqual(view.skipped.map((entry) => entry.reason).sort(), ['absolute path', 'encrypted', 'link', 'not a file', 'path outside the folder', 'same name as another file']);
});

test('a GitHub archive drops its top folder, keeps the linked folder only and carries the commit', () => {
  const buf = githubZip('skills-main', { 'README.md': '# all', 'skills/pdf/SKILL.md': skillMd('pdf', 'PDF'), 'skills/pdf/forms.md': 'f', 'skills/docx/SKILL.md': skillMd('docx', 'Word') });
  const whole = zipView(buf, { stripTop: true });
  assert.deepEqual([...whole.files.keys()].sort(), ['README.md', 'skills/docx/SKILL.md', 'skills/pdf/SKILL.md', 'skills/pdf/forms.md']);
  assert.equal(whole.commit, COMMIT);
  const folder = zipView(buf, { stripTop: true, prefix: 'skills/pdf' });
  assert.deepEqual([...folder.files.keys()].sort(), ['SKILL.md', 'forms.md']);
  assert.equal(zipView(buf, { stripTop: true, prefix: 'skills/none' }).files.size, 0);
  const mixed = zipView(zip([{ name: 'a/SKILL.md', data: 'x' }, { name: 'b/SKILL.md', data: 'x' }]), { stripTop: true });
  assert.deepEqual(mixed.skipped.map((entry) => entry.reason), ['outside the archive folder']);
});

test('a zip bomb stops at the budget, not at the size it claims, and a suspicious ratio is left out', async () => {
  const big = Buffer.alloc(LINK_LIMITS.skillBytes + 1024 * 1024, 0x41);
  const lying = zipView(zip([{ name: 's/SKILL.md', data: skillMd('s', 'S') }, { name: 's/data.txt', data: big, claimSize: 10 }]));
  const file = lying.files.get('s/data.txt')!;
  await assert.rejects(file.read(skillBudget()), /could not be read|larger/);
  const ratio = zipView(zip([{ name: 's/zeros.bin', data: Buffer.alloc(5 * 1024 * 1024) }]));
  assert.deepEqual(ratio.skipped.map((entry) => entry.reason), ['inflates suspiciously far']);
  assert.throws(() => zipView(Buffer.from('not a zip at all, just text')), /no ZIP/);
  assert.throws(() => zipView(Buffer.alloc(LINK_LIMITS.archiveBytes + 1)), /larger than 64 MB/);
  assert.throws(() => fileView(Buffer.alloc(LINK_LIMITS.skillFileBytes + 1)), /256 KB/);
});

test('a source lists every skill folder; nested, hidden and dependency folders are not searched, .claude is', async () => {
  const view = zipView(githubZip('repo-main', {
    'skills/pdf/SKILL.md': skillMd('pdf', 'Fill PDF forms'),
    'skills/pdf/nested/SKILL.md': skillMd('nested', 'Inside pdf'),
    'skills/docx/SKILL.md': skillMd('docx', 'Word files'),
    '.git/hooks/SKILL.md': skillMd('hook', 'Hidden'),
    'node_modules/x/SKILL.md': skillMd('dep', 'Dependency'),
    '.claude/skills/review/SKILL.md': skillMd('review', 'Review code'),
  }), { stripTop: true });
  assert.deepEqual(skillFolders(view), ['skills/docx', 'skills/pdf', '.claude/skills/review']);
  const found = await findSkills(view, 'repo');
  assert.deepEqual(found.skills.map((skill) => skill.info.name), ['docx', 'pdf', 'review']);
  const pdf = found.skills.find((skill) => skill.info.name === 'pdf')!;
  assert.deepEqual(pdf.info.files.map((file) => file.path), ['SKILL.md', 'nested/SKILL.md'], 'a nested folder is part of its skill');
});

test('names come from the front matter, else from the folder; two skills of one name: the nearer one', async () => {
  const view = zipView(zip([
    { name: 'SKILL.md', data: '---\ndescription: The root skill\n---\nBody' },
    { name: 'deep/x/Bad Name/SKILL.md', data: skillMd('Bad Name', 'Spaces') },
  ]));
  const found = await findSkills(view, 'my-upload');
  assert.deepEqual(found.skills.map((skill) => skill.info.name), ['my-upload'], 'the root skill holds every file, so deep/ is part of it');
  assert.match(found.skills[0]!.info.notes.join(' '), /after its folder/);
  const two = zipView(zip([{ name: 'a/SKILL.md', data: skillMd('same', 'One') }, { name: 'b/c/SKILL.md', data: skillMd('same', 'Two') }, { name: 'd/SKILL.md', data: skillMd('Bad Name', 'Spaces') }]));
  const result = await findSkills(two, 'x');
  assert.deepEqual(result.skills.map((skill) => [skill.info.route, skill.info.name]), [['a', 'same'], ['d', 'bad-name']]);
  assert.deepEqual(result.problems, [{ route: 'b/c', problem: 'another skill of this source is named same' }]);
});

test('scripts are named in the preview: script extensions, scripts/ and bin/, an executable bit', async () => {
  assert.ok(isScript('run.sh') && isScript('scripts/tool') && isScript('helper', 0o100755) && isScript('x.PS1') && isScript('lib/app.exe'));
  assert.ok(!isScript('README.md') && !isScript('scripts/README.md') && !isScript('reference/forms.md') && !isScript('data.json', 0o100644));
  const found = await findSkills(zipView(zip([
    { name: 'pdf/SKILL.md', data: skillMd('pdf', 'PDF') },
    { name: 'pdf/scripts/fill.py', data: 'print(1)' },
    { name: 'pdf/check', data: '#!/bin/sh', mode: 0o100755 },
    { name: 'pdf/forms.md', data: 'text' },
  ])), 'x');
  assert.deepEqual(found.skills[0]!.info.scripts, ['check', 'scripts/fill.py']);
});

test('over a limit a skill is a problem, never cut silently', async () => {
  const many = [{ name: 'big/SKILL.md', data: skillMd('big', 'Big') }, ...Array.from({ length: LINK_LIMITS.skillFiles + 1 }, (_, index) => ({ name: `big/f${index}.txt`, data: 'x' }))];
  const found = await findSkills(zipView(zip(many)), 'x');
  assert.deepEqual(found.skills, []);
  assert.deepEqual(found.problems, [{ route: 'big', problem: `holds more than ${LINK_LIMITS.skillFiles} files` }]);
  const huge = await findSkills(zipView(zip([{ name: 'h/SKILL.md', data: skillMd('h', 'H') }, { name: 'h/a.bin', data: Buffer.alloc(LINK_LIMITS.fileBytes + 1, 1), store: true }])), 'x');
  assert.match(huge.problems[0]!.problem, /larger than 10 MB/);
  const noText = await findSkills(zipView(zip([{ name: 'n/SKILL.md', data: Buffer.from([0x2d, 0x00, 0x01]) }])), 'x');
  assert.deepEqual(noText.problems, [{ route: 'n', problem: 'SKILL.md is not text' }]);
});

test('invisible characters leave SKILL.md and other Markdown; other files stay byte for byte', async () => {
  const hidden = `---\nname: pdf\ndescription: PDF\u200b forms\n---\nDo\u202e this\u2066.\n`;
  const found = await findSkills(zipView(zip([{ name: 'pdf/SKILL.md', data: hidden }])), 'x');
  assert.equal(found.skills[0]!.info.description, 'PDF forms');
  assert.match(found.skills[0]!.info.notes.join(' '), /3 invisible characters removed/);
  assert.equal(installBytes('SKILL.md', Buffer.from(hidden)).bytes.toString('utf8'), '---\nname: pdf\ndescription: PDF forms\n---\nDo this.\n');
  const script = Buffer.from('echo "\u200b"');
  assert.equal(installBytes('run.sh', script).bytes, script);
});
