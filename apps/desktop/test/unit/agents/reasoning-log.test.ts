// D5: live reasoning in the run journal (src/runtime/agents/reasoning-log.ts) – one item per block
// from its first words on, throttled updates, closed at its end (or by the next step), the engine's
// authoritative text, a cap per block (not per attempt), redaction, and the headline as live status
// instead of the fixed word "thinking". Root cause fixed: reasoning was buffered per attempt and
// journaled once after engine.run returned (after every tool call, never live).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_BLOCK_CHARS, ReasoningLog } from '../../../src/runtime/agents/reasoning-log.ts';

function sink(options: { redact?: (text: string) => string } = {}) {
  let now = 1_000;
  let n = 0;
  const items = new Map<string, { summary: string; live: boolean }>();
  const order: string[] = [];
  const statuses: string[] = [];
  const writes: string[] = [];
  const timers: Array<() => void> = [];
  const log = new ReasoningLog({
    open: (summary) => { const id = `ri_${++n}`; items.set(id, { summary, live: true }); order.push(id); writes.push(`open ${id}`); return id; },
    update: (id, data) => { items.set(id, data); writes.push(`update ${id} ${data.live ? 'live' : 'done'}`); },
    redact: options.redact ?? ((text) => text),
    status: (note) => statuses.push(note),
    now: () => now,
    later: (run) => { timers.push(run); return () => { const at = timers.indexOf(run); if (at >= 0) timers.splice(at, 1); }; },
  });
  return { log, items, order, statuses, writes, timers, advance: (ms: number) => { now += ms; } };
}

test('a block is journaled at its first words, updated at most every 400 ms (plus one trailing write) and closed at its end', () => {
  const s = sink();
  s.log.delta('**Planning the PC search**\n\n', 'rs_1');
  assert.deepEqual(s.writes, ['open ri_1'], 'live from the first words on');
  assert.deepEqual(s.items.get('ri_1'), { summary: '**Planning the PC search**', live: true });
  assert.deepEqual(s.statuses, ['Planning the PC search'], 'the headline is the live status');
  s.log.delta('Looking at ', 'rs_1');
  s.log.delta('the folders', 'rs_1');
  assert.equal(s.writes.length, 1, 'throttled');
  assert.equal(s.timers.length, 1, 'one trailing write is pending');
  s.timers[0]();
  assert.equal(s.items.get('ri_1')?.summary, '**Planning the PC search**\n\nLooking at the folders');
  s.advance(500);
  s.log.delta('.', 'rs_1');
  assert.equal(s.writes.at(-1), 'update ri_1 live', 'the throttle allows a write after 400 ms');
  s.log.end('rs_1');
  assert.deepEqual(s.items.get('ri_1'), { summary: '**Planning the PC search**\n\nLooking at the folders.', live: false });
  assert.equal(s.log.text, '**Planning the PC search**\n\nLooking at the folders.');
});

test('blocks interleave with steps: another id or the next step closes a block; a section break alone opens nothing', () => {
  const s = sink();
  s.log.delta('\n\n', 'rs_0');
  assert.equal(s.writes.length, 0, 'whitespace before any words opens no item');
  s.log.delta('First thought.', 'rs_1');
  s.log.delta('Second thought.', 'rs_2');
  assert.deepEqual(s.order, ['ri_1', 'ri_2']);
  assert.equal(s.items.get('ri_1')?.live, false, 'a new block id closes the one before');
  s.log.close(); // a tool call starts
  assert.equal(s.items.get('ri_2')?.live, false);
  s.log.delta('Without an id', undefined);
  s.log.delta(' it continues', undefined);
  s.log.close();
  assert.deepEqual(s.items.get('ri_3'), { summary: 'Without an id it continues', live: false });
  assert.deepEqual(s.statuses, ['First thought', 'Second thought', 'Without an id', 'Without an id it continues'], 'each new headline once');
});

test('the engine\'s end text is authoritative – for the open block, a closed one, or a block that never streamed', () => {
  const s = sink();
  s.log.delta('Partial summ', 'rs_1');
  s.log.end('rs_1', '**Checking**\n\nPartial summary, complete.');
  assert.deepEqual(s.items.get('ri_1'), { summary: '**Checking**\n\nPartial summary, complete.', live: false });
  s.log.delta('Later', 'rs_2');
  s.log.close();
  s.log.end('rs_2', 'Later, in full.');
  assert.equal(s.items.get('ri_2')?.summary, 'Later, in full.', 'a block a step closed still gets its text');
  s.log.end('rs_3', 'Only the end arrived.');
  assert.deepEqual(s.items.get('ri_3'), { summary: 'Only the end arrived.', live: false });
  s.log.end('rs_4');
  assert.equal(s.items.size, 3, 'an end without text or block journals nothing');
});

test('the cap is per block, not per attempt; text is redacted before it is journaled', () => {
  const s = sink({ redact: (text) => text.replace(/sk-[a-z0-9]+/g, '[secret]') });
  s.log.delta(`key sk-abc123 ${'x'.repeat(REASONING_BLOCK_CHARS + 50)}`, 'rs_1');
  s.log.close();
  s.log.delta('A second block after a long one.', 'rs_2');
  s.log.close();
  const first = s.items.get('ri_1')!.summary;
  assert.ok(first.startsWith('key [secret] '), 'redacted');
  assert.ok(first.length <= REASONING_BLOCK_CHARS);
  assert.equal(s.items.get('ri_2')?.summary, 'A second block after a long one.', 'the next block is not cut off by the first');
});

test('a journal that fails never reaches the turn', () => {
  const log = new ReasoningLog({
    open: () => { throw new Error('disk full'); }, update: () => { throw new Error('disk full'); },
    redact: (text) => text, status: () => {}, now: () => 0, later: () => () => {},
  });
  assert.doesNotThrow(() => { log.delta('A thought', 'rs_1'); log.end('rs_1', 'A thought, whole.'); log.close(); });
  assert.equal(log.text, 'A thought, whole.');
});
