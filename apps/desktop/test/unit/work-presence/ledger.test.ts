// B-055 G (WORK-PRESENCE): the work ledger and its path rules (work-presence/ledger.ts, paths.ts):
//  - one key per file: absolute, resolved against the call's folder, case-folded with backslashes on Windows;
//  - a folder's files – never through another task's `.worktrees` copy; the short display form;
//  - the newest entry per file, agent and kind; the 2 h TTL (a running turn keeps its entries); the file bound;
//  - running turns from turnStarted/turnEnded; overlap notes for exactly the side whose turn the other's change fell in.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderKey, isUnder, resolveFile, shownPath, SHOWN_MAX } from '../../../src/runtime/work-presence/paths.ts';
import { MAX_FILES, RECENT_MS, TTL_MS, WorkLedger, type WorkEntry } from '../../../src/runtime/work-presence/ledger.ts';

test('resolveFile: one key per file on Windows (case, slashes, relative to the folder, trailing separator); POSIX keeps case', () => {
  const a = resolveFile('C:/Work/Src/App.ts', 'C:\\Elsewhere', 'win32')!;
  const b = resolveFile('c:\\work\\src\\app.ts', 'C:\\Elsewhere', 'win32')!;
  const c = resolveFile('src\\App.ts', 'C:\\Work', 'win32')!;
  const d = resolveFile('./src/./x/../App.ts', 'c:\\WORK\\', 'win32')!;
  assert.equal(a.key, 'c:\\work\\src\\app.ts');
  assert.deepEqual([b.key, c.key, d.key], [a.key, a.key, a.key]);
  assert.equal(a.file, 'C:\\Work\\Src\\App.ts', 'the file keeps its spelling for display');
  assert.equal(resolveFile('C:\\Work\\src\\', 'C:\\', 'win32')!.key, 'c:\\work\\src');
  assert.equal(resolveFile('  ', 'C:\\Work', 'win32'), undefined);
  const posix = resolveFile('src/App.ts', '/work', 'linux')!;
  assert.equal(posix.key, '/work/src/App.ts');
  assert.notEqual(resolveFile('src/app.ts', '/work', 'linux')!.key, posix.key, 'POSIX paths are case-sensitive');
});

test('isUnder: a folder\'s files, not the folder itself, not a sibling with the same prefix, never through .worktrees', () => {
  const dir = folderKey('C:\\Work\\Site', 'win32')!;
  const key = (p: string) => resolveFile(p, 'C:\\', 'win32')!.key;
  assert.equal(isUnder(key('C:\\Work\\Site\\src\\app.ts'), dir, 'win32'), true);
  assert.equal(isUnder(key('c:/work/site/README.md'), dir, 'win32'), true);
  assert.equal(isUnder(key('C:\\Work\\Site'), dir, 'win32'), false);
  assert.equal(isUnder(key('C:\\Work\\Site2\\a.ts'), dir, 'win32'), false);
  assert.equal(isUnder(key('C:\\Work\\Site\\.worktrees\\repo-abc\\t1\\app.ts'), dir, 'win32'), false, "another task's worktree is a separate copy");
  assert.equal(isUnder(key('C:\\Work\\Site\\.worktrees\\repo-abc\\t1\\app.ts'), folderKey('C:\\Work\\Site\\.worktrees\\repo-abc\\t1', 'win32')!, 'win32'), true, 'inside the own worktree');
  assert.equal(isUnder(key('C:\\a.ts'), folderKey('C:\\', 'win32')!, 'win32'), true, 'a drive root');
  assert.equal(isUnder('/work/site/a.ts', '/work/site', 'linux'), true);
});

test('shownPath: relative to the first base that holds it, else the last three parts; long paths keep their tail', () => {
  assert.equal(shownPath('C:\\Work\\Site\\src\\app.ts', ['C:\\Work\\Site', 'C:\\Work'], 'win32'), 'src/app.ts');
  assert.equal(shownPath('C:\\Work\\Other\\b.ts', ['C:\\Work\\Site', 'C:\\Work'], 'win32'), 'Other/b.ts');
  assert.equal(shownPath('D:\\x\\y\\z\\q.ts', ['C:\\Work'], 'win32'), '…/y/z/q.ts');
  const long = shownPath(`/work/${'deep/'.repeat(20)}file.ts`, ['/work'], 'linux');
  assert.equal(long.length, SHOWN_MAX);
  assert.ok(long.startsWith('…') && long.endsWith('/file.ts'), long);
});

function setup() {
  let now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const ledger = new WorkLedger(() => now);
  const entry = (agentId: string, file: string, kind: WorkEntry['kind'], runId: string, at = now): WorkEntry =>
    ({ ...resolveFile(file, '/work', 'linux')!, agentId, agentName: agentId === 'a' ? 'Ada' : 'Bob', runId, kind, at });
  return { ledger, entry, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('ledger: the newest entry per file, agent and kind; an older one is ignored; changes vs reads', () => {
  const { ledger, entry, advance, now } = setup();
  ledger.record(entry('a', 'src/app.ts', 'edit', 'r1'));
  advance(1000);
  ledger.record(entry('a', 'src/app.ts', 'edit', 'r1'));
  ledger.record(entry('a', 'src/app.ts', 'edit', 'r0', now() - 5000)); // older: ignored
  ledger.record(entry('b', 'src/app.ts', 'read', 'r2'));
  assert.equal(ledger.size, 1);
  const changes = ledger.recentChanges();
  assert.equal(changes.length, 1, 'a read is no change');
  assert.equal(changes[0].at, now());
  assert.equal(changes[0].runId, 'r1');
  assert.deepEqual(ledger.recentChanges('a'), [], 'without the asking agent');
  assert.equal(ledger.changedBy(changes[0].key, 'b', 0)?.agentName, 'Ada');
  assert.equal(ledger.changedBy(changes[0].key, 'b', now()), undefined, 'only after the given time');
  assert.deepEqual(ledger.touchedBy('b').map((item) => item.kind), ['read']);
});

test('ledger: running turns; recent = 10 min or still running; TTL 2 h unless the turn still runs', () => {
  const { ledger, entry, advance } = setup();
  ledger.turnStarted({ runId: 'r1', agentId: 'a', startedAt: 0 });
  ledger.record(entry('a', 'src/app.ts', 'edit', 'r1'));
  ledger.record(entry('b', 'src/b.ts', 'edit', 'r2'));
  assert.equal(ledger.isRunning('r1'), true);
  assert.deepEqual(ledger.runningOf('a').map((turn) => turn.runId), ['r1']);
  advance(RECENT_MS + 1);
  assert.deepEqual(ledger.recentChanges().map((item) => item.agentName), ['Ada'], "Bob's change is older than 10 min and his turn ended; Ada's turn still runs");
  advance(TTL_MS);
  ledger.prune();
  assert.equal(ledger.size, 1, "Bob's entry expired; Ada's stays while her turn runs");
  ledger.turnEnded('r1');
  assert.equal(ledger.isRunning('r1'), false);
  ledger.prune();
  assert.equal(ledger.size, 0);
  assert.deepEqual(ledger.touchedBy('a'), []);
});

test('ledger: at most MAX_FILES files – the least recently touched go first', () => {
  const { ledger, entry } = setup();
  for (let i = 0; i <= MAX_FILES; i++) ledger.record(entry('a', `f${i}.ts`, 'edit', 'r1'));
  assert.equal(ledger.size, MAX_FILES);
  assert.equal(ledger.changedBy(resolveFile('f0.ts', '/work', 'linux')!.key, 'b', -1), undefined, 'the first file went');
  assert.ok(ledger.changedBy(resolveFile(`f${MAX_FILES}.ts`, '/work', 'linux')!.key, 'b', -1));
});

test('ledger: a finished turn leaves a note when another agent changed one of its files during it – once, for that side only', () => {
  const { ledger, entry, advance, now } = setup();
  ledger.turnStarted({ runId: 'ra', agentId: 'a', startedAt: now() });
  ledger.record(entry('a', 'src/app.ts', 'edit', 'ra'));
  advance(60_000);
  ledger.turnStarted({ runId: 'rb', agentId: 'b', startedAt: now() });
  ledger.record(entry('b', 'src/app.ts', 'write', 'rb'));
  ledger.record(entry('b', 'src/other.ts', 'edit', 'rb'));
  advance(60_000);
  const forBob = ledger.turnEnded('rb');
  assert.deepEqual(forBob, [], "Ada changed src/app.ts before Bob's turn started – Bob saw it");
  const forAda = ledger.turnEnded('ra');
  assert.deepEqual(forAda.map((note) => [note.byName, note.file]), [['Bob', '/work/src/app.ts']], 'only the shared file');
  assert.deepEqual(ledger.takeNotes('a').map((note) => note.byName), ['Bob']);
  assert.deepEqual(ledger.takeNotes('a'), [], 'said once');
  assert.deepEqual(ledger.turnEnded('unknown'), []);
});

test('ledger: reads make no overlap; a note older than the TTL is not said', () => {
  const { ledger, entry, advance, now } = setup();
  ledger.turnStarted({ runId: 'ra', agentId: 'a', startedAt: now() });
  ledger.record(entry('a', 'src/app.ts', 'read', 'ra'));
  ledger.record(entry('b', 'src/app.ts', 'edit', 'rb'));
  assert.deepEqual(ledger.turnEnded('ra'), [], 'Ada only read it');
  ledger.turnStarted({ runId: 'ra2', agentId: 'a', startedAt: now() });
  ledger.record(entry('a', 'src/app.ts', 'edit', 'ra2'));
  ledger.record(entry('b', 'src/app.ts', 'edit', 'rb', now() + 1));
  assert.equal(ledger.turnEnded('ra2').length, 1);
  advance(TTL_MS + 10);
  assert.deepEqual(ledger.takeNotes('a'), []);
});
