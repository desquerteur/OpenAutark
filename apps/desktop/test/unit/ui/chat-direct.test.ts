// B-050 K4/K9 in the UI: the new-chat dialog's plan (one member without a topic → the pair's default
// 1:1, else a chat with agents, people and the topic – src/ui/chat/new-chat.ts), who opens the default
// 1:1 directly from "Message" on the owner's window, a phone link and a person's device (chats.direct or
// people.directChat from the real handler table – src/ui/chat/direct.ts), and the
// composer's /important and /silent (the level of the next message, or its text sent at that level –
// src/ui/chat/composer/slash.ts).
// Owns: these assertions. Never: renders (the window check: test/ui/stability-window.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { sessionInfo } from '../../../src/runtime/rpc/handlers/session.ts';
import { FULL_ACCESS } from '../../../src/runtime/pwa/tokens.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import type { ConversationSummary, MessageLevel } from '../../../src/shared/model/chat.ts';
import { newChatPlan } from '../../../src/ui/chat/new-chat.ts';
import { canMessage, directReachable } from '../../../src/ui/chat/direct.ts';
import { parseSlash, runSlash } from '../../../src/ui/chat/composer/slash.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { agents } from '../../../src/ui/lib/store.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const table = createHandlerTable();
agents.value = [{ id: 'ag_mara', name: 'Mara', role: 'Research' } as Agent]; // direct.ts tells agents from people by the store
const as = (scope: ClientScope): void => { session.value = sessionInfo(table, scope); };
const device = (capabilities: readonly DeviceCapability[]): ClientScope => ({ kind: 'device', deviceId: 'dv_phone', capabilities: [...capabilities], secure: true });
const isAgent = (id: string) => id.startsWith('ag_');

test('newChatPlan: one member and no topic opens the default 1:1; a topic or more members create a chat', () => {
  assert.equal(newChatPlan([], 'Launch', isAgent), null, 'nothing chosen: nothing to start');
  assert.deepEqual(newChatPlan(['ag_mara'], '', isAgent), { kind: 'direct', memberId: 'ag_mara' });
  assert.deepEqual(newChatPlan(['per_anna0000001'], '   ', isAgent), { kind: 'direct', memberId: 'per_anna0000001' }, 'a blank topic is none');
  assert.deepEqual(newChatPlan(['ag_mara'], ' Video edit ', isAgent), { kind: 'create', title: 'Video edit', agentIds: ['ag_mara'], people: [] },
    'a topic chat with the same agent stays possible');
  assert.deepEqual(newChatPlan(['ag_mara', 'per_anna0000001', 'ag_tom'], '', isAgent), { kind: 'create', agentIds: ['ag_mara', 'ag_tom'], people: ['per_anna0000001'] },
    'a group without a topic: no title (each viewer sees the names)');
});

test('direct: the owner and a phone open the default 1:1 themselves', () => {
  as({ kind: 'owner' });
  assert.equal(directReachable('ag_mara'), true);
  assert.equal(directReachable('per_anna0000001'), true);
  as(device(FULL_ACCESS));
  assert.equal(directReachable('ag_mara'), true, 'chats.direct belongs to the chat capability');
});

/** A colleague's device (F-52): the session lists exactly the person variants. */
const person = (): void => {
  session.value = { ...sessionInfo(table, { kind: 'person', personId: 'per_anna0000001', deviceId: 'dv_anna', tokenId: 'tk_anna', secure: true }), kind: 'person' };
};

test('direct: a person\'s device opens the 1:1 with a colleague directly (people.directChat)', () => {
  person();
  assert.equal(directReachable('per_tom00000001'), true);
  assert.equal(canMessage('ag_mara'), true, 'Message shows for an agent as well (with chats.create)');
});

test('direct: a person\'s device opens the pair\'s default 1:1 with an agent (chats.direct), not a new chat per click (K1)', () => {
  person();
  assert.equal(directReachable('ag_mara'), true);
  assert.equal(directReachable('owner'), true, 'the owner as a person sees them');
});

test('slash: /important and /silent set the next message\'s level, or send their text at that level', async () => {
  as({ kind: 'owner' });
  assert.deepEqual(parseSlash('/silent'), { name: 'silent', arg: '' });
  assert.deepEqual(parseSlash('/silent  see the notes'), { name: 'silent', arg: 'see the notes' });
  const levels: MessageLevel[] = [];
  const sent: Array<{ body: string; level?: MessageLevel }> = [];
  const ctx = {
    chat: { id: 'ch_1' } as ConversationSummary, openSchedule: () => undefined, openModelMenu: () => undefined,
    setLevel: (level: MessageLevel) => { levels.push(level); },
    send: async (body: string, options?: { level?: MessageLevel }) => { sent.push({ body, level: options?.level }); return true; },
  };
  assert.equal(await runSlash({ name: 'silent', arg: '' }, ctx), true, 'the command clears the field');
  assert.equal(await runSlash({ name: 'important', arg: '' }, ctx), true);
  assert.deepEqual(levels, ['silent', 'important']);
  assert.equal(await runSlash({ name: 'silent', arg: 'see the notes' }, ctx), true);
  assert.equal(await runSlash({ name: 'important', arg: 'now please' }, ctx), true);
  assert.deepEqual(sent, [{ body: 'see the notes', level: 'silent' }, { body: 'now please', level: 'important' }]);
});
