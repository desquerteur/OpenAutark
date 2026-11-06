// C8 – the volatile prompt's "This chat" line (context/prompt-volatile.ts chatSection) names an
// external agent "<label> (external agent)" and a bridged contact "<label> (external contact)",
// like the chat lines do, never by its raw 'ext:' member id; org agents keep their names.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVolatile } from '../../../src/runtime/context/prompt-volatile.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';

test('the chat line names external members as such, never by their ext: id', () => {
  const chat = 'ch_launch00000a';
  const members = [HUMAN_ID, 'ag_ava', 'ag_bob', 'ext:api:0123456789:Research-Bot', 'ext:tg:42:Sam (Telegram)']
    .map((memberId) => ({ conversationId: chat, memberId }));
  const services = {
    chats: { get: () => ({ id: chat, title: 'Launch', settings: {} }), members: () => members, lead: () => undefined },
    settings: { get: () => ({ profile: { name: 'Alex' } }) },
    org: { get: (id: string) => (id === 'ag_bob' ? { id, name: 'Bob' } : undefined) },
  } as unknown as RuntimeServices;
  const text = buildVolatile(services, { agent: { id: 'ag_ava', name: 'Ava' } as Agent, conversationId: chat, route: {} as never });
  // B-050 K3/K5: the CEO is labelled as such, and a group reads as a discussion among peers.
  assert.match(text, /^Launch \(ch_launch00000a\) · group with Alex \(CEO\), Bob, Research-Bot \(external agent\), Sam \(Telegram\) \(external contact\) · a discussion among peers Alex takes part in$/m);
  assert.ok(!text.includes('ext:'), text);
});
