// B-057 track A: what create() refuses, before anything is written, with one clear sentence each – a split splitting
// again, the goal and the 1–12 parts, titles/briefs/returns within SPLIT_LIMITS, context, model (same | cheap | strong |
// a known, usable catalog model), effort, `after` naming only earlier parts, a worktree without a working folder, the
// active groups per agent; and what it stores (trimmed texts, 'same' as no model, catalog ids).
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_LIMITS, type SplitPartInput, type SplitTurn } from '../../../src/shared/model/splits.ts';
import { NESTED_TEXT } from '../../../src/runtime/splits/validate.ts';
import { PARENT, part, world } from './fixture.ts';

const refusal = (fn: () => unknown): { code?: string; message: string } => {
  try { fn(); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
  return { message: 'not refused' };
};

const SPLIT: SplitTurn = { splitId: 'spl_x', groupId: 'sgr_x', idx: 1, of: 2, title: 'X', parentRunId: PARENT, parentThread: 'ch', context: 'fork', firstTurn: true };

test('a split cannot split again', () => {
  const w = world();
  const found = refusal(() => w.splits.create(w.ctx({ split: SPLIT }), { goal: 'Deeper', parts: [part('A')] }));
  assert.deepEqual(found, { code: 'forbidden', message: NESTED_TEXT });
  assert.equal(NESTED_TEXT, 'A split cannot split again; I do my part and put the result in my final text.');
});

test('the input checks, each with a clear sentence, and nothing is stored', () => {
  const w = world();
  const create = (parts: unknown, goal: unknown = 'Goal') => refusal(() => w.splits.create(w.ctx(), { goal, parts } as never));
  const cases: Array<[unknown, RegExp, string?]> = [
    [[], /^Give 1–12 parts \(got 0\)\.$/],
    [Array.from({ length: 13 }, (_, index) => part(`P${index}`)), /^Give 1–12 parts \(got 13\)\.$/],
    [[{ brief: 'x' }], /^Part #1's title is missing\.$/],
    [[part('x'.repeat(SPLIT_LIMITS.titleChars + 1))], /^Part #1's title is 81 characters long; at most 80\.$/],
    [[{ title: 'A', brief: '   ' }], /^Part #1's brief is empty\.$/],
    [[part('A', { brief: 'b'.repeat(SPLIT_LIMITS.briefChars + 1) })], /brief is 4001 characters long; at most 4000/],
    [[part('A', { returns: 'r'.repeat(401) })], /returns is 401 characters long; at most 400/],
    [[part('A', { context: 'full' as never })], /^Part #1: context must be fork or brief\.$/],
    [[part('A', { effort: 'minimal' as never })], /^Part #1: effort must be one of none, low, medium, high, xhigh, max\.$/],
    [[part('A', { model: 'gpt-9-ultra' })], /^Part #1: unknown model "gpt-9-ultra" – use same, cheap, strong or a model id from models\.list\.$/, 'not_found'],
    [[part('A', { model: 'claude:claude-opus-5-5' })], /^Part #1: Claude Opus 5\.5 has no usable account right now/, 'conflict'],
    [[part('A', { after: [1] })], /^Part #1: the first part waits for no other – leave its after out\.$/],
    [[part('A'), part('B', { after: [3] })], /^Part #2: after names earlier parts only \(#1–#1\)\.$/],
    [[part('A'), part('B', { after: 1 as never })], /^Part #2: after must be a list of part numbers\.$/],
    [[part('A', { worktree: 'yes' as never })], /^Part #1: worktree must be true or false\.$/],
    ['not a list', /^Give 1–12 parts \(got none\)\.$/],
  ];
  for (const [parts, pattern, code] of cases) {
    const found = create(parts);
    assert.match(found.message, pattern, JSON.stringify(parts).slice(0, 80));
    assert.equal(found.code, code ?? 'bad_request');
  }
  assert.match(create([part('A')], '').message, /^The goal is empty\.$/);
  assert.match(create([part('A')], 'g'.repeat(401)).message, /^The goal is 401 characters long; at most 400\.$/);
  const noFolder = refusal(() => w.splits.create(w.ctx({ cwd: undefined }), { goal: 'Code', parts: [part('A', { worktree: true })] }));
  assert.match(noFolder.message, /^Part #1 asks for its own worktree, but this turn has no working folder/);
  assert.equal(w.splits.list({ agentId: 'ag_ava' }).length, 0, 'nothing stored');
  assert.equal(w.of('split.upserted').length, 0);
});

test('stored as given: trimmed texts, no model for same, catalog ids for a model name, after sorted', () => {
  const w = world();
  const parts: SplitPartInput[] = [
    { title: '  Tests  ', brief: ' Run them. ', returns: ' Failures ', model: 'same' },
    { title: 'Docs', brief: 'Check docs.', model: 'GPT-6.1 Sol', effort: 'high', after: [1, 1] },
    { title: 'Judge', brief: 'Try to refute #1.', model: 'STRONG', context: 'brief', after: [2, 1] },
  ];
  const view = w.splits.create(w.ctx(), { goal: '  Release check  ', parts });
  assert.equal(view.goal, 'Release check');
  const [one, two, three] = view.splits;
  assert.deepEqual([one.title, one.brief, one.returns, one.model], ['Tests', 'Run them.', 'Failures', undefined]);
  assert.deepEqual([two.model, two.effort, two.after], ['codex:gpt-6.1-sol', 'high', [1]]);
  assert.deepEqual([three.model, three.context, three.after], ['strong', 'brief', [1, 2]]);
  assert.equal(view.cwd, 'C:/work/repo');
  assert.equal(view.modeKey, 'general');
  assert.equal(view.ultra, false);
  assert.match(view.id, /^sgr_/);
  assert.match(one.id, /^spl_/);
});

test('at most activeGroupsPerAgent pending or running groups per agent', () => {
  const w = world();
  for (let n = 0; n < SPLIT_LIMITS.activeGroupsPerAgent; n++) w.splits.create(w.ctx(), { goal: `Goal ${n}`, parts: [part('A')] });
  const found = refusal(() => w.splits.create(w.ctx(), { goal: 'One more', parts: [part('A')] }));
  assert.equal(found.code, 'conflict');
  assert.equal(found.message, '3 split groups of mine are still running (at most 3). I wait for their results, or stop one with agents.split_stop.');
  assert.equal(w.splits.create(w.ctx({ agentId: 'ag_ben' }), { goal: 'Ben', parts: [part('A')] }).agentId, 'ag_ben', 'per agent');
});

test('an archived or unknown agent cannot split', () => {
  const w = world();
  w.org.require('ag_ben').archivedAt = 1;
  assert.deepEqual(refusal(() => w.splits.create(w.ctx({ agentId: 'ag_ben' }), { goal: 'G', parts: [part('A')] })), { code: 'conflict', message: 'Ben is archived.' });
  assert.equal(refusal(() => w.splits.create(w.ctx({ agentId: 'ag_nobody' }), { goal: 'G', parts: [part('A')] })).code, 'not_found');
});

