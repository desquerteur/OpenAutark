// F-52 (UI, ui/chat/leave.ts): "Leave chat" shows only on a person's device that may change memberships,
// in a chat she is still in (not a system chat, never on the owner's side); leaving asks first, removes
// only herself ('human' is the caller in her session) and then takes the chat out of her lists.
// Owns: these assertions only. Never: the DOM or the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import { LEAVE_CONFIRM, leaveChat, leaveShown, type LeaveEnv } from '../../../src/ui/chat/leave.ts';

const member = (memberId: string, kind: Member['kind'], leftAt?: number): Member => ({ conversationId: 'ch_1', memberId, kind, role: 'member', readSeq: 0, joinedAt: 0, ...(leftAt ? { leftAt } : {}) });
const chat = (members: Member[], settings: ConversationSummary['settings'] = {}) => ({ members, settings });

test('"Leave chat" only for a person who is still in the chat', () => {
  const hers = chat([member('human', 'human'), member('owner', 'human'), member('ag_ava', 'agent')]);
  assert.equal(leaveShown(hers, true, true), true);
  assert.equal(leaveShown(hers, false, true), false, 'not on the owner\'s window or phones');
  assert.equal(leaveShown(hers, true, false), false, 'not when the runtime does not let this device change members');
  assert.equal(leaveShown(chat([member('human', 'human', 5), member('ag_ava', 'agent')]), true, true), false, 'she left already');
  assert.equal(leaveShown(chat([member('human', 'human')], { system: 'todo' }), true, true), false, 'never a system chat');
});

function env(answer: boolean, fail?: Error) {
  const seen: { confirms: unknown[]; calls: unknown[]; left: string[]; errors: unknown[] } = { confirms: [], calls: [], left: [], errors: [] };
  const value: LeaveEnv = {
    confirm: async (options) => { seen.confirms.push(options); return answer; },
    leave: async (params) => { seen.calls.push(params); if (fail) throw fail; return []; },
    left: (id) => { seen.left.push(id); },
    failed: (error) => { seen.errors.push(error); },
  };
  return { value, seen };
}

test('leaving asks first, removes only herself and takes the chat out of her lists', async () => {
  const yes = env(true);
  assert.equal(await leaveChat('ch_1', yes.value), true);
  assert.deepEqual(yes.seen.confirms, [LEAVE_CONFIRM]);
  assert.equal(LEAVE_CONFIRM.confirmLabel, 'Leave');
  assert.deepEqual(yes.seen.calls, [{ id: 'ch_1', remove: ['human'] }], 'only the caller ("human" in her session)');
  assert.deepEqual(yes.seen.left, ['ch_1']);

  const no = env(false);
  assert.equal(await leaveChat('ch_1', no.value), false);
  assert.deepEqual(no.seen.calls, [], 'cancelled: nothing is sent');
  assert.deepEqual(no.seen.left, []);

  const refused = env(true, new Error('Chat not found.'));
  assert.equal(await leaveChat('ch_1', refused.value), false);
  assert.deepEqual(refused.seen.left, [], 'a refused leave keeps the chat');
  assert.equal(refused.seen.errors.length, 1);
});
