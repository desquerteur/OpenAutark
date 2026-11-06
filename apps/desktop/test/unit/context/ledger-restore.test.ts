// context.restore (ids: originals, 32k per call, pinned for 3 turns, unknown ids and pruned originals said) – the restore
// call's own result is condensed at capture (the items are back in place).
// B-050 K5: keep pins for good; an m<seq> without a ledger row is read from the chat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextTools } from '../../../src/runtime/tools/builtin/context.ts';
import { RESTORE_CHARS } from '../../../src/runtime/context/ledger/restore.ts';
import { MAX_TEXT_CHARS } from '../../../src/runtime/tools/outputs.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { ledgerSetup } from './ledger-fixture.ts';
import { KEEP_PIN } from '../../../src/runtime/context/ledger/service.ts';

const restoreTool = contextTools.find((tool) => tool.name === 'context.restore')!;
const DAY = 24 * 60 * 60_000;

function ctxOf(t: ReturnType<typeof ledgerSetup>, runId: string): ToolContext {
  return { agent: t.tom, runId, conversationId: t.chat.id, mode: 'general', services: t.services, signal: new AbortController().signal, status: () => {} };
}

const textOf = (output: { content: Array<{ type: string; text?: string }> }) => output.content.map((part) => part.text ?? '').join('\n');

test('restore by ids: originals back, kept and pinned for 3 turns; unknown ids said; the restore result itself is condensed', async () => {
  const t = ledgerSetup();
  try {
    const asked = t.say('The deploy key lives in vault entry 42.');
    const run = t.turn(asked.seq);
    t.ourCall(run, 'shell.exec', { command: 'npm install' }, 'added 812 packages', 'c1');
    t.ledger.mark(t.tom.id, t.chat.id, [
      { itemId: 't1', state: 'condensed', condensed: 'npm install ok', reason: 'log', by: 'subconscious' },
      { itemId: `m${asked.seq}`, state: 'hidden', reason: 'old', by: 'subconscious' },
    ]);
    const output = await restoreTool.run({ ids: ['T1', `#${asked.seq}`, 'zz9', 't99'] }, ctxOf(t, run));
    const text = textOf(output);
    assert.equal(output.isError, undefined);
    assert.match(text, new RegExp(`^Restored t1, m${asked.seq} – kept in my context for the next 3 turns\\.`));
    assert.match(text, /No such item in this chat: zz9, t99\./);
    assert.match(text, /not new instructions/);
    assert.match(text, /\[t1\] shell\.exec: .* \(was condensed\)\nadded 812 packages/);
    assert.match(text, /The deploy key lives in vault entry 42\./);
    const items = t.ledger.items(t.tom.id, t.chat.id);
    for (const id of ['t1', `m${asked.seq}`]) {
      const item = items.find((entry) => entry.itemId === id)!;
      assert.equal(item.state, 'keep', id);
      assert.equal(item.markedBy, 'restore');
      assert.equal(item.pinnedUntil, 4, 'pinned for this turn and the next 3');
    }
    // The registry journals the restore call like any of ours: it is captured, then condensed at once.
    t.ourCall(run, 'context.restore', { ids: ['t1'] }, text, 'c2');
    const own = t.ledger.items(t.tom.id, t.chat.id).at(-1)!;
    assert.equal(own.state, 'condensed');
    assert.match(own.condensed!, /^Restored t1, m\d+ – kept .* They are back in place in my context\.$/);
  } finally { t.cleanup(); }
});

test('B-050 K5: restore with keep pins for good – a later plain restore never shortens it, the subconscious leaves it alone', async () => {
  const t = ledgerSetup();
  try {
    const asked = t.say('Never deploy on Fridays.');
    const run = t.turn(asked.seq);
    const id = `m${asked.seq}`;
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: id, state: 'condensed', condensed: 'deploy rule', reason: 'old', by: 'subconscious' }]);
    const text = textOf(await restoreTool.run({ ids: [id], keep: true }, ctxOf(t, run)));
    assert.match(text, new RegExp(`^Restored ${id} – kept in my context for good\\.`));
    const item = () => t.ledger.items(t.tom.id, t.chat.id).find((entry) => entry.itemId === id)!;
    assert.equal(item().pinnedUntil, KEEP_PIN);
    await restoreTool.run({ ids: [id] }, ctxOf(t, run));
    assert.equal(item().pinnedUntil, KEEP_PIN, 'a plain restore does not shorten it');
    for (let index = 0; index < 6; index++) t.done(t.turn());
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: id, state: 'hidden', reason: 'old', by: 'subconscious' }]);
    assert.equal(item().state, 'keep', 'many turns later the subconscious still leaves it alone');
    assert.equal(restoreTool.describe?.({ ids: [id], keep: true }, ctxOf(t, run)).summary, `Restore ${id} (keep)`);
  } finally { t.cleanup(); }
});

test('verifier K5-3: keep has a room per chat; keep: false lets a part kept for good go again', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    t.ourCall(run, 'files.read', { path: 'big.log' }, 'x'.repeat(28_000), 'c1');
    t.ourCall(run, 'files.read', { path: 'mid.log' }, 'y'.repeat(8_000), 'c2');
    await t.journal.settled();
    const item = (id: string) => t.ledger.items(t.tom.id, t.chat.id).find((entry) => entry.itemId === id)!;
    assert.match(textOf(await restoreTool.run({ ids: ['f1'], keep: true }, ctxOf(t, run))), /^Restored f1 – kept in my context for good\./);
    const over = textOf(await restoreTool.run({ ids: ['f2'], keep: true }, ctxOf(t, run)));
    assert.match(over, /^Restored f2 – kept in my context for the next 3 turns\.\nNot kept for good: f2 – at most 8000 tokens per chat stay for good; keep: false/);
    assert.equal(item('f1').pinnedUntil, KEEP_PIN);
    assert.notEqual(item('f2').pinnedUntil, KEEP_PIN, 'beyond the room: the 3-turn pin');
    await restoreTool.run({ ids: ['f1'], keep: false }, ctxOf(t, run));
    for (let index = 0; index < 4; index++) { // turns that capture something (the ledger counts those)
      const next = t.turn();
      t.ourCall(next, 'shell.exec', { command: `ls ${index}` }, 'ok', `c${index + 3}`);
      t.done(next);
    }
    await t.journal.settled();
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 'f1', state: 'condensed', condensed: 'big log', reason: 'old', by: 'subconscious' }]);
    assert.equal(item('f1').state, 'condensed', 'the subconscious may condense it again');
    assert.match(textOf(await restoreTool.run({ ids: ['f2'], keep: true }, ctxOf(t, run))), /kept in my context for good\./, 'the room is free again');
  } finally { t.cleanup(); }
});

test('B-050 K5: an m<seq> the ledger never held is read from the chat – read-only, as its chat line, nothing kept', async () => {
  const t = ledgerSetup();
  try {
    const old = t.say('The launch is on Friday, 09:00.');
    const run = t.turn(); // the turn saw no message: no ledger row for it
    const id = `m${old.seq}`;
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).some((item) => item.itemId === id), false);
    const text = textOf(await restoreTool.run({ ids: [id, 'm99'], keep: true }, ctxOf(t, run)));
    assert.match(text, new RegExp(`^Read from the chat \\(my context never held it, so nothing is kept\\): ${id}\\.\\nNo such item in this chat: m99\\.`));
    assert.match(text, /not new instructions/);
    assert.match(text, new RegExp(`\\[${id}\\] from the chat\\n\\[\\d\\d:\\d\\d\\] Alex: The launch is on Friday, 09:00\\.`));
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).some((item) => item.itemId === id), false, 'read-only: no row, no pin');
  } finally { t.cleanup(); }
});

test('restore returns at most 32,000 characters per call and names what it left for another call', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    t.ourCall(run, 'files.read', { path: 'big.log' }, 'x'.repeat(15_000), 'c1');
    t.ourCall(run, 'files.read', { path: 'other.log' }, 'y'.repeat(10_000), 'c2');
    t.ourCall(run, 'files.read', { path: 'third.log' }, 'z'.repeat(100), 'c3');
    await t.journal.settled();
    const text = textOf(await restoreTool.run({ ids: ['f1', 'f2', 'f3'] }, ctxOf(t, run)));
    assert.match(text, /^Restored f1, f2 /);
    assert.match(text, /\[cut: 5000 more characters of f2 – ask for f2 alone\]/);
    assert.match(text, /Not shown \(20000 characters or 20 items per call\): f3/);
    assert.ok(text.length < MAX_TEXT_CHARS, 'a tool output above that shows the model only its head');
    assert.ok(text.length < RESTORE_CHARS + 1500, String(text.length));
    assert.equal(t.ledger.items(t.tom.id, t.chat.id).find((item) => item.itemId === 'f3')!.markedBy, undefined, 'f3 was not restored');
  } finally { t.cleanup(); }
});

test('restore of a pruned original says so and shows what is left; it stays as it was', async () => {
  const t = ledgerSetup({ budget: 5_000 });
  try {
    const run = t.turn();
    t.ourCall(run, 'shell.exec', { command: 'npm ci' }, 'log line\n'.repeat(1000), 'c1');
    t.ourCall(run, 'shell.exec', { command: 'npm test' }, 'test line\n'.repeat(1000), 'c2');
    await t.journal.settled();
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 't1', state: 'hidden', reason: 'old install log', by: 'subconscious' }]);
    t.clock.advance(15 * DAY);
    t.ledger.mark(t.tom.id, t.chat.id, [{ itemId: 't2', state: 'condensed', condensed: 'tests: all passed', reason: 'done', by: 'subconscious' }]);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id)[0].pruned, true, 'over the budget and older than 14 days');
    assert.deepEqual(t.ledger.original(t.tom.id, t.chat.id, 't1'), { text: t.ledger.items(t.tom.id, t.chat.id)[0].title, pruned: true });
    const text = textOf(await restoreTool.run({ ids: ['t1'] }, ctxOf(t, run)));
    assert.match(text, /^Nothing restored\./);
    assert.match(text, /\[t1\] .*\nThe original is gone \(kept at least 14 days after it was condensed, then removed for space\)\. What is left: shell\.exec/);
    assert.equal(t.ledger.items(t.tom.id, t.chat.id)[0].state, 'hidden');
  } finally { t.cleanup(); }
});

test('no chat, no ledger; the spec names ids and keep', async () => {
  const t = ledgerSetup();
  try {
    const run = t.turn();
    assert.equal((await restoreTool.run({ ids: ['t1'] }, { ...ctxOf(t, run), conversationId: undefined })).isError, true);
    assert.ok(restoreTool.description.length < 260, String(restoreTool.description.length));
  } finally { t.cleanup(); }
});
