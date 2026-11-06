// B-041 track A2: the morning briefing (runtime/day/briefing.ts, briefing-chats.ts) – done since last evening,
// prepared to-dos, handed-off work not started yet, today's planned blocks, what needs the person now and the
// chats that matter, stored per member and day with a 'day.briefing' event; counts without a model, at most 3
// helper sentences with one (never an "Only me" title or a message body in its prompt; it may only reorder the
// chats), nothing from the model with "AI helps" off; and the pure chat ranking.
// Owns: checks of Briefings / rankChats / reorder / countLines only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { ConversationSummary } from '../../../src/shared/model/chat.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';
import { Briefings, countLines } from '../../../src/runtime/day/briefing.ts';
import { rankChats, reorder } from '../../../src/runtime/day/briefing-chats.ts';
import { dayGroups } from '../../../src/ui/day/day-groups.ts';
import { BERLIN, agent, dayFixture } from './fixture.ts';

const wall = (date: string, clock: string) => zonedTime(date, Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)), BERLIN);
const TUE = '2026-10-27';

/** Monday evening: a dictation, agent work done and not started overnight, a prepared to-do, a waiting ask and unread messages. */
async function night(helper: StructuredRunner | false = false, aiHelps = true) {
  const f = dayFixture({ now: wall('2026-10-26', '21:00'), helper, day: { aiHelps } });
  f.org.add(agent('ag_mara', 'Mara', { createdAt: 1 }));
  f.org.add(agent('ag_tom', 'Tom', { createdAt: 2 }));
  const mara = f.s.chats.create({ title: 'Taxes', agentIds: ['ag_mara'], humans: true, createdBy: HUMAN_ID }).id;
  const tom = f.s.chats.create({ title: 'Website', agentIds: ['ag_tom'], humans: true, createdBy: HUMAN_ID }).id;
  const work = (conversationId: string, assigneeId: string, title: string) => f.s.tasks.create({ conversationId, title, assigneeKind: 'agent', assigneeId, createdBy: HUMAN_ID });
  f.s.tasks.setStatus(work(mara, 'ag_mara', 'Sort the tax papers').id, 'done', HUMAN_ID);
  work(tom, 'ag_tom', 'Fix the header');
  const [police, diary] = (await f.day.add({ text: 'Zettel zur Polizei bringen' }, HUMAN_ID)).tasks.concat((await f.day.add({ text: 'Tagebuch schreiben', private: true }, HUMAN_ID)).tasks);
  f.s.tasks.update(police.id, { prep: { byAgentId: 'ag_mara', note: 'Opens 08:00–12:00', at: f.clock.now() } }, 'ag_mara');
  f.s.tasks.create({ conversationId: mara, title: 'Which tax year?', assigneeKind: 'human', createdBy: 'ag_mara', humanReason: 'review' });
  f.s.chats.send({ conversationId: tom, body: 'SECRET-BODY header draft ready', authorId: 'ag_tom', authorKind: 'agent' });
  f.clock.set(wall(TUE, '06:00'));
  f.calendar.block(police.id, wall(TUE, '08:00'), wall(TUE, '08:30'), 'planner');
  f.calendar.block(diary.id, wall(TUE, '09:00'), wall(TUE, '09:30'), 'planner');
  return { f, mara, tom, police, diary };
}

test('without a model: counts, ids and the ranked chats, stored and announced', async () => {
  const { f, mara, tom, police } = await night();
  const briefing = await f.day.briefings.build(HUMAN_ID, TUE);
  assert.equal(briefing.doneTaskIds.length, 1);
  assert.deepEqual(briefing.preparedTaskIds, [police.id]);
  assert.equal(briefing.waitingToStart, 1, 'Tom never started: the PC slept');
  assert.equal(briefing.planned, 2);
  assert.equal(briefing.needsYou, 1, "only Mara's question waits on the person – their own planned to-dos do not");
  assert.deepEqual(briefing.chats, [{ conversationId: mara, reason: 'Waits for your answer' }, { conversationId: tom, reason: '1 unread' }]);
  assert.deepEqual(briefing.lines, ['Today: 2 to-dos planned, 1 needs you.'], 'the night counts are the ids and waitingToStart (shown by Home)');
  assert.deepEqual(f.day.briefing(HUMAN_ID, TUE), briefing);
  assert.deepEqual(f.of('day.briefing'), [{ ownerId: HUMAN_ID, date: TUE }]);
  assert.equal(f.day.briefing(HUMAN_ID, '2026-10-28'), null);
});

test('the briefing\'s "n need you" is My day\'s Needs-you group (one rule, with the block in progress)', async () => {
  const { f, police } = await night();
  const groupsAt = () => {
    const slots = new Map(f.calendar.events.filter((event) => event.taskId).map((event) => [event.taskId!, event]));
    return dayGroups(f.s.tasks.todos(1000), { now: f.clock.now(), dayStart: wall(TUE, '00:00'), dayEnd: wall('2026-10-28', '00:00'), isToday: true, slots });
  };
  const morning = await f.day.briefings.build(HUMAN_ID, TUE);
  assert.equal(morning.needsYou, groupsAt().needsYou.length);
  f.clock.set(wall(TUE, '08:10'));
  const during = await f.day.briefings.build(HUMAN_ID, TUE);
  assert.ok(groupsAt().needsYou.some((task) => task.id === police.id), 'the running block is in Needs you');
  assert.equal(during.needsYou, groupsAt().needsYou.length);
  assert.equal(during.needsYou, 2);
});

test('with a helper: at most 3 sentences and its chat order; never a private title or a message body in the prompt', async () => {
  const prompts: string[] = [];
  const all: string[] = [];
  const helper = (async (input: { prompt: string; purpose: string }) => {
    all.push(input.prompt);
    if (input.purpose !== 'briefing') return { text: '', by: 'm' }; // the input's split: no usable answer, the rules stand
    prompts.push(input.prompt);
    return { text: '', structured: { lines: ['  Mara sorted the tax papers. ', 'Tom has not started.', 'Bring the paper to the police by noon.', 'A fourth line.'], chats: [2, 1] }, by: 'm' };
  }) as unknown as StructuredRunner;
  const { f, mara, tom } = await night(helper);
  const briefing = await f.day.briefings.build(HUMAN_ID, TUE);
  assert.deepEqual(briefing.lines, ['Mara sorted the tax papers.', 'Tom has not started.', 'Bring the paper to the police by noon.']);
  assert.deepEqual(briefing.chats.map((chat) => chat.conversationId), [tom, mara]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Sort the tax papers/);
  assert.ok(all.every((prompt) => !/Tagebuch/.test(prompt)), 'an "Only me" to-do never reaches a model');
  assert.doesNotMatch(prompts[0], /SECRET-BODY/, 'never a message body');
});

test('a helper that fails, and "AI helps" off: the count lines', async () => {
  const failing = (async () => { throw new Error('cold'); }) as unknown as StructuredRunner;
  const one = await night(failing);
  assert.match((await one.f.day.briefings.build(HUMAN_ID, TUE)).lines[0], /^Today: /);
  let asked = 0;
  const counting = (async () => { asked++; return { text: '{}', by: 'm' }; }) as unknown as StructuredRunner;
  const off = await night(counting, false);
  await off.f.day.briefings.build(HUMAN_ID, TUE);
  assert.equal(asked, 0);
  const empty = new Briefings(dayFixture().s);
  assert.equal(empty.get(HUMAN_ID, TUE), null);
});

test('rankChats: waits > important unread > unread > working > the person wrote today; app, hidden, archived and people\'s own chats never', () => {
  const now = Date.parse('2026-10-27T06:00:00Z');
  const chat = (id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
    id, title: id, titleNamed: true, createdBy: HUMAN_ID, pinned: false, settings: {}, lastSeq: 1, createdAt: 0, updatedAt: 0, lastMessageAt: 0,
    members: [{ conversationId: id, memberId: HUMAN_ID, kind: 'human', joinedAt: 0, readSeq: 0 } as never], unread: 0, working: [], openTasks: 0, ...extra,
  });
  const ranked = rankChats([
    chat('quiet'), chat('wrote', { lastPreview: { authorId: HUMAN_ID, text: 'x', at: now - 60_000 } }), chat('busy', { working: ['ag_tom'] }),
    chat('unread', { unread: 3, lastMessageAt: 5 }), chat('unreadOlder', { unread: 9, lastMessageAt: 1 }), chat('waits'),
    chat('todo', { settings: { system: 'todo' }, unread: 2 }), chat('hidden', { settings: { hiddenFromList: true }, unread: 2 }), chat('old', { archivedAt: 1, unread: 2 }),
  ], { waits: new Map([['waits', 2]]), nameOf: (id) => (id === 'ag_tom' ? 'Tom' : id), now });
  assert.deepEqual(ranked, [
    { conversationId: 'waits', reason: '2 things wait for you' }, { conversationId: 'unread', reason: '3 unread' },
    { conversationId: 'unreadOlder', reason: '9 unread' }, { conversationId: 'busy', reason: 'Tom is working' },
    { conversationId: 'wrote', reason: 'You wrote here today' },
  ]);
  assert.deepEqual(reorder(ranked, [3, 3, 99, 'x', 1]).map((entry) => entry.conversationId), ['unreadOlder', 'waits', 'unread', 'busy', 'wrote']);
  // Important unread (ConversationSummary.importantUnread) ranks after a waiting answer and before plain unread.
  const withImportant = rankChats([chat('unread', { unread: 9, lastMessageAt: 9 }), chat('alarm', { unread: 2, importantUnread: 1, lastMessageAt: 1 }), chat('waits')],
    { waits: new Map([['waits', 1]]), nameOf: (id) => id, now });
  assert.deepEqual(withImportant, [
    { conversationId: 'waits', reason: 'Waits for your answer' }, { conversationId: 'alarm', reason: '1 important unread' }, { conversationId: 'unread', reason: '9 unread' },
  ]);
  assert.deepEqual(reorder(ranked, undefined), ranked);
});

test('countLines: nothing to say is no line; never the night counts (Home shows them)', () => {
  assert.deepEqual(countLines({ planned: [], needsYou: 0 }), []);
  assert.deepEqual(countLines({ planned: [{ at: 0, title: '' }], needsYou: 1 }), ['Today: 1 to-do planned, 1 needs you.']);
  assert.deepEqual(countLines({ planned: [], needsYou: 2 }), ['Today: 2 need you.']);
});
