// D15 regression (context/delta.ts + render.ts): the agent learns what its live voice told the person. Its own
// call lines a realtime session (meta.call.spoken / voice 'realtime') or the call talker (voice 'talker') wrote
// show in the next delta as "(my live voice said: …)" – quiet ones under a "(quiet)" header, capped in length and
// to the newest MAX_VOICE_LINES –, while the agent's own ordinary replies stay hidden; a colleague's voice line
// reads as an ordinary line; the catch-up of a resumed session does not mistake voice lines for its replies.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.ts';
import { MAX_VOICE_LINES } from '../../../src/runtime/context/delta.ts';
import { liveVoiceLine } from '../../../src/runtime/context/render.ts';

function setup() {
  const f = fixture();
  const chat = f.chats.create({ title: 'Call', agentIds: [f.vid.id], createdBy: 'human' });
  const call = (voice: 'realtime' | 'talker', extra: Record<string, unknown> = {}) => ({ call: { id: 'call_1', participant: `agent:${f.vid.id}`, name: f.vid.name, voice, ...extra } });
  return { ...f, chat, call };
}

test('own live-voice lines reach the next delta as "(my live voice said: …)"; own replies stay hidden', () => {
  const f = setup();
  const start = f.chats.send({ conversationId: f.chat.id, body: 'Before the call', authorId: 'human' });
  f.chats.send({ conversationId: f.chat.id, body: 'Can you check the prices?', authorId: 'human', silent: true, meta: { call: { id: 'call_1', participant: 'device:pc', name: 'PC' } } });
  f.chats.send({ conversationId: f.chat.id, body: 'Sure, I will check the prices now.', authorId: f.vid.id, authorKind: 'agent', meta: f.call('talker') });
  f.chats.send({ conversationId: f.chat.id, body: 'Two minutes, I promise.', authorId: f.vid.id, authorKind: 'agent', silent: true, meta: { via: 'voice', ...f.call('realtime', { spoken: true }) } });
  f.chats.send({ conversationId: f.chat.id, body: 'My written answer', authorId: f.vid.id, authorKind: 'agent' });
  const delta = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: start.seq, full: false });
  assert.match(delta.text, /Can you check the prices\?/);
  assert.match(delta.text, /\(my live voice said: "Sure, I will check the prices now\."\)/);
  // B-050 K5: a quiet line keeps its header with "(quiet)" (only status lines read "· …").
  assert.match(delta.text, /\[\d\d:\d\d\] Vic \(me\) \(quiet\): \(my live voice said: "Two minutes, I promise\."\)/, 'a quiet realtime line, marked as the agent\'s own');
  assert.doesNotMatch(delta.text, /My written answer/, 'the agent\'s own reply is still not shown back');
  assert.doesNotMatch(delta.text, /missed the lines below/, 'no catch-up note for voice lines');
});

test('voice lines are capped: the newest MAX_VOICE_LINES, each at most 400 characters; a line with quotes stays one quote', () => {
  const f = setup();
  const start = f.chats.send({ conversationId: f.chat.id, body: 'Start', authorId: 'human' });
  for (let index = 0; index < MAX_VOICE_LINES + 3; index++) {
    f.chats.send({ conversationId: f.chat.id, body: `Voice line ${index}`, authorId: f.vid.id, authorKind: 'agent', meta: f.call('talker') });
  }
  f.chats.send({ conversationId: f.chat.id, body: `He said "go" ${'x'.repeat(900)}`, authorId: f.vid.id, authorKind: 'agent', meta: f.call('talker') });
  const delta = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: start.seq, full: false });
  const voiced = delta.text.split('\n').filter((line) => line.includes('my live voice said'));
  assert.equal(voiced.length, MAX_VOICE_LINES);
  assert.doesNotMatch(delta.text, /Voice line 0\b|Voice line 1\b|Voice line 2\b|Voice line 3\b/, 'the oldest left out');
  assert.match(delta.text, /Voice line 14/);
  const long = voiced.at(-1)!;
  assert.ok(long.length < 460, 'capped');
  assert.match(long, /said: "He said 'go' x+…"\)$/);
});

test('liveVoiceLine: only agent text lines its live voice said', () => {
  const meta = (call: Record<string, unknown> | undefined) => ({ call }) as never;
  assert.equal(liveVoiceLine({ kind: 'text', authorKind: 'agent', meta: meta({ id: 'c', participant: 'agent:a', name: 'A', spoken: true }) }), true);
  assert.equal(liveVoiceLine({ kind: 'text', authorKind: 'agent', meta: meta({ id: 'c', participant: 'agent:a', name: 'A', voice: 'talker' }) }), true);
  assert.equal(liveVoiceLine({ kind: 'text', authorKind: 'agent', meta: meta({ id: 'c', participant: 'agent:a', name: 'A' }) }), false, "the agent's own call answer");
  assert.equal(liveVoiceLine({ kind: 'text', authorKind: 'system', meta: meta({ id: 'c', participant: 'agent:a', name: 'A', voice: 'talker' }) }), false, 'a digest line');
  assert.equal(liveVoiceLine({ kind: 'text', authorKind: 'agent', meta: meta(undefined) }), false);
});

test('the catch-up of a resumed session keeps voice lines as they are (no "(via model)")', () => {
  const f = setup();
  const start = f.chats.send({ conversationId: f.chat.id, body: 'Start', authorId: 'human' });
  f.chats.send({ conversationId: f.chat.id, body: 'On my way.', authorId: f.vid.id, authorKind: 'agent', meta: { model: 'gpt-realtime', ...f.call('realtime', { spoken: true }) } });
  const delta = f.context.delta({ agent: f.vid, conversationId: f.chat.id, sinceSeq: start.seq, full: false, includeOwn: true, knownSeqs: [] });
  assert.match(delta.text, /\(my live voice said: "On my way\."\)/);
  assert.doesNotMatch(delta.text, /via gpt-realtime/);
});
