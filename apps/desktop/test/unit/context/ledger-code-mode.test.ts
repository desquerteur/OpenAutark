// B-049 F9 – Codex code mode in the context ledger (real ledger, real run journal): a script call (exec, engine-native)
// is a t item "exec: <first line>" estimated from its source and what it printed; calls made inside a script ("exec-"
// call ids – also in journals from before F9) are kept and restorable but read as nested: 0 tokens in the live context,
// never marked by the gardener, left out of needsRebuild and of a pin's room, marked nested in the view; a restore that
// brought a nested item back is not condensed (the restore result is that item's only place in the context).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from './ledger-fixture.ts';
import { KEEP_PIN } from '../../../src/runtime/context/ledger/service.ts';
import { LedgerStore } from '../../../src/runtime/context/ledger/store.ts';
import { liveTokens } from '../../../src/shared/model/context-ledger.ts';
import { rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';

const SOURCE = '// @exec: {"yield_time_ms": 10000}\nconst r = await tools.files__read({path:"notes/build.log"});\ntext(r.split("\\n").filter((l) => l.includes("ERROR")).length);\n';
const PRINTED = 'Script completed\nWall time 0.4 seconds\nOutput:\n6';

/** A script call as agents/turn-attempt.ts journals an engine-native call (tool_call own, then its tool_result). */
function script(h: ReturnType<typeof ledgerSetup>, runId: string, callId: string, source: string, output: string) {
  h.journal.item(runId, { kind: 'tool_call', name: 'exec', data: { callId, own: true, args: JSON.stringify({ source }), summary: 'Ran a command' }, effectStatus: 'none' });
  h.journal.item(runId, { kind: 'tool_result', data: { callId, ok: true, summary: 'Script completed', output }, effectStatus: 'none' });
}

test('a script call is a t item from its first line, estimated from source and printed output; its nested calls are kept but cost nothing live', async () => {
  const h = ledgerSetup();
  try {
    const runId = h.turn();
    const big = 'line 1 INFO\n'.repeat(3_000);
    h.ourCall(runId, 'files.read', { path: 'notes/build.log' }, big, 'exec-0f8d712a');
    h.ourCall(runId, 'files.read', { path: 'notes/build.log', fromLine: 3001 }, 'line ERROR', 'exec-69490ec1');
    script(h, runId, 'call_98d156d7', SOURCE, PRINTED);
    await h.journal.settled();
    const items = h.ledger.items(h.tom.id, h.chat.id);
    assert.deepEqual(items.map((item) => [item.itemId, item.kind, item.nested === true]), [['f1', 'file', true], ['f2', 'file', true], ['t3', 'tool', false]]);
    assert.equal(items[2].title, 'exec: const r = await tools.files__read({path:"notes/build.log"});', 'the pragma line is skipped');
    assert.equal(items[2].tokens, Math.ceil(JSON.stringify({ source: SOURCE }).length / 4) + Math.ceil(PRINTED.length / 4));
    assert.ok(items[0].tokens > 8_000, 'a nested item keeps its own size (what a restore costs)');
    assert.deepEqual(items.map(liveTokens), [0, 0, items[2].tokens], 'the live context holds only the script and what it printed');
    assert.equal(h.ledger.original(h.tom.id, h.chat.id, 'f1')!.text.length, big.length, 'context.restore still returns a nested call\'s whole output');

    const view = h.ledger.view(h.tom.id, h.chat.id);
    assert.deepEqual(view.map((entry) => [entry.itemId, entry.nested === true]), [['f1', true], ['f2', true], ['t3', false]]);
    const { items: history } = rebuildItems(view, 0);
    assert.deepEqual(history.map((item) => item.itemId), ['t3']);
    assert.equal(history[0].calls, 'files.read ×2 – context.restore f1, f2 returns their outputs');
    assert.deepEqual(history[0].call?.args, { source: SOURCE });
  } finally { h.cleanup(); }
});

test('a long script whose journaled preview is cut: estimated at its full length (argsChars), titled from the preview\'s head', async () => {
  const h = ledgerSetup();
  try {
    const runId = h.turn();
    const long = `const rows = await tools.files__read({path:"data.csv"});\n${'text(rows.length);\n'.repeat(400)}`;
    const full = JSON.stringify({ source: long });
    // As agents/turn-attempt.ts journals it: a 2,000-char preview ending in "…" plus the full length.
    h.journal.item(runId, { kind: 'tool_call', name: 'exec', data: { callId: 'call_long', own: true, args: `${full.slice(0, 2_000)}…`, argsChars: full.length, summary: 'Ran a command' }, effectStatus: 'none' });
    h.journal.item(runId, { kind: 'tool_result', data: { callId: 'call_long', ok: true, summary: 'Script completed', output: PRINTED }, effectStatus: 'none' });
    await h.journal.settled();
    const [item] = h.ledger.items(h.tom.id, h.chat.id);
    assert.equal(item.title, 'exec: const rows = await tools.files__read({path:"data.csv"});');
    assert.equal(item.tokens, Math.ceil(full.length / 4) + Math.ceil(PRINTED.length / 4), 'the whole script is in the model\'s context');
  } finally { h.cleanup(); }
});

test('nested items are never marked by the gardener, are left out of needsRebuild and of the room kept for good', async () => {
  const h = ledgerSetup();
  try {
    const runId = h.turn();
    h.ourCall(runId, 'files.read', { path: 'a.log' }, 'x'.repeat(20_000), 'exec-1');
    h.ourCall(runId, 'shell.run', { command: 'ls' }, 'y'.repeat(2_000), 'call_2');
    await h.journal.settled();
    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 'f1', state: 'hidden', reason: 'garden pass', by: 'subconscious' }]);
    assert.equal(h.ledger.items(h.tom.id, h.chat.id)[0].state, 'keep', 'the gardener cannot hide what the context never held');
    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 'f1', state: 'condensed', condensed: 'a log', reason: 'agent', by: 'agent' }]);
    assert.equal(h.ledger.needsRebuild(h.tom.id, h.chat.id), undefined, 'a mark on a nested item changes nothing in the session');
    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 't2', state: 'condensed', condensed: 'listed files', reason: 'agent', by: 'agent' }]);
    assert.equal(h.ledger.needsRebuild(h.tom.id, h.chat.id)?.since, 2, 'the first change the session holds');

    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 'f1', state: 'keep', reason: 'context.restore keep', by: 'restore', keep: true }]);
    assert.equal(new LedgerStore(h.db).pinnedTokens(h.tom.id, h.chat.id, KEEP_PIN), 0, 'a nested item kept for good takes no room');
  } finally { h.cleanup(); }
});

test('a restore that brought a nested item back stays whole; another restore is condensed as before', async () => {
  const h = ledgerSetup();
  try {
    const runId = h.turn();
    h.ourCall(runId, 'files.read', { path: 'a.log' }, 'nested output', 'exec-1');
    h.ourCall(runId, 'shell.run', { command: 'ls' }, 'top output', 'call_2');
    h.ourCall(runId, 'context.restore', { ids: ['f1'] }, 'Restored f1 – kept in my context for the next 3 turns.\n[f1] File a.log\nnested output', 'call_3');
    h.ourCall(runId, 'context.restore', { ids: ['t2'] }, 'Restored t2 – kept in my context for the next 3 turns.\n[t2] shell.run\ntop output', 'call_4');
    await h.journal.settled();
    const byId = new Map(h.ledger.items(h.tom.id, h.chat.id).map((item) => [item.itemId, item]));
    assert.equal(byId.get('t3')?.state, 'keep', 'f1 is never replayed: its restore result is its only place');
    assert.equal(byId.get('t4')?.state, 'condensed');
  } finally { h.cleanup(); }
});

test('live 01.11.: a hidden script leaves nothing behind: its calls go with it, none lands on the next script, and a restore brings them back', async () => {
  const h = ledgerSetup();
  try {
    const runId = h.turn();
    h.ourCall(runId, 'files.read', { path: 'a.log' }, 'first output', 'exec-1');
    script(h, runId, 'call_1', SOURCE, PRINTED);
    h.ourCall(runId, 'files.read', { path: 'b.log' }, 'second output', 'exec-2');
    script(h, runId, 'call_2', SOURCE, PRINTED);
    await h.journal.settled();
    const ids = h.ledger.items(h.tom.id, h.chat.id).map((item) => item.itemId);
    assert.deepEqual(ids, ['f1', 't2', 'f3', 't4']);
    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 't2', state: 'hidden', reason: 'old', by: 'subconscious' }]);
    const { items } = rebuildItems(h.ledger.view(h.tom.id, h.chat.id), 0);
    assert.deepEqual(items.map((item) => item.itemId), ['t4']);
    assert.match(items[0].calls ?? '', /f3/);
    assert.doesNotMatch(items[0].calls ?? '', /f1/, 'a call of the hidden script is named nowhere');
    assert.ok(!items.some((item) => item.role === 'assistant' && /code-mode/.test(item.text)), 'no note about it');
    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 't2', state: 'keep', reason: 'back', by: 'restore' }]);
    assert.deepEqual(rebuildItems(h.ledger.view(h.tom.id, h.chat.id), 0).items.map((item) => item.itemId), ['t2', 't4']);
  } finally { h.cleanup(); }
});
