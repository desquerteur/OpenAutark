// chat.read and chat.search (tools/builtin/chat.ts, C9 follow-up of INT-2): a line the person
// wrote from a linked Telegram account carries the same note as in the agent's context
// (context/render.ts BRIDGE_OWNER_NOTE) – it answers no open ask, approval or waiting task. The
// same words from the app, and a Telegram contact's line, get no note. B-050 K5: the read tools show the context's
// lines (context/render.ts), so the note follows the line on its own line, as in the context.
// Owns: these assertions only. Never: real bridges, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { BRIDGE_OWNER_NOTE } from '../../../src/runtime/context/render.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

test('chat.read and chat.search mark the person\'s Telegram line like the context does; the app and a contact get no note', async () => {
  const h = harness();
  (h.services as { settings?: unknown }).settings = { get: () => ({ profile: { name: 'Sam' } }) };
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const bridge = { id: 'brg_1', kind: 'telegram' };
  h.chats.send({ conversationId: chat.id, body: 'yes send it', authorId: HUMAN_ID, authorKind: 'human', kind: 'text', meta: { via: 'bridge', bridge: { ...bridge, owner: true } } });
  h.chats.send({ conversationId: chat.id, body: 'yes send it', authorId: HUMAN_ID, authorKind: 'human', kind: 'text' });
  h.chats.send({ conversationId: chat.id, body: 'hello from Telegram', authorId: 'ext:tg:42:sam', authorKind: 'external', kind: 'text', meta: { via: 'bridge', bridge: { ...bridge, senderId: '42' } } });

  const read = chatTools.find((item) => item.name === 'chat.read')!;
  const ctx = {
    agent: h.org.get('ag_ava')!, runId: 'run_read', conversationId: chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext;
  const output = await read.run({}, ctx) as ToolOutput;
  const lines = (output.content[0] as { text: string }).text.split('\n');
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.match(lines[0], /^#\d+ \[[^\]]+\] Sam: yes send it$/);
  assert.equal(lines[1], BRIDGE_OWNER_NOTE, 'the note follows the line from Telegram, as in the context');
  assert.match(BRIDGE_OWNER_NOTE, /^\(via Telegram\)$/);
  assert.match(lines[2], /^#\d+ \[[^\]]+\] Sam: yes send it$/, 'the same words from the app get no note');
  assert.match(lines[3], /^#\d+ \[[^\]]+\] sam \(external contact\): hello from Telegram$/, 'a Telegram contact is no owner');

  // chat.search, the other explicit read, marks the same line.
  const search = chatTools.find((item) => item.name === 'chat.search')!;
  const found = await search.run({ text: 'send' }, ctx) as ToolOutput;
  const hits = (found.content[0] as { text: string }).text.split('\n');
  assert.equal(hits.filter((line) => line.startsWith(`${chat.id} #`)).length, 2, hits.join('\n'));
  assert.equal(hits.filter((line) => line === BRIDGE_OWNER_NOTE).length, 1, 'only the line from the linked Telegram account');
  assert.equal(hits.length, 3, 'the same words from the app get no note');
});
