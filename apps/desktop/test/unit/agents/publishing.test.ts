// B-047 D4 publishing (agents/publishing.ts, turn-finish.ts, turn.ts, turn-prepare.ts, ChatService):
// the final-text tags and their order, the defaults (awaited → posted + notifies; agent-to-agent →
// quiet; background → run journal only), the awaited safety net for [[internal]], a [[silent]] closing
// note against a tag alone that leaves no trace (B-050 round 3), the placeholder
// only where publishing is the default, the answer moved below what its run posted (also a failed
// one), meta.fromRun on the run's process rows (an approval to-do, a task an agent creates), the
// 'Answer' run item (split within the journal's limits), the turn context's publishing line and
// the recap of answers kept in the run log for a session that cannot know them (B-054: also a chat-free run's line,
// the awaited-outcome line, and the recap of the same source's earlier runs).
// Owns: these assertions only. Never: real engines, accounts, timers or sleeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { buildTurn, planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { ACTED_LINE, ANSWER_MAX_PARTS, ANSWER_PART_CHARS, journalAnswer, NO_CHAT_LINE, parseVisibility, publishLine, resolveVisibility, splitAnswer } from '../../../src/runtime/agents/publishing.ts';
import { ANSWERS_LIMITS, ANSWERS_TITLE, answersRecap } from '../../../src/runtime/context/recent-actions.ts';
import { isPersonMention } from '../../../src/runtime/chat/mentions.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { WakeReason } from '../../../src/shared/model/runs.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { agent } from '../chat/harness.ts';
import { setup } from './fixture.ts';

function rig() {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  Object.assign(h.services, { runs, router: { route: async () => h.route } });
  Object.assign(h.services.accounts, { list: () => [], markUnavailable: () => false, markLimited: () => {} });
  Object.assign(h.services.catalog, { list: () => [] });
  let count = 0;
  const run = (reason: WakeReason = 'message', taskId?: string) => {
    h.wakes.done(h.wakes.claim(h.tom.id, Number.MAX_SAFE_INTEGER).map((wake) => wake.id));
    return new TurnExecutor(() => h.services).execute(h.request({ runId: `run_${++count}`, reason, ...(taskId ? { taskId } : {}) }));
  };
  const ask = (body: string) => h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, body });
  const tomPosts = () => h.chats.messages(h.chat.id).filter((message) => message.authorId === h.tom.id && message.kind === 'text');
  const answers = (runId: string) => runs.items(runId).filter((item) => item.kind === 'note' && item.name === 'Answer').map((item) => item.data);
  const unread = () => h.chats.summary(h.chat.id).unread;
  const replies = () => h.notified.filter((item) => item.kind === 'reply' || item.kind === 'important').length;
  const placeholders: string[] = [];
  h.bus.on('message.created', (message: Message) => { if (message.authorId === h.tom.id && message.state === 'streaming') placeholders.push(message.runId ?? ''); });
  const task = () => {
    const created = h.tasks.create({ conversationId: h.chat.id, title: 'Cut the intro', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: HUMAN_ID });
    h.tasks.claim(created.id, h.tom.id);
    return created;
  };
  return { ...h, journal: runs, run, ask, tomPosts, answers, unread, replies, placeholders, task };
}

test('parseVisibility strips every tag; the most private one wins; [[quiet]] is [[silent]]', () => {
  assert.deepEqual(parseVisibility('Plain answer.'), { body: 'Plain answer.' });
  assert.deepEqual(parseVisibility('Noted. [[silent]]'), { body: 'Noted.', tag: 'silent' });
  assert.deepEqual(parseVisibility('[[QUIET]] Noted.'), { body: 'Noted.', tag: 'silent' });
  assert.deepEqual(parseVisibility('Heads up [[notify]]'), { body: 'Heads up', tag: 'notify' });
  assert.deepEqual(parseVisibility('[[notify]] Both [[internal]] here [[silent]]'), { body: 'Both  here', tag: 'internal' });
  assert.deepEqual(parseVisibility('[[silent]]'), { body: '', tag: 'silent' }, 'a tag alone has no words – turn-finish posts nothing');
});

test('a mention of a person – the owner, a person of the organisation, a bridged contact – is never an external agent\'s or a colleague\'s', () => {
  for (const id of [HUMAN_ID, 'per_0123456789ab', 'ext:tg:42:Sam (Telegram)']) assert.equal(isPersonMention(id), true, id);
  for (const id of ['ext:api:0123456789:Research-Bot', 'ag_tom', SYSTEM_ID]) assert.equal(isPersonMention(id), false, id);
});

test('resolveVisibility: awaited or must-see notify, agent-to-agent or addressed is quiet, background internal; tags win; calls always post', () => {
  const base = { awaited: false, mustSee: false, reason: 'retry' as WakeReason };
  assert.equal(resolveVisibility({ ...base }), 'internal');
  assert.equal(resolveVisibility({ ...base, reason: 'message' }), 'silent');
  assert.equal(resolveVisibility({ ...base, addressed: true }), 'silent', 'it @mentions a colleague');
  assert.equal(resolveVisibility({ ...base, mustSee: true }), 'notify');
  assert.equal(resolveVisibility({ ...base, awaited: true }), 'notify');
  assert.equal(resolveVisibility({ ...base, tag: 'notify' }), 'notify');
  assert.equal(resolveVisibility({ ...base, awaited: true, tag: 'silent' }), 'silent');
  assert.equal(resolveVisibility({ ...base, awaited: true, tag: 'internal', postedElse: () => false }), 'silent', 'the safety net');
  assert.equal(resolveVisibility({ ...base, awaited: true, tag: 'internal', postedElse: () => true }), 'internal');
  assert.equal(resolveVisibility({ ...base, tag: 'internal' }), 'internal');
  assert.equal(resolveVisibility({ ...base, call: true, tag: 'internal' }), 'notify', 'call turns ignore tags');
});

test('an awaited untagged answer streams into its placeholder, is posted and notifies; the run journals it as Answer', async () => {
  const h = rig();
  h.ask('How long is the intro?');
  const replies = h.replies();
  h.state.script = async () => ({ text: 'Twelve seconds.', stop: 'done' });
  const outcome = await h.run();
  const posted = h.chats.message(outcome.messageId!)!;
  assert.deepEqual([posted.body, posted.silent, posted.runId], ['Twelve seconds.', false, 'run_1']);
  assert.deepEqual(h.placeholders, ['run_1'], 'publishing is the default: a placeholder streamed');
  assert.equal(h.replies(), replies + 1, 'the person is notified');
  assert.deepEqual(h.answers('run_1'), [{ answer: true, text: 'Twelve seconds.', visibility: 'notify', messageId: posted.id }]);
  assert.equal(h.journal.get('run_1')?.summary, 'Twelve seconds.');
});

test('a spoken line stored quiet for the call talker waits for its answer, also on the turn of a task that waited on the person: posted loud, so the device reads it', async () => {
  const h = rig();
  const work = h.task();
  h.chats.send({ conversationId: h.chat.id, authorId: HUMAN_ID, authorKind: 'human', body: 'Yes, the short intro.', silent: true, meta: { call: { id: 'rts_1', participant: 'device:pc', name: 'Office PC' } } });
  h.state.script = async () => ({ text: 'Short intro it is.', stop: 'done' });
  await h.run('message', work.id);
  assert.deepEqual([h.tomPosts().at(-1)?.body, h.tomPosts().at(-1)?.silent], ['Short intro it is.', false]);
});

test('a background untagged answer stays in the run journal: only a silent live row that goes, no message, no unread; the summary has no tag', async () => {
  const h = rig();
  const work = h.task();
  const unread = h.unread();
  const removed: string[] = [];
  h.bus.on('message.removed', ({ id }) => removed.push(id));
  const silent: boolean[] = [];
  h.bus.on('message.created', (message: Message) => { if (message.state === 'streaming') silent.push(message.silent); });
  h.state.script = async () => ({ text: 'Export settings checked, rendering continues.', stop: 'done' });
  await h.run('retry', work.id);
  assert.deepEqual([h.placeholders, silent, removed.length], [['run_1'], [true], 1], 'B-075: its work showed in a silent row, removed at the end');
  assert.equal(h.tomPosts().length, 0);
  assert.equal(h.unread(), unread);
  assert.deepEqual(h.answers('run_1'), [{ answer: true, text: 'Export settings checked, rendering continues.', visibility: 'internal' }]);

  h.state.script = async () => ({ text: 'Still rendering. [[silent]]', stop: 'done' });
  await h.run('schedule', work.id);
  const quiet = h.tomPosts().at(-1)!;
  assert.deepEqual([quiet.body, quiet.silent, quiet.runId], ['Still rendering.', true, 'run_2'], '[[silent]] posts it at the end, quietly');
  assert.equal(h.unread(), unread, 'no unread');
  assert.equal(h.journal.get('run_2')?.summary, 'Still rendering.', 'the summary is the stripped text');
});

test('[[internal]] on an awaited turn without another post becomes [[silent]]; after a post of the run it stays in the run log', async () => {
  const h = rig();
  h.ask('Did the export finish?');
  h.state.script = async () => ({ text: 'Yes, the file is in exports. [[internal]]', stop: 'done' });
  await h.run();
  const safety = h.tomPosts().at(-1)!;
  assert.deepEqual([safety.body, safety.silent], ['Yes, the file is in exports.', true], 'the person who asked gets a visible answer');
  assert.equal(h.answers('run_1')[0].visibility, 'silent');

  h.ask('Send me the list of cuts.');
  h.state.script = async (input) => {
    h.chats.send({ conversationId: h.chat.id, authorId: h.tom.id, body: 'Cuts: intro, outro.', runId: input.runId, meta: { sentDuringRun: true } });
    return { text: 'Posted the list. [[internal]]', stop: 'done' };
  };
  const outcome = await h.run();
  assert.equal(outcome.messageId, undefined, 'the placeholder went');
  assert.deepEqual(h.tomPosts().at(-1)!.body, 'Cuts: intro, outro.');
  assert.deepEqual(h.answers('run_2'), [{ answer: true, text: 'Posted the list.', visibility: 'internal' }]);
});

test('[[silent]] on an awaited turn: visible, no unread, no notification (B-059 #42: in a group – a plain answer in the person\'s 1:1 notifies, b059-finish.test.ts)', async () => {
  const h = rig();
  const mara = h.org.add(agent('ag_mara', 'Mara'));
  h.chats.setMembers(h.chat.id, { add: [mara.id] }, HUMAN_ID);
  h.ask('Thanks!');
  const [unread, replies] = [h.unread(), h.replies()];
  h.state.script = async () => ({ text: 'You are welcome. [[silent]]', stop: 'done' });
  await h.run();
  assert.deepEqual([h.tomPosts().at(-1)!.body, h.tomPosts().at(-1)!.silent], ['You are welcome.', true]);
  assert.equal(h.unread(), unread);
  assert.equal(h.replies(), replies);
});

test('B-050 round 3: a [[silent]] closing note stays in the chat history unnoticed; a tag alone leaves no trace', async () => {
  const h = rig();
  h.ask('Write notes/launch-checklist.md, no need to report back.');
  const [unread, replies] = [h.unread(), h.replies()];
  h.state.script = async (input) => { // B-059 #42: the file was written – a closing note after work, not a plain answer
    input.onEvent({ type: 'tool_start', callId: 'w1', name: 'Write', args: { file_path: 'notes/launch-checklist.md' }, own: true });
    input.onEvent({ type: 'tool_end', callId: 'w1', ok: true, summary: 'written' });
    return { text: 'Checklist written: notes/launch-checklist.md (12 points). [[silent]]', stop: 'done' };
  };
  const outcome = await h.run();
  const note = h.chats.message(outcome.messageId!)!;
  assert.deepEqual([note.body, note.silent], ['Checklist written: notes/launch-checklist.md (12 points).', true]);
  assert.deepEqual([h.unread(), h.replies()], [unread, replies], 'no unread, no notification');
  assert.deepEqual(h.answers('run_1'), [{ answer: true, text: note.body, visibility: 'silent', messageId: note.id }]);

  h.ask('And the press list too, quietly.');
  const posts = h.tomPosts().length;
  h.state.script = async () => ({ text: '[[silent]]', stop: 'done' });
  assert.equal((await h.run()).messageId, undefined, 'the placeholder went');
  assert.equal(h.tomPosts().length, posts, 'nothing posted');
  assert.deepEqual(h.answers('run_2'), [], 'nothing journaled – what the rules now steer away from');
});

test('an agent-to-agent message turn posts quietly: the colleague reads it, the person is not notified', async () => {
  const h = rig();
  const mara = h.org.add(agent('ag_mara', 'Mara'));
  h.chats.setMembers(h.chat.id, { add: [mara.id] }, HUMAN_ID);
  h.chats.send({ conversationId: h.chat.id, authorId: mara.id, body: '@Tom is the colour grade final?' });
  const [unread, replies] = [h.unread(), h.replies()];
  h.state.script = async () => ({ text: 'Yes, version 3 is final.', stop: 'done' });
  await h.run();
  const reply = h.tomPosts().at(-1)!;
  assert.deepEqual([reply.body, reply.silent], ['Yes, version 3 is final.', true]);
  assert.deepEqual(h.placeholders, ['run_1'], 'publishing (quietly) is the default: it streams');
  assert.equal(h.unread(), unread);
  assert.equal(h.replies(), replies);
});

test('an approval created during the run ends above the final answer: the answer moves to the end, the card carries fromRun', async () => {
  const h = rig();
  h.ask('Run the tests, please.');
  let card: Message | undefined;
  h.state.script = async (input) => {
    const todo = h.tasks.create({ conversationId: h.chat.id, title: 'Run: npm test', assigneeKind: 'human', humanReason: 'approval', createdBy: SYSTEM_ID }, { fromRun: input.runId });
    card = h.chats.message(todo.messageId!);
    h.chats.status(h.chat.id, { type: 'note', text: 'Approved: npm test' });
    return { text: 'All 42 tests pass.', stop: 'done' };
  };
  const outcome = await h.run();
  const answer = h.chats.message(outcome.messageId!)!;
  assert.equal(card?.meta.fromRun, 'run_1');
  assert.ok(answer.seq > card!.seq, 'the answer is below its approval');
  assert.equal(h.chats.messages(h.chat.id).at(-1)!.id, answer.id, 'it is the chat\'s last message');
  assert.equal(h.chats.search('tests pass')[0]?.message.id, answer.id, 'the search index follows the move');

  // A failed answer moves too.
  h.ask('And the lint?');
  h.state.script = async (input) => {
    input.onEvent({ type: 'text', delta: 'Lint is running' });
    h.chats.status(h.chat.id, { type: 'note', text: 'Switched to a fresh session' }, { fromRun: input.runId });
    return { text: '', stop: 'error', error: { code: 'internal', message: 'The model could not complete this turn.' } };
  };
  const failed = await h.run();
  const last = h.chats.messages(h.chat.id).at(-1)!;
  assert.deepEqual([last.id, last.state, last.body], [failed.messageId, 'failed', 'Lint is running']);
});

test('the run status lines of a turn carry meta.fromRun', async () => {
  const h = rig();
  h.journal.start({ id: 'run_0', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  h.journal.finish('run_0', { status: 'done', model: 'codex:gpt-6.1-sol', effort: 'low' }); // the chat's last turn ran on another model
  h.ask('Hello');
  h.state.script = async () => ({ text: 'Hi.', stop: 'done' });
  await h.run();
  const switched = h.chats.messages(h.chat.id).filter((message) => message.kind === 'status' && message.meta.status?.type === 'model_switched');
  assert.equal(switched.length, 1, 'the switch from the last turn\'s model is announced');
  assert.equal(switched[0].meta.fromRun, 'run_1');
});

test('the Answer run item is redacted and split within the journal limits', () => {
  assert.deepEqual(splitAnswer('short'), ['short']);
  const nine = splitAnswer('a'.repeat(9000));
  assert.deepEqual(nine.map((part) => part.length), [4000, 4000, 1000]);
  const huge = splitAnswer('b'.repeat(ANSWER_PART_CHARS * ANSWER_MAX_PARTS + 123));
  assert.equal(huge.length, ANSWER_MAX_PARTS);
  assert.ok(huge.every((part) => part.length <= ANSWER_PART_CHARS));
  assert.match(huge.at(-1)!, /… \[123 more chars\]$/);

  const items: Array<{ name?: string; data: Record<string, unknown> }> = [];
  journalAnswer({ runs: { item: (_runId: string, item: { name?: string; data: Record<string, unknown> }) => { items.push(item); } }, secrets: { redact: (text: string) => text.replace('sk-secret', '[redacted]') }, log: console } as never,
    'run_1', `key sk-secret ${'c'.repeat(5000)}`, 'internal');
  assert.deepEqual(items.map((item) => [item.name, item.data.part, item.data.parts, item.data.visibility]), [['Answer', 1, 2, 'internal'], ['Answer', 2, 2, 'internal']]);
  assert.match(String(items[0].data.text), /^key \[redacted\] c/);
});

test('the turn context says where the final text goes – never in the stable prompt', async () => {
  const h = rig();
  h.ask('Where is the file?');
  const awaited = (await planTurn(h.services, h.request()))!;
  const loud = await buildTurn(h.services, awaited, h.request(), h.route, []);
  assert.match(loud.prompt.volatile, /^volatile\n\nMy final text: posted here and notifies the person\. I end it with \[\[silent\]\]/m);
  assert.match(loud.prompt.volatile, /\[\[silent\]\] to post it without a notification \((a closing note nobody waits on, not my answer to what they wrote)\)/, 'round 3: the quiet closing note (B-059 #42 wording, B-075 first person)');
  assert.ok(!loud.prompt.stable.includes('My final text'));
  assert.ok(!(loud.input[0] as { text: string }).text.includes('My final text'), 'not in the chat input either');

  h.chats.markRead(h.chat.id, h.tom.id, h.chats.messages(h.chat.id).at(-1)!.seq);
  const work = h.task();
  const background = (await planTurn(h.services, h.request({ reason: 'retry', taskId: work.id })))!;
  assert.equal(background.publish, 'internal');
  const quiet = await buildTurn(h.services, background, h.request({ reason: 'retry', taskId: work.id }), h.route, []);
  assert.match(quiet.prompt.volatile, /My final text stays in my run log unless I tag it: \[\[silent\]\] posts it here quietly, \[\[notify\]\] posts it and notifies the person\./);
  assert.equal(publishLine({ visibility: 'notify', call: true, inChat: true, owner: 'Gerd' }), 'My final text is spoken in the call and posted here.');
  assert.equal(publishLine({ visibility: 'notify', call: false, inChat: false, owner: 'Gerd' }), NO_CHAT_LINE);
});

test('B-054: a run in no chat names the ways out; an awaited one adds the outcome line; earlier runs of its source are recalled', async () => {
  const h = rig();
  assert.equal(NO_CHAT_LINE, 'This run posts in no chat: my final text stays with this run (shown on my page). Work for later or for a colleague: tasks.create. '
    + 'Something only the person can do or decide: human.ask. To tell someone: chat.send {to}. Information only: nothing more. Ask blocks in this final text are shown nowhere.');
  assert.equal(publishLine({ visibility: 'internal', call: false, inChat: false, owner: 'Gerd', awaited: true }), `${NO_CHAT_LINE} ${ACTED_LINE}`);
  assert.match(ACTED_LINE, /^The person acted on this run – when the outcome matters to them, I tell them with chat\.send \{to:"human"\}\.$/);

  const origin = { source: 'app:box', label: 'New mail in me@example.test' };
  // An earlier mail run kept its final text internal: the next mail run (a new session) is told it.
  h.services.runs.start({ id: 'run_mail_0', agentId: h.tom.id, trigger: 'event', origin });
  journalAnswer(h.services, 'run_mail_0', 'Answered Maria, filed the newsletter.', 'internal');
  h.services.runs.finish('run_mail_0', { status: 'done' });
  h.services.runs.start({ id: 'run_news_0', agentId: h.tom.id, trigger: 'task', origin: { source: 'news', label: 'Task news' } });
  journalAnswer(h.services, 'run_news_0', 'Read the task news.', 'internal');
  h.services.runs.finish('run_news_0', { status: 'done' });
  assert.deepEqual(h.services.runs.get('run_mail_0')?.origin, origin, 'the run row keeps its origin through the finish');

  const request = h.request({ runId: 'run_mail_1', conversationId: undefined, reason: 'event', origin, notes: [{ text: 'New mail in me@example.test: 1 new message.', at: 1 }] });
  const mail = (await planTurn(h.services, request))!;
  assert.equal(mail.publish, 'internal');
  const turn = await buildTurn(h.services, mail, request, h.route, []);
  assert.ok(turn.prompt.volatile.includes(NO_CHAT_LINE));
  assert.ok(!turn.prompt.volatile.includes(ACTED_LINE), 'nobody acted on a mail run');
  assert.match(turn.prompt.volatile, /Answered Maria, filed the newsletter\./, 'the earlier mail run is recalled');
  assert.doesNotMatch(turn.prompt.volatile, /Read the task news/, 'another source is not');

  const decided = h.request({ runId: 'run_mail_2', conversationId: undefined, reason: 'approval', origin, notes: [{ text: '[approval ap_1] Send the reply\nApproved.', at: 2 }] });
  const awaited = (await planTurn(h.services, decided))!;
  assert.ok((await buildTurn(h.services, awaited, decided, h.route, [])).prompt.volatile.includes(`${NO_CHAT_LINE} ${ACTED_LINE}`));
});

test('the answers recap keeps three long internal answers within its bound, newest last', () => {
  const runs = [3, 2, 1].map((n) => ({ id: `run_${n}`, agentId: 'ag_tom', conversationId: 'cnv_1', status: 'done' })); // newest first
  const fake = {
    runs: { list: () => runs, items: (id: string) => [{ kind: 'note', name: 'Answer', createdAt: Date.UTC(2026, 9, 28, 14, Number(id.slice(4))), data: { answer: true, visibility: 'internal', text: `${id} ${'x'.repeat(2000)}` } }] },
    secrets: { redact: (text: string) => text },
  } as never;
  const recap = answersRecap(fake, { agentId: 'ag_tom', conversationId: 'cnv_1' }, 'run_now', 'UTC')!;
  assert.ok(recap.length <= ANSWERS_LIMITS.chars, String(recap.length));
  assert.deepEqual(recap.split('\n').map((line) => line.slice(0, 22)), [ANSWERS_TITLE.slice(0, 22), '- 28 Oct, 14:01: run_1', '- 28 Oct, 14:02: run_2', '- 28 Oct, 14:03: run_3']);
});

test('a background turn on a blocked task is planned as posted: its line and placeholder match what the finish does (regression)', async () => {
  const h = rig();
  const work = h.task();
  h.tasks.setStatus(work.id, 'blocked', h.tom.id, 'The render farm is down');
  h.chats.markRead(h.chat.id, h.tom.id, h.chats.messages(h.chat.id).at(-1)!.seq);
  const plan = (await planTurn(h.services, h.request({ reason: 'schedule', taskId: work.id })))!;
  assert.equal(plan.publish, 'notify', 'a blocked task is must-see before the turn as after it');
  const turn = await buildTurn(h.services, plan, h.request({ reason: 'schedule', taskId: work.id }), h.route, []);
  assert.match(turn.prompt.volatile, /My final text: posted here and notifies/);
  h.state.script = async () => ({ text: 'Still blocked: the farm is down.', stop: 'done' });
  await h.run('schedule', work.id);
  assert.deepEqual([h.tomPosts().at(-1)?.body, h.tomPosts().at(-1)?.silent], ['Still blocked: the farm is down.', false]);
  assert.deepEqual(h.placeholders, ['run_1'], 'it streamed into a placeholder');
});

test('a new session or a stateless engine is told the latest answers that stayed in the run log', async () => {
  const h = rig();
  const work = h.task();
  for (const text of ['First check: 3 frames drop.', 'Second check: the codec is fine.']) {
    h.state.script = async () => ({ text, stop: 'done' });
    await h.run('retry', work.id);
  }
  const plan = (await planTurn(h.services, h.request({ runId: 'run_next', reason: 'retry', taskId: work.id })))!;
  const turn = await buildTurn(h.services, plan, h.request({ runId: 'run_next', reason: 'retry', taskId: work.id }), h.route, []);
  const volatile = turn.prompt.volatile;
  assert.ok(volatile.includes(ANSWERS_TITLE), 'the stateless engine gets the recap');
  assert.ok(volatile.indexOf('First check: 3 frames drop.') < volatile.indexOf('Second check: the codec is fine.'), 'oldest first');
  assert.ok(volatile.indexOf(ANSWERS_TITLE) < volatile.indexOf('My final text'), 'the publishing line comes last');
});
