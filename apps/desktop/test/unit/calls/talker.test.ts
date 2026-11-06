// The call talker (src/runtime/calls/talker.ts) with the real chat service and delivery and a fake model: a spoken line
// stored quiet gets a line of the agent's live voice in the same call at once and no wake for 'none'; 'next' and 'now'
// reach the agent; a failed or useless answer falls back to the normal delivery; lines said meanwhile are answered
// together; off by key; in a default 1:1 with more agents as the agent of its pair (a group's lines go the delivery's way),
// a line naming another member the normal way; what the model is given – who works and on which PC from the rows that
// stream, and for an agent at home on another PC that a run there without a chat does not show; messages.send hands it
// plain live lines only, marked with the call.
// Owns: these assertions only. Never: a real model (no live run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { quietPickupLine } from '../../../src/runtime/chat/quiet-pickup.ts';
import { CallTalker, parseDecision, talkerInput, talkerSystem } from '../../../src/runtime/calls/talker.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { callRecord } from '../../../src/shared/model/call.ts';
import { createCalls, stopCalls } from '../../../src/runtime/calls/wiring.ts';
import { agent, harness } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';

type Ask = Parameters<StructuredRunner>[0];

function setup(answers: (ask: Ask, index: number) => unknown, voice: Record<string, unknown> = {}) {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava', { role: 'Assistant' }));
  h.org.add(agent('ag_ben', 'Ben'));
  const solo = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const group = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, lead: 'ag_ben' });
  const direct = h.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: HUMAN_ID, settings: { direct: true, directPair: ['ag_ben', HUMAN_ID] } }); // Ben's 1:1, Ava added
  Object.assign(h.services, {
    secrets: { redact: (text: string) => text.replace('s3cret', '[hidden]') },
    settings: { get: () => ({ profile: { name: 'Gerd', language: 'de' }, voice: { vocabulary: ['Teydra'], ...voice } }) },
  });
  const asks: Ask[] = [];
  const steers: string[] = [];
  Object.assign(h.services.dispatcher, { relay: async (_agent: string, _chat: string, text: string) => { steers.push(text); return steerable.value; } });
  const steerable = { value: false };
  const run: StructuredRunner = async (ask) => {
    asks.push(ask);
    const answer = await answers(ask, asks.length - 1);
    return { text: typeof answer === 'string' ? answer : '', structured: typeof answer === 'string' ? undefined : answer, by: 'google:gemini-3.8-flash' };
  };
  const talker = new CallTalker({ services: () => h.services as RuntimeServices, run });
  const say = (body: string, conversationId = solo.id): Message => {
    const message = h.chats.send({ conversationId, body, authorId: HUMAN_ID, authorKind: 'human', silent: true, speech: { source: 'endpoint', live: true }, meta: { call: { id: 'call_talk1', participant: 'device:pc', name: 'Office PC' } } });
    talker.heard(message);
    return message;
  };
  const voiceLines = () => h.chats.messages(solo.id, { limit: 20 }).filter((message) => message.meta.call?.voice === 'talker');
  return { ...h, solo, group, direct, talker, asks, steers, steerable, say, voiceLines };
}

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

test('talk: the live voice answers at once as the agent, nobody is woken, and the line is no pickup', async () => {
  const h = setup(() => ({ say: 'Mir geht es gut.', relay: 'none' }));
  const line = h.say('Wie geht es dir?');
  assert.equal(line.silent, true);
  assert.equal(quietPickupLine(line), false, 'a call line is not picked up later');
  await settled();
  const [said] = h.voiceLines();
  assert.equal(said.body, 'Mir geht es gut.');
  assert.equal(said.authorId, 'ag_ava');
  assert.equal(said.silent, false, 'the device reads it aloud');
  assert.equal(said.meta.model, 'google:gemini-3.8-flash');
  assert.equal(said.meta.call?.id, 'call_talk1', 'the same call');
  assert.equal(h.wakes.list('ag_ava').length, 0);
});

test('next: a queued wake; now: steered into the running turn, or delivered with this chat next', async () => {
  const next = setup(() => ({ say: 'Merke ich mir.', relay: 'next' }));
  next.say('Nimm lieber Blau.');
  await settled();
  assert.equal(next.wakes.list('ag_ava').length, 1);
  assert.equal(next.urgent.length, 0);
  assert.deepEqual(next.steers, []);

  const now = setup(() => ({ say: 'Mache ich.', relay: 'now' }));
  now.steerable.value = true;
  now.say('Schick "es" ab.');
  await settled();
  assert.equal(now.steers.length, 1);
  assert.match(now.steers[0], /The person said: "Schick 'es' ab\."/);
  assert.match(now.steers[0], /My voice told them: "Mache ich\."/);
  assert.equal(now.wakes.list('ag_ava').length, 0);

  now.steerable.value = false;
  now.say('Und noch eins.');
  await settled();
  assert.equal(now.wakes.list('ag_ava').length, 1);
  assert.deepEqual(now.urgent, [{ agentId: 'ag_ava', conversationId: now.solo.id }]);
});

test('a failed, empty or invalid answer: the agent answers through the normal delivery', async () => {
  for (const answers of [() => { throw new Error('no route'); }, () => ({ say: '  ', relay: 'none' }), () => ({ say: 'Hi', relay: 'maybe' }), () => 'not json']) {
    const h = setup(answers);
    h.say('Hallo?');
    await settled();
    assert.equal(h.voiceLines().length, 0);
    assert.equal(h.wakes.list('ag_ava').length, 1, 'the agent is woken');
  }
  const text = setup(() => JSON.stringify({ say: 'Aus dem Text.', relay: 'none' }));
  text.say('Hallo?');
  await settled();
  assert.equal(text.voiceLines()[0].body, 'Aus dem Text.', 'a model without structured output');
});

test('lines said meanwhile are answered together, once', async () => {
  const gates: Array<() => void> = [];
  const h = setup(async (ask) => {
    await new Promise<void>((resolve) => { gates.push(resolve); ask.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    return { say: `Antwort ${gates.length}`, relay: 'none' };
  });
  h.say('Erstens');
  h.say('Zweitens');
  await settled();
  assert.equal(h.asks.length, 2);
  assert.equal(h.asks[0].signal?.aborted, true, 'the first ask is cancelled');
  assert.deepEqual(JSON.parse(h.asks[1].prompt).new, ['Erstens', 'Zweitens']);
  gates[1]();
  await settled();
  assert.equal(h.voiceLines().length, 1);
});

test('who it serves: a chat with an agent its voice speaks as, not with voice.talker false; shutdown hands open lines to the agent', async () => {
  const h = setup(() => new Promise(() => {}));
  assert.equal(h.talker.serves(h.solo.id), true);
  assert.equal(h.talker.serves(h.direct.id), true, 'a default 1:1 with more agents: as the agent of its pair');
  assert.equal(h.talker.serves(h.group.id), false, 'a group with several agents: the delivery picks who answers');
  assert.equal(h.talker.serves(h.chats.create({ agentIds: [], createdBy: HUMAN_ID }).id), false, 'no agent to speak as');
  const off = setup(() => ({}), { talker: false });
  assert.equal(off.talker.serves(off.solo.id), false, 'voice.talker false');
  h.say('Bist du da?');
  h.talker.stop();
  assert.equal(h.talker.serves(h.solo.id), false);
  assert.equal(h.wakes.list('ag_ava').length, 1);
  await settled();
  assert.equal(h.voiceLines().length, 0);
});

test('what the model is given: who it speaks as, the work status, the recent lines without the new one, secrets hidden', async () => {
  const h = setup(() => ({ say: 'Ok.', relay: 'none' }));
  h.chats.send({ conversationId: h.solo.id, body: 'Vorher', authorId: 'ag_ava', authorKind: 'agent', silent: true });
  h.running.push({ agentId: 'ag_ava', runId: 'run_1', conversationId: 'other', note: 'running tests', startedAt: 0 } as never);
  h.say('Das Passwort ist s3cret');
  await settled();
  const ask = h.asks[0];
  assert.match(ask.system, /live voice of Ava/);
  assert.match(ask.system, /profile language is de/);
  assert.match(ask.system, /by first name and in the familiar form \(German "du"/, 'B-078: the talker speaks like the realtime brief (voiceSelf)');
  const roleAt = ask.system.indexOf('My role as Ava');
  assert.ok(roleAt >= 0 && roleAt < ask.system.indexOf('familiar form'), 'right after the role line');
  assert.equal(ask.purpose, 'call talker');
  assert.ok(ask.schema);
  const input = JSON.parse(ask.prompt);
  assert.match(input.work, /^My work right now: busy in another chat \(running tests\)\.$/, 'a run without a row: this PC\'s activity');
  assert.deepEqual(input.lines, [{ from: 'me', text: 'Vorher' }]);
  assert.deepEqual(input.new, ['Das Passwort ist [hidden]']);
  assert.match(input.words, /Teydra/);
  assert.equal(parseDecision({ say: ' a  b ', relay: 'now', extra: 1 })?.say, 'a b');
  assert.match(talkerSystem(h.services as RuntimeServices, 'ag_ava', h.solo.id), /"none" for talk/);
  assert.match(JSON.stringify(talkerInput(h.services as RuntimeServices, 'ag_ava', h.solo.id, [])), /me \(live voice\)/);
});

test('in a default 1:1 with more agents the voice speaks as the agent of its pair; a line that names another member goes the normal way', async () => {
  const h = setup(() => ({ say: 'Klar.', relay: 'none' }));
  h.say('Wie weit bist du?', h.direct.id);
  await settled();
  assert.equal(h.asks.length, 1);
  assert.match(h.asks[0].system, /live voice of Ben/);
  assert.match(h.asks[0].system, /In this chat with me: Ava\. A line meant for one of them I relay with "next"/);
  assert.equal(h.chats.messages(h.direct.id, { limit: 10 }).find((m) => m.meta.call?.voice === 'talker')?.authorId, 'ag_ben');
  h.say('Was meinst du, @Ava?', h.direct.id);
  await settled();
  assert.equal(h.asks.length, 1, 'not asked');
  assert.deepEqual(h.wakeRows().map((wake) => wake.agent_id), ['ag_ava'], 'the named agent is woken');
});

test('the work line: who works and on which PC, from the rows that stream – also one synced from the agent\'s home PC', async () => {
  const h = setup(() => ({ say: 'Ok.', relay: 'none' }));
  const device = (id: string, name: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ id, name, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra });
  new DevicesRepo(h.db).upsert(device('dev_book', 'laptop', { self: true }));
  new DevicesRepo(h.db).upsert(device('dev_server', 'office-pc'));
  h.org.add(agent('ag_ava', 'Ava', { role: 'Assistant', deviceId: 'dev_server' })); // at home on the other PC
  h.chats.beginAgentMessage(h.solo.id, 'ag_ava', 'run_far', { live: { steps: [], more: 0, startedAt: 1, note: 'reading files' } });
  h.chats.beginAgentMessage(h.group.id, 'ag_ben', 'run_ben', { live: { steps: [], more: 0, startedAt: 2, note: 'searching' } });
  const work = (chat: string) => talkerInput(h.services as RuntimeServices, 'ag_ava', chat, []).work as string;
  assert.equal(work(h.solo.id), 'My work right now: busy in this chat (reading files) on office-pc.');
  assert.equal(work(h.group.id), 'My work right now: busy in another chat (reading files) on office-pc. At work in this chat: Ben in this chat (searching) on laptop.');
  // Nothing streams: at home on another PC, a run there without a chat does not show here; at home here, nothing runs.
  h.org.add(agent('ag_jonas', 'Jonas', { deviceId: 'dev_server' }));
  h.org.add(agent('ag_dan', 'Dan'));
  const idle = (agentId: string) => talkerInput(h.services as RuntimeServices, agentId, h.solo.id, []).work as string;
  assert.equal(idle('ag_jonas'), 'My work right now: no work of mine streams in a chat; my turns run on office-pc, and a run there without a chat does not show here.');
  assert.equal(idle('ag_dan'), 'My work right now: nothing is running.');
});

test('messages.send: a plain live line goes to the talker, stored quiet as a line of the device\'s call; a marked or dictated line goes the normal way', async (t) => {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_ben', 'Ben'));
  const services = f.services as RuntimeServices;
  Object.assign(services, { secrets: { redact: (text: string) => text } });
  createCalls(services, { run: async () => ({ text: '', structured: { say: 'Bin da.', relay: 'none' }, by: 'x:small' }) });
  t.after(() => stopCalls(services));
  const owner = new TestClient(f.server, OWNER);
  const solo = f.chats.create({ agentIds: ['ag_ava'], createdBy: 'human' });
  const live = { source: 'endpoint', live: true };
  const line = await owner.call<Message>('messages.send', { conversationId: solo.id, body: 'Hallo', speech: live });
  assert.equal(line.silent, true);
  assert.equal(line.meta.call?.participant, 'device:pc');
  assert.equal(line.meta.speech?.live, true);
  assert.equal(line.meta.speech?.call, undefined, 'the call is meta.call, not speech');
  const call = f.chats.messages(solo.id, { limit: 10 }).map((m) => callRecord(m)).find(Boolean);
  assert.equal(line.meta.call?.id, call?.id, 'a live line without a named call opens the device\'s call');
  await settled();
  assert.equal(f.wakeRows().length, 0);
  assert.ok(f.chats.messages(solo.id, { limit: 10 }).some((message) => message.body === 'Bin da.' && message.authorId === 'ag_ava' && !message.silent));

  const dictated = await owner.call<Message>('messages.send', { conversationId: solo.id, body: 'Diktiert', speech: { source: 'endpoint' } });
  assert.equal(dictated.silent, false);
  assert.equal(f.wakeRows().length, 1, 'a dictated line wakes as before');

  const group = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human', lead: 'ag_ben' });
  assert.equal((await owner.call<Message>('messages.send', { conversationId: group.id, body: 'Alle', speech: live })).silent, false, 'a group: the delivery picks who answers');
  const direct = f.chats.create({ agentIds: ['ag_ava', 'ag_ben'], createdBy: 'human', settings: { direct: true, directPair: ['ag_ben', 'human'] } });
  assert.equal((await owner.call<Message>('messages.send', { conversationId: direct.id, body: 'Hallo Ben', speech: live })).silent, true, 'a default 1:1 with more agents: its pair\'s voice answers');
  const marked = await owner.call<Message>('messages.send', { conversationId: solo.id, body: 'Wichtig', speech: { ...live, call: call?.id }, priority: 'important' });
  assert.equal(marked.silent, false);
  assert.equal(marked.meta.call?.id, call?.id, 'the call it names');
});
