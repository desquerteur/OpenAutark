// B-047 D11 deterministic evidence checks before the verifier's predicate (subconscious/verify-evidence.ts,
// verify.ts): a named file exists and is not empty, a named link answers (404/410 = no, except on hosts that hide
// private pages so; network/5xx = could not tell; 401/403 = exists); a missing file is a confident no only when its
// folder is here (line references and Git Bash paths understood); a check that confidently fails rejects the result whatever the predicate would say;
// the checks that ran are facts in the predicate's context; without a done-condition the result stays unverified.
// Owns: these assertions only. Never: the real network or file system (scripted fetch and stat).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakeDecisions, fixture } from '../context/fixture.ts';
import { createEvidenceChecker, targetsOf, type CheckFetch, type CheckStat } from '../../../src/runtime/subconscious/verify-evidence.ts';
import type { Evidence, Task, TaskResult } from '../../../src/shared/model/tasks.ts';

const ROOT = path.resolve('/ws');
const FILES = new Map<string, number>([[path.join(ROOT, 'out', 'intro.mp4'), 2_400_000], [path.join(ROOT, 'empty.txt'), 0], [path.resolve('/abs/report.pdf'), 12_000]]);
const DIRS = new Set([ROOT, path.join(ROOT, 'out'), path.resolve('/abs')]);
const stat: CheckStat = async (file) => (FILES.has(file) ? { size: FILES.get(file)!, isDirectory: () => false } : DIRS.has(file) ? { size: 0, isDirectory: () => true } : undefined);
const STATUS: Record<string, number | 'error'> = { 'https://live.example/': 200, 'https://gone.example/x': 404, 'https://login.example/': 403, 'https://down.example/': 503, 'https://nohead.example/': 405, 'https://offline.example/': 'error' };

function scriptedFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch: CheckFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    const status = STATUS[url];
    if (status === 'error' || status === undefined) throw new Error('getaddrinfo ENOTFOUND');
    if (status === 405 && init.method === 'GET') return new Response('ok', { status: 200 });
    return new Response(null, { status });
  };
  return { fetch, calls };
}

function doneTask(extra: Partial<Task> = {}): Task {
  return { id: 'task_1', conversationId: 'ch_1', title: 'Render the intro', notes: '', status: 'done', assigneeKind: 'agent', createdBy: 'human', priority: 0, ledger: {}, attempts: 1, sort: 0, rev: 1, createdAt: 0, updatedAt: 0, ...extra };
}

const result = (evidence: Evidence[]): TaskResult => ({ summary: 'Rendered and uploaded', evidence, verification: 'claimed_by_agent' });

test('targets: file paths of file/screenshot evidence and URLs of any evidence, each once, notes skipped', () => {
  assert.deepEqual(targetsOf([
    { kind: 'file', label: 'Intro', ref: 'out/intro.mp4' },
    { kind: 'screenshot', label: 'C:\\shots\\a.png' },
    { kind: 'link', label: 'Live', ref: 'https://live.example/' },
    { kind: 'note', label: 'Checked by hand' },
    { kind: 'check', label: 'see https://live.example/' },
    { kind: 'file', label: 'intro.mp4' },
  ]), [
    { kind: 'file', target: 'out/intro.mp4' },
    { kind: 'file', target: 'C:\\shots\\a.png' },
    { kind: 'link', target: 'https://live.example/' },
  ]);
});

test('checks: files exist and are not empty, links answer; unknowns stay unknown', async () => {
  const { fetch, calls } = scriptedFetch();
  const checker = createEvidenceChecker({ fetch, stat });
  const checks = await checker.check([
    { kind: 'file', label: 'Intro', ref: 'out/intro.mp4' },
    { kind: 'file', label: 'Empty', ref: 'empty.txt/' },
    { kind: 'file', label: 'Report', ref: path.resolve('/abs/report.pdf') },
    { kind: 'file', label: 'Missing', ref: path.resolve('/abs/missing.pdf') },
    { kind: 'file', label: 'Elsewhere', ref: 'worktree/out.mp4' },
    { kind: 'link', label: 'Gone', ref: 'https://gone.example/x' },
    { kind: 'link', label: 'Login', ref: 'https://login.example/' },
    { kind: 'link', label: 'Down', ref: 'https://down.example/' },
  ], { workspace: ROOT });
  const by = (target: string) => checks.find((check) => check.target.includes(target))!;
  assert.equal(by('intro.mp4').ok, true);
  assert.match(by('intro.mp4').line, /^file exists \(2\.3 MB\): out\/intro\.mp4$/);
  assert.equal(by('report.pdf').ok, true);
  assert.equal(by('missing.pdf').ok, false);
  assert.match(by('missing.pdf').line, /^file missing: /);
  assert.equal(by('worktree').ok, undefined, 'a relative path not in the workspace may live in a worktree');
  assert.equal(by('gone.example').ok, false);
  assert.equal(by('login.example').ok, true, 'behind a login the page exists');
  assert.equal(by('down.example').ok, undefined, 'a server error is no proof either way');
  assert.ok(calls.every((call) => call.method === 'HEAD'));
  const more = await checker.check([{ kind: 'link', label: 'No HEAD', ref: 'https://nohead.example/' }, { kind: 'link', label: 'Offline', ref: 'https://offline.example/' }]);
  assert.deepEqual(more.map((check) => check.ok), [true, undefined]);
  const methods = (url: string) => calls.filter((call) => call.url === url).map((call) => call.method);
  assert.deepEqual(methods('https://nohead.example/'), ['HEAD', 'GET'], 'GET only when HEAD is not allowed');
  assert.deepEqual(methods('https://offline.example/'), ['HEAD'], 'no retry');
});

test('no false "missing": private repo 404s, line references, Git Bash paths and another PC\'s folders are no proof of absence', async () => {
  const calls: string[] = [];
  const fetch: CheckFetch = async (url) => { calls.push(url); return new Response(null, { status: 404 }); };
  const checker = createEvidenceChecker({ fetch, stat, platform: 'win32' });
  const checks = await checker.check([
    { kind: 'link', label: 'PR', ref: 'https://github.com/acme/private-repo/pull/12' },
    { kind: 'link', label: 'MR', ref: 'https://gitlab.com/acme/app/-/merge_requests/3' },
    { kind: 'link', label: 'Public', ref: 'https://gone.example/y' },
    { kind: 'file', label: 'Line', ref: `${path.resolve('/abs/report.pdf')}:12` },
    { kind: 'file', label: 'Other PC', ref: path.resolve('/elsewhere/out.mp4') },
    { kind: 'file', label: 'Missing here', ref: path.resolve('/abs/nothing.pdf') },
  ], { workspace: ROOT });
  const by = (target: string) => checks.find((check) => check.target.includes(target))!;
  assert.equal(by('github.com').ok, undefined, 'GitHub answers 404 for a private PR without a login');
  assert.match(by('github.com').line, /private pages/);
  assert.equal(by('gitlab.com').ok, undefined);
  assert.equal(by('gone.example').ok, false, 'any other host: 404 is a confident no');
  assert.equal(by(':12').ok, true, 'a line reference names a line of an existing file');
  assert.equal(by('elsewhere').ok, undefined, 'its folder is not on this PC either – maybe a linked PC\'s file');
  assert.equal(by('nothing.pdf').ok, false, 'its folder is here, the file is not');
  if (process.platform === 'win32') {
    const drive = path.resolve('/').slice(0, 1).toLowerCase();
    const [bash] = await checker.check([{ kind: 'file', label: 'Report', ref: `/${drive}/abs/report.pdf` }]);
    assert.equal(bash.ok, true, 'a Git Bash path is read as the Windows path');
  }
});

test('verify: failing evidence rejects before any predicate; held evidence is a fact in the predicate context', async () => {
  const { fetch } = scriptedFetch();
  const yes = fakeDecisions(() => ({ value: true, confidence: 0.9 }));
  const f = fixture({ decisions: yes.service });
  Object.assign(f.services, { evidence: createEvidenceChecker({ fetch, stat }), paths: { ...f.services.paths, workspace: ROOT } });
  const task = doneTask({ doneWhen: 'The intro is rendered and online' });

  const rejected = await f.subconscious.verify(task, result([{ kind: 'file', label: 'Intro', ref: path.resolve('/abs/missing.pdf') }, { kind: 'link', label: 'Video', ref: 'https://gone.example/x' }]));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.checked, true);
  assert.match(rejected.reason, /^The evidence does not hold: file missing: .*; link does not exist \(HTTP 404\): https:\/\/gone\.example\/x\./);
  assert.equal(yes.calls.length, 0, 'no predicate after a failed deterministic check');

  const passed = await f.subconscious.verify(task, result([{ kind: 'file', label: 'Intro', ref: 'out/intro.mp4' }, { kind: 'link', label: 'Video', ref: 'https://live.example/' }]));
  assert.deepEqual([passed.ok, passed.checked], [true, true]);
  assert.match(yes.calls[0].context!, /Checked by the runtime \(facts\):\n- file exists \(2\.3 MB\): out\/intro\.mp4\n- link answers \(HTTP 200\): https:\/\/live\.example\//);
});

test('verify: without a done-condition the result stays unverified even when its evidence held; without a checker nothing changes', async () => {
  const { fetch } = scriptedFetch();
  const f = fixture({ decisions: fakeDecisions(() => ({ value: true, confidence: 0.9 })).service });
  Object.assign(f.services, { evidence: createEvidenceChecker({ fetch, stat }), paths: { ...f.services.paths, workspace: ROOT } });
  assert.deepEqual(await f.subconscious.verify(doneTask(), result([{ kind: 'file', label: 'Intro', ref: 'out/intro.mp4' }])), { ok: true, reason: 'no done-condition', checked: false });
  const empty = await f.subconscious.verify(doneTask(), result([{ kind: 'file', label: 'Notes', ref: path.join(ROOT, 'empty.txt') }]));
  assert.deepEqual([empty.ok, empty.checked], [false, true], 'an empty file is no result, done-condition or not');
  const plain = fixture();
  assert.deepEqual(await plain.subconscious.verify(doneTask(), result([{ kind: 'link', label: 'Gone', ref: 'https://gone.example/x' }])), { ok: true, reason: 'no done-condition', checked: false });
});
