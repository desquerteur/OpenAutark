// AF-007: what a pasted skill link is – GitHub repositories, folders (/tree/<ref>/<path>, every ref split a try),
// a SKILL.md in a repository, GitHub archives, any https SKILL.md or ZIP – and what is refused (http, credentials, '..',
// other schemes, links that are none of these).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrl, githubUrl, parseSkillLink, refTries } from '../../../src/runtime/skills/links/url.ts';

const refused = (value: string, pattern?: RegExp) => assert.throws(() => parseSkillLink(value), (error: Error & { code?: string }) => error.code === 'bad_request' && (!pattern || pattern.test(error.message)), value);

test('a GitHub repository in every common spelling is the whole repository on its default branch', () => {
  for (const value of ['https://github.com/anthropics/skills', 'https://github.com/anthropics/skills/', 'https://github.com/anthropics/skills.git',
    'github.com/anthropics/skills', 'www.github.com/anthropics/skills', 'anthropics/skills', ' <https://github.com/anthropics/skills> ', 'https://github.com/anthropics/skills#readme']) {
    const link = parseSkillLink(value);
    assert.equal(link.kind, 'github', value);
    if (link.kind !== 'github') continue;
    assert.equal(link.owner, 'anthropics');
    assert.equal(link.repo, 'skills');
    assert.deepEqual(link.tries, [{ folder: '' }], value);
  }
});

test('a /tree/ link tries every split of branch and folder, shortest branch first', () => {
  const link = parseSkillLink('https://github.com/anthropics/skills/tree/main/skills/pdf');
  assert.equal(link.kind, 'github');
  if (link.kind !== 'github') return;
  assert.deepEqual(link.tries, [
    { ref: 'main', folder: 'skills/pdf' },
    { ref: 'main/skills', folder: 'pdf' },
    { ref: 'main/skills/pdf', folder: '' },
  ]);
  assert.equal(link.url, 'https://github.com/anthropics/skills/tree/main/skills/pdf');
  assert.deepEqual(refTries(['feature', 'x']), [{ ref: 'feature', folder: 'x' }, { ref: 'feature/x', folder: '' }]);
  const branchOnly = parseSkillLink('https://github.com/o/r/tree/dev');
  assert.ok(branchOnly.kind === 'github' && branchOnly.tries[0]!.ref === 'dev' && branchOnly.tries[0]!.folder === '');
  const encoded = parseSkillLink('https://github.com/o/r/tree/main/my%20skills/a');
  assert.ok(encoded.kind === 'github' && encoded.tries[0]!.folder === 'my skills/a');
});

test('a SKILL.md inside a repository installs its folder; a ZIP in a repository is read raw', () => {
  const blob = parseSkillLink('https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md');
  assert.ok(blob.kind === 'github');
  if (blob.kind === 'github') assert.deepEqual(blob.tries[0], { ref: 'main', folder: 'skills/pdf' });
  const zipped = parseSkillLink('https://github.com/o/r/blob/main/dist/my-skill.zip');
  assert.deepEqual(zipped, { kind: 'zip', url: 'https://github.com/o/r/raw/main/dist/my-skill.zip', folder: 'my-skill' });
  refused('https://github.com/o/r/blob/main/README.md', /one file/);
});

test('GitHub archives and codeload are ZIPs with one top folder', () => {
  assert.deepEqual(parseSkillLink('https://github.com/o/r/archive/refs/heads/main.zip'), { kind: 'zip', url: 'https://github.com/o/r/archive/refs/heads/main.zip', folder: 'r', top: true });
  const codeload = parseSkillLink('https://codeload.github.com/o/r/zip/refs/heads/main');
  assert.equal(codeload.kind, 'zip');
  assert.ok(codeload.kind === 'zip' && codeload.top === true);
  const release = parseSkillLink('https://github.com/o/r/releases/download/v1/skill.zip');
  assert.ok(release.kind === 'zip' && !release.top);
});

test('any https SKILL.md is that one file; any https ZIP is a ZIP', () => {
  assert.deepEqual(parseSkillLink('https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md'), { kind: 'file', url: 'https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md', folder: 'pdf' });
  assert.deepEqual(parseSkillLink('https://example.com/a/b/skill.md'), { kind: 'file', url: 'https://example.com/a/b/skill.md', folder: 'b' });
  assert.deepEqual(parseSkillLink('https://example.com/downloads/report-writer.zip?sig=1'), { kind: 'zip', url: 'https://example.com/downloads/report-writer.zip?sig=1', folder: 'report-writer' });
});

test('http, credentials, other schemes, folder escapes and links that are none of these are refused with a reason', () => {
  refused('http://github.com/o/r', /https/);
  refused('http://example.com/SKILL.md', /https/);
  refused('https://user:secret@example.com/SKILL.md', /password/);
  refused('file:///C:/skills/SKILL.md');
  refused('javascript:alert(1)');
  refused('https://example.com/page');
  refused('https://github.com/o/r/issues/1');
  refused('https://github.com/o/r/tree/main/../../etc'); // the address itself resolves the dots: /o/etc is no repository link
  refused('https://github.com/o/r/tree/main/a%2F..%2F..%2Fb', /not allowed/);
  refused('https://github.com/-bad/r');
  refused('');
  refused('two words');
  refused(`https://example.com/${'a'.repeat(2100)}.zip`);
});

test('the archive and folder addresses of a try', () => {
  assert.equal(archiveUrl('o', 'r', undefined), 'https://github.com/o/r/archive/HEAD.zip');
  assert.equal(archiveUrl('o', 'r', 'feature/x y'), 'https://github.com/o/r/archive/feature/x%20y.zip');
  assert.throws(() => archiveUrl('o', 'r', '../x'));
  assert.equal(githubUrl('o', 'r', undefined, ''), 'https://github.com/o/r');
  assert.equal(githubUrl('o', 'r', undefined, 'skills/pdf'), 'https://github.com/o/r/tree/HEAD/skills/pdf');
  assert.equal(githubUrl('o', 'r', 'main', 'skills/pdf'), 'https://github.com/o/r/tree/main/skills/pdf');
});
