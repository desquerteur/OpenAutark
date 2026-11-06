// Round 3 re-check (live run A) – "## This chat" (context/chat-section.ts sentFrom): the manager opened a work group from
// its 1:1, sent its line there and ended its turn as told; in the group's turns it never knew the person had asked
// "then tell me the result here". Now the section names the chat and the person's request the sending turn served –
// also while that turn's own final answer stands there – until the agent writes there from another turn; never for a
// line sent from a turn in the same chat.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrCreateDirect } from '../../../src/runtime/chat/direct.ts';
import { chatSection } from '../../../src/runtime/context/chat-section.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { agent, harness } from '../chat/harness.ts';

const REQUEST = 'Open a small work group with Mira, agree on one name, then tell me the result here in one line.';

function scene() {
  const h = harness();
  const manager = h.org.add(agent('ag_mgr', 'Manager'));
  h.org.add(agent('ag_mira', 'Mira'));
  const direct = h.chats.get(findOrCreateDirect(h.services, HUMAN_ID, 'ag_mgr'))!; // the default 1:1: named after the other member
  h.chats.send({ conversationId: direct.id, authorId: HUMAN_ID, body: REQUEST });
  const room = h.chats.create({ title: 'Naming', agentIds: ['ag_mgr', 'ag_mira'], humans: false, createdBy: 'ag_mgr', lead: 'ag_mgr' });
  const runChat: Record<string, string> = { run_1: direct.id, run_2: room.id, run_3: room.id };
  const services = {
    ...h.services,
    runs: { get: (id: string) => (runChat[id] ? { id, conversationId: runChat[id] } : undefined) },
    settings: { get: () => ({ profile: { name: 'Alex' } }) },
  } as unknown as RuntimeServices;
  const section = () => chatSection(services, manager, room.id);
  const send = (conversationId: string, body: string, runId: string, sent = true) => {
    h.clock.advance(1000);
    return h.chats.send({ conversationId, authorId: 'ag_mgr', authorKind: 'agent', body, runId, ...(sent ? { meta: { sentDuringRun: true } } : {}) });
  };
  return { ...h, direct, room, section, send };
}

test("a line sent from the 1:1's turn: the group's section names that chat and the person's request until it is answered there", () => {
  const h = scene();
  assert.doesNotMatch(h.section(), /I wrote/, 'nothing sent yet');
  const line = h.send(h.room.id, '@Mira My shortlist: Notelo, Jotnest. What would you suggest?', 'run_1');
  const lines = h.section().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], `I wrote #${line.seq} here from my chat "Alex" (${h.direct.id}) for Alex's request there: "${REQUEST}" What it asks for there (a result, a reply) goes there – chat.send with that chatId.`);
  h.send(h.direct.id, 'I opened a group with Mira and will report back.', 'run_1', false); // that turn's own final answer there
  assert.match(h.section(), /I wrote #\d+ here from my chat "Alex"/, 'still due');
  h.send(h.direct.id, 'Mira and I agreed on Notelo.', 'run_2'); // the report, from a turn in the group
  assert.doesNotMatch(h.section(), /I wrote/, 'answered there');
});

test('a line sent from a turn in the same chat, or one the agent posted as a final answer, names no other chat', () => {
  const h = scene();
  h.send(h.room.id, '@Mira and a tagline?', 'run_3');
  assert.doesNotMatch(h.section(), /I wrote/);
  h.send(h.room.id, 'Notelo it is.', 'run_1', false);
  assert.doesNotMatch(h.section(), /I wrote/, 'only chat.send lines count');
});
