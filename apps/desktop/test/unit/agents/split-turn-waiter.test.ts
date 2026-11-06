// B-057 S6 – the merge reaches whoever asked: the agent's fan-in turn ('child') is awaited by the person whose line the
// splitting turn answered (or the owner for an awaited wake), so its untagged final text is posted and notifies
// (agents/split-turn.ts splitWaiter, turn-prepare.ts planTurn) instead of staying in the run log. A split started by
// unattended work, another thread's group or another reason changes nothing. Fake split service, journal and chat.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWaiter } from '../../../src/runtime/agents/split-turn.ts';
import { defaultVisibility } from '../../../src/runtime/agents/publishing.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Run, WakeReason } from '../../../src/shared/model/runs.ts';
import type { SplitGroupView } from '../../../src/shared/model/splits.ts';

const CHAT = 'ch_launch';
const ANNA = 'per_anna000000';

function services(trigger: WakeReason, groups: Array<Partial<SplitGroupView>>, lines: Array<Partial<Message>>) {
  const parent = { id: 'run_parent', agentId: 'ag_ava', trigger, status: 'done', startedAt: 1_000 } as Run;
  return {
    splits: { list: () => groups.map((group) => ({ id: 'sgr_1', agentId: 'ag_ava', parentRunId: 'run_parent', conversationId: CHAT, thread: CHAT, status: 'settled', createdAt: 900, ...group })) },
    runs: { get: (id: string) => (id === parent.id ? parent : undefined) },
    chats: { messages: () => lines.map((line, index) => ({ id: `m_${index}`, seq: index + 1, kind: 'text', authorKind: 'human', silent: false, ...line })) },
    log: { warn: () => {} },
  } as unknown as RuntimeServices;
}

const ask = (s: RuntimeServices, reason: WakeReason = 'child', thread = CHAT) => splitWaiter(s, { agentId: 'ag_ava', thread, reason, conversationId: CHAT });

test('the person whose line the splitting turn answered waits for the merge; the merge notifies', () => {
  const s = services('message', [{}], [
    { authorId: HUMAN_ID, createdAt: 500 },
    { authorId: ANNA, createdAt: 800 }, // the line the splitting turn answered
    { authorId: HUMAN_ID, createdAt: 2_000 }, // written after the split: its own turn answers it
  ]);
  assert.equal(ask(s), ANNA);
  assert.equal(defaultVisibility({ awaited: ask(s) !== undefined, mustSee: false, reason: 'child' }), 'notify');
  assert.equal(defaultVisibility({ awaited: false, mustSee: false, reason: 'child' }), 'internal', 'without it: the run log only');
});

test('an awaited wake that split waits for the owner; a quiet or unattended start, another thread or reason waits for nobody', () => {
  assert.equal(ask(services('answer', [{}], [])), HUMAN_ID);
  assert.equal(ask(services('message', [{}], [])), HUMAN_ID, 'a chat message started it, its line is out of view: the owner');
  assert.equal(ask(services('schedule' as WakeReason, [{}], [{ authorId: HUMAN_ID, createdAt: 500 }])), undefined, 'unattended work');
  assert.equal(ask(services('message', [{ thread: 'task:other' }], [{ authorId: HUMAN_ID, createdAt: 500 }])), undefined, 'another thread');
  assert.equal(ask(services('message', [{ status: 'gathered' }], [{ authorId: HUMAN_ID, createdAt: 500 }])), undefined, 'already gathered');
  assert.equal(ask(services('message', [{}], [{ authorId: HUMAN_ID, createdAt: 500 }]), 'message'), undefined, 'not a fan-in turn');
  const broken = { splits: { list: () => { throw new Error('db gone'); } }, log: { warn: () => {} } } as unknown as RuntimeServices;
  assert.equal(ask(broken), undefined, 'never throws');
});
