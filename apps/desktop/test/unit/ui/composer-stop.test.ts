// AF-012 – the composer's Stop (src/ui/chat/composer/stop.ts): the runs at work come from the chat's streaming rows
// (ConversationSummary.live, else a stand-in while `working` names agents); the person's Stop calls messages.stop for
// the chat and the runs it asked to stop no longer count as working at once (the cell is Send again), a new run shows
// Stop again, ended runs are forgotten; a failed call gives the Stop back. Esc stops only when no menu, dialog or
// popover is open and no modifier is held.
// Owns: these assertions only. Never: a real runtime (rpc.call is a fake) or rendering (test/ui/composer-stop-window.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, LiveRun } from '../../../src/shared/model/chat.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';

const calls: Array<{ method: string; params: unknown }> = [];
let fail = false;
(rpc as unknown as { call: unknown }).call = async (method: string, params: unknown) => {
  calls.push({ method, params });
  if (fail) throw new Error('offline');
  return { ok: true };
};
const { escapeStops, pruneStopping, runsAtWork, stopChat, stoppable, stopping } = await import('../../../src/ui/chat/composer/stop.ts');

const run = (runId: string): LiveRun => ({ runId, agentId: 'ag_ava', messageId: `msg_${runId}`, startedAt: 1 });
const chat = (id: string, live: LiveRun[]): Pick<ConversationSummary, 'id' | 'live' | 'working'> =>
  ({ id, live: live.length ? live : undefined, working: live.map((item) => item.agentId) });
const atWork = (c: Pick<ConversationSummary, 'id' | 'live' | 'working'>) => stoppable(runsAtWork(c), stopping.value.get(c.id));

test('the runs at work: the streaming rows\' runs, else one stand-in while agents are named working', () => {
  assert.deepEqual(runsAtWork(chat('ch_a', [run('rn_1'), run('rn_2')])), ['rn_1', 'rn_2']);
  assert.deepEqual(runsAtWork({ working: ['ag_ava'] }), ['*'], 'an older runtime without live runs');
  assert.deepEqual(runsAtWork({ working: [] }), []);
  assert.equal(stoppable([], undefined), false, 'nothing at work: no Stop');
});

test('Stop: messages.stop for the chat, the cell is Send again at once; a new run shows Stop again; ended runs are forgotten', async () => {
  calls.length = 0;
  const working = chat('ch_stop', [run('rn_1')]);
  assert.equal(atWork(working), true, 'Stop while the run works');
  assert.equal(await stopChat(working), true);
  assert.deepEqual(calls, [{ method: 'messages.stop', params: { conversationId: 'ch_stop' } }]);
  assert.equal(atWork(working), false, 'the asked run no longer counts while its row ends');
  const next = chat('ch_stop', [run('rn_1'), run('rn_2')]);
  assert.equal(atWork(next), true, 'a run started after the Stop shows Stop again');
  pruneStopping('ch_stop', ['rn_2']);
  assert.deepEqual([...(stopping.value.get('ch_stop') ?? [])], [], 'rn_1 ended: forgotten');
  pruneStopping('ch_stop', []);
  assert.equal(stopping.value.has('ch_stop'), false);
});

test('a failed Stop gives the Stop back (a notice says why)', async () => {
  fail = true;
  try {
    const working = chat('ch_fail', [run('rn_9')]);
    assert.equal(await stopChat(working), false);
    assert.equal(atWork(working), true, 'still stoppable');
  } finally { fail = false; }
});

test('Esc stops only with nothing open above the chat and without a modifier', () => {
  const none = { querySelector: () => null } as unknown as Document;
  const open = { querySelector: () => ({}) } as unknown as Document;
  const key = (init: Partial<KeyboardEvent> = {}) => ({ key: 'Escape', defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;
  assert.equal(escapeStops(key(), none), true);
  assert.equal(escapeStops(key(), open), false, 'a menu, dialog or popover takes Esc first');
  assert.equal(escapeStops(key({ defaultPrevented: true }), none), false, 'someone already handled it');
  assert.equal(escapeStops(key({ shiftKey: true }), none), false);
});
