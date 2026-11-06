// B-050 K4 – [[important]] (agents/publishing.ts, turn-finish.ts, chat/publish-message.ts): a flag beside
// the visibility tags – it posts, notifies and marks the answer important; a more private tag (silent,
// internal) wins and drops it; the publishing line names it briefly – round 3: for what the person would surely want
// a push for now (a blocker, a decisive result, big news), in chat.send and schedules.message too; B-072: a step others
// now see that the agent took on its own is one (live 03.11.2026: a public push went out as a silent closing note), in
// the publishing line and chat.send's level alike.
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { ON_YOUR_OWN, parseVisibility, publishLine } from '../../../src/runtime/agents/publishing.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import { scheduleTools } from '../../../src/runtime/tools/builtin/schedule.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { setup } from './fixture.ts';

test('parseVisibility: [[important]] means notify plus important; silent or internal win and drop it', () => {
  assert.deepEqual(parseVisibility('The build is broken. [[important]]'), { body: 'The build is broken.', tag: 'notify', important: true });
  assert.deepEqual(parseVisibility('[[IMPORTANT]] Now [[notify]]'), { body: 'Now', tag: 'notify', important: true });
  assert.deepEqual(parseVisibility('Later [[important]] [[silent]]'), { body: 'Later', tag: 'silent' });
  assert.deepEqual(parseVisibility('Log only [[important]][[internal]]'), { body: 'Log only', tag: 'internal' });
  assert.deepEqual(parseVisibility('Plain'), { body: 'Plain' }, 'no flag without the tag');
});

test('publishLine names [[important]] in each case, briefly', () => {
  for (const visibility of ['notify', 'silent', 'internal'] as const) {
    assert.match(publishLine({ visibility, call: false, inChat: true, owner: 'Gerd' }), /\[\[important\]\]/, visibility);
  }
  assert.doesNotMatch(publishLine({ visibility: 'notify', call: true, inChat: true, owner: 'Gerd' }), /important/, 'a call speaks it');
});

test('round 3, the owner\'s test for important: what the person would surely want a push for now – not only blockers; agents are still warned', () => {
  const notify = publishLine({ visibility: 'notify', call: false, inChat: true, owner: 'Gerd' });
  const alone = 'a step others now see, taken without the person – posted, sent, pushed, published, paid'; // B-075: no person named, one voice in both texts
  assert.ok(notify.includes(`[[important]] when they would surely want a push now (a blocker, a decisive result, big news, ${alone}).`), notify);
  assert.match(notify, /\[\[silent\]\] to post it without a notification \((a closing note nobody waits on, not my answer to what they wrote)\)/, 'the quiet closing note stays (B-059 #42 wording, B-075 first person)');
  const silent = publishLine({ visibility: 'silent', call: false, inChat: true, owner: 'Gerd' });
  assert.ok(silent.includes(`([[important]] when they would surely want a push now, as for ${alone})`), silent);
  const internal = publishLine({ visibility: 'internal', call: false, inChat: true, owner: 'Gerd' });
  assert.ok(internal.includes(`[[important]] also pushes it to them at once (what they would surely want now, as ${alone}).`), internal);
  const send = chatTools.find((tool) => tool.name === 'chat.send')!.description;
  assert.ok(send.includes(`"important" (a push: what the person would surely want to hear at once – a real blocker, a decisive result, big news, ${alone}; it also interrupts the agents it reaches: those I mention, else the only other agent or the lead)`), 'a run that reports through chat.send sees the example too');
  assert.equal(ON_YOUR_OWN, alone, 'one wording for both');
  assert.doesNotMatch(ON_YOUR_OWN, /\b(I|my|you|your)\b/i, 'the shared phrase fits the first-person line and the tool description alike');
  assert.doesNotMatch(send, /only for real blockers/);
  assert.match(scheduleTools.find((tool) => tool.name === 'schedules.message')!.description, /"important" \(a push: what the person would surely want to hear at once\)/);
});

function rig() {
  const h = setup();
  Object.assign(h.services, { runs: new Journal({ db: h.db, bus: h.bus, clock: h.clock }), router: { route: async () => h.route } });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  let count = 0;
  const run = () => {
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    return new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++count}`, reason: 'message' }));
  };
  return { ...h, run };
}

test('an answer tagged [[important]] is posted with priority important and notifies as important; [[silent]] drops it', async () => {
  const h = rig();
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'Is the server fine?' });
  h.state.script = async () => ({ text: 'No – it is down. [[important]]', stop: 'done' });
  const loud = await h.run();
  const posted = h.chats.message(loud.messageId!)!;
  assert.deepEqual([posted.body, posted.priority, posted.silent], ['No – it is down.', 'important', false]);
  assert.ok(h.notified.some((note) => note.kind === 'important' && note.conversationId === h.chat.id));
  assert.equal(h.chats.summary(h.chat.id).importantUnread, 1);

  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body: 'And the backup?' });
  h.state.script = async () => ({ text: 'Fine. [[important]] [[silent]]', stop: 'done' });
  const quiet = await h.run();
  const second = h.chats.message(quiet.messageId!)!;
  // B-059 #42: a plain answer in the person's 1:1 is never quiet – it notifies at normal level, [[important]] stays dropped.
  assert.deepEqual([second.body, second.priority, second.silent], ['Fine.', 'normal', false]);
});
