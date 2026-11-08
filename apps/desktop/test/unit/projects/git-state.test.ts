// AF-018: parsing of a project's git state (runtime/projects/git-state.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBranches, parseLastCommit, parseStatus } from '../../../src/runtime/projects/git-state.ts';

test('parseStatus reads branch, head, upstream, ahead/behind and counts changed paths', () => {
  const out = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
    'src/old.ts',
    '? notes.md',
    '',
  ].join('\0');
  assert.deepEqual(parseStatus(out), { branch: 'main', head: '0123456', dirty: 3, ahead: 2, behind: 3, upstream: 'origin/main' });
});

test('parseStatus handles a detached HEAD and a repository without commits', () => {
  assert.equal(parseStatus('# branch.oid abcdef1234\0# branch.head (detached)\0').branch, null);
  const empty = parseStatus('# branch.oid (initial)\0# branch.head main\0');
  assert.equal(empty.head, '');
  assert.equal(empty.dirty, 0);
  assert.equal(empty.upstream, undefined);
});

test('parseLastCommit reads sha, subject and time', () => {
  assert.deepEqual(parseLastCommit('abc1234\0Fix things\x001700000000\n'), { sha: 'abc1234', subject: 'Fix things', at: 1_700_000_000_000 });
  assert.equal(parseLastCommit(''), undefined);
});

test('parseBranches dedupes, caps at 50 and keeps the checked-out branch', () => {
  const names = Array.from({ length: 60 }, (_, i) => `b${i}`);
  const capped = parseBranches(names.join('\n'), 'b59');
  assert.equal(capped.length, 50);
  assert.ok(capped.includes('b59'));
  assert.deepEqual(parseBranches('main\nmain\ndev\n', 'main'), ['main', 'dev']);
});
