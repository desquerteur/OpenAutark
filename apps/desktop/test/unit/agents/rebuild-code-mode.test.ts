// B-049 F9 – the rebuild's view of Codex code mode (agents/rebuild-items.ts, the guard in agents/rebuild.ts): calls made
// inside a script (nested) are never replayed – the script call after them in their run names them in one line; nested
// calls without a recorded script (journals before F9, a resumed thread without raw items) collapse into ONE note per
// run; the history estimate counts a call once; the shrink rule of a marks rebuild.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyTokens, orphanNote, rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';
import { shrinks } from '../../../src/runtime/agents/rebuild.ts';
import type { LedgerViewItem } from '../../../src/shared/model/context-ledger.ts';

const codex = { engine: 'codex', model: 'codex:gpt-5.6-sol' };
let order = 0;
const entry = (itemId: string, runId: string, patch: Partial<LedgerViewItem> = {}): LedgerViewItem =>
  ({ itemId, kind: 'tool', role: 'tool', text: 'out', origin: codex, order: ++order, runId, state: 'keep', ...patch });
const call = (name: string, callId: string, output = 'out', args: unknown = {}) => ({ call: { name, args, callId, output } });

test('nested calls are left out; the script after them names them; orphans become one note per run; the rest stays in order', () => {
  const view: LedgerViewItem[] = [
    entry('m1', 'run_1', { kind: 'message', role: 'user', text: '[10:00] Alex: count the errors' }),
    entry('f2', 'run_1', { kind: 'file', nested: true, ...call('files.read', 'exec-1', 'line '.repeat(500)) }),
    entry('f3', 'run_1', { kind: 'file', nested: true, ...call('files.read', 'exec-2', 'line '.repeat(500)) }),
    entry('t4', 'run_1', { text: 'Script completed\n6', ...call('exec', 'call_x1', 'Script completed\n6', { source: 'text(6)' }) }),
    entry('t5', 'run_1', { ...call('shell', 'c5', 'clean', { command: 'git status' }) }),
    entry('t6', 'run_2', { nested: true, ...call('shell', 'exec-3', 'a') }),
    entry('r7', 'run_2', { kind: 'reasoning', role: 'assistant', text: 'thinking' }),
    entry('t8', 'run_2', { nested: true, ...call('files.search', 'exec-4', 'b') }),
    entry('a9', 'run_2', { kind: 'assistant', role: 'assistant', text: 'Done: 6 errors.' }),
  ];
  const { items } = rebuildItems(view, 10);
  assert.deepEqual(items.map((item) => item.itemId), ['m1', 't4', 't5', 'r7', 't8', 'a9']);
  assert.equal(items[1].calls, 'files.read ×2 – context.restore f2, f3 returns their outputs');
  assert.equal(items[2].calls, undefined);
  assert.deepEqual(items[4], { itemId: 't8', kind: 't', role: 'assistant', text: orphanNote([{ name: 'shell', itemId: 't6' }, { name: 'files.search', itemId: 't8' }]), origin: codex });
  assert.match(items[4].text, /^\[ran code-mode script\(s\) whose source and printed output are not in this history – calls inside: shell, files\.search – context\.restore t6, t8 returns their outputs\]$/);
  assert.ok(items.every((item) => !item.call || !item.call.callId.startsWith('exec-')), 'no nested call is replayed');
});

test('a script call of another run does not collect the nested calls of this one; a wait call collects like exec', () => {
  const view: LedgerViewItem[] = [
    entry('t1', 'run_1', { nested: true, ...call('files.read', 'exec-1') }),
    entry('t2', 'run_2', { ...call('exec', 'call_x2', 'Script completed', { source: 'text(1)' }) }),
    entry('t3', 'run_3', { nested: true, ...call('files.read', 'exec-3') }),
    entry('t4', 'run_3', { ...call('wait', 'call_w', 'Script completed', { cell_id: '1' }) }),
  ];
  const { items } = rebuildItems(view, 0);
  assert.deepEqual(items.map((item) => [item.itemId, item.call?.name ?? 'note', item.calls ?? '']), [
    ['t1', 'note', ''], ['t2', 'exec', ''], ['t4', 'wait', 'files.read – context.restore t3 returns its output'],
  ]);
});

test('the history estimate counts a call\'s arguments and output once; the shrink rule wants the rebuilt session smaller, by no minimum', () => {
  const items = rebuildItems([
    entry('a1', 'run_1', { kind: 'assistant', role: 'assistant', text: 'x'.repeat(400) }),
    entry('t2', 'run_1', { text: 'y'.repeat(800), ...call('shell', 'c1', 'y'.repeat(800), { command: 'ls' }) }),
  ], 0).items;
  assert.equal(historyTokens(items), Math.ceil((400 + 800 + JSON.stringify({ command: 'ls' }).length) / 4));

  assert.deepEqual(shrinks(21_000, 15_000, 8_000), { ok: false, live: 21_000, rebuilt: 23_000 }, 'the garden scenario of 29.10.: bigger, not smaller');
  assert.equal(shrinks(100_000, 30_000, 8_000).ok, true);
  assert.equal(shrinks(18_500, 10_000, 8_000).ok, true, 'q-r1b2: 500 tokens smaller is smaller (no 12k / 25 % gate)');
  assert.equal(shrinks(18_000, 10_000, 8_000).ok, false, 'the same size is no rebuild');
  assert.deepEqual(shrinks(undefined, 50_000, 8_000), { ok: true, rebuilt: 58_000 }, 'no reported context: no guard');
});
