// My day › "Chats that matter" (src/ui/day/important-chats.ts): one live signal per chat
// – an agent waits on the person (an open to-do someone else raised there) > important unread >
// unread (not muted) > an agent working > the person wrote there in the last 24 h – newer activity
// first within a signal; the briefing's picks first while they still have a signal, with the live
// reason; at most 5 rows, beyond 3 only strong ones; app chats, agent-only rooms, archived chats and
// people's own chats never count.
// Owns: these assertions only. Never: the DOM, rpc or real timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, Member } from '../../../src/shared/model/chat.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../src/shared/ids.ts';
import { CHATS_MAX, importantChats } from '../../../src/ui/day/important-chats.ts';
import { peoplesOwnChat as ownedByPeople, rankable as listable, waitingByChat } from '../../../src/shared/model/chat-rank.ts';
import { rankChats } from '../../../src/runtime/day/briefing-chats.ts';
import { workingIds } from '../../../src/ui/chat/live-text.ts';

const peoplesOwnChat = (chat: ConversationSummary) => ownedByPeople(chat.members, chat.settings);
const M = 60_000;
const H = 60 * M;
const NOW = Date.UTC(2026, 9, 24, 9, 0, 0);
const MARA = 'ag_mara';
const TOM = 'ag_tom';
const ANNA = 'per_01jab3k9z7mx2c4q';
let seq = 0;

const member = (conversationId: string, memberId: string, patch: Partial<Member> = {}): Member => ({
  conversationId, memberId, kind: memberId.startsWith('ag_') ? 'agent' : 'human', role: memberId === HUMAN_ID ? 'owner' : 'member', readSeq: 0, joinedAt: 0, ...patch,
});

/** A chat of the person with Mara, quiet unless the patch says otherwise. */
function chat(patch: Partial<ConversationSummary> = {}, memberIds: string[] = [HUMAN_ID, MARA]): ConversationSummary {
  seq++;
  const id = patch.id ?? `ch_${seq}`;
  return {
    id, title: `Chat ${seq}`, titleNamed: true, createdBy: HUMAN_ID, pinned: false, settings: {}, lastSeq: 10, createdAt: NOW - 30 * 24 * H,
    updatedAt: NOW - 5 * H, lastMessageAt: NOW - 5 * H, members: memberIds.map((memberId) => member(id, memberId)), unread: 0, working: [], openTasks: 0,
    ...patch,
  };
}

/** An open to-do of the person, raised by Mara in `conversationId`. */
function todo(conversationId: string, patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: `task_${seq}`, conversationId, title: `Ask ${seq}`, notes: '', status: 'open', assigneeKind: 'human', createdBy: MARA, priority: 0,
    dependsOn: [], ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - seq * M, updatedAt: NOW, steps: [], progress: { done: 0, total: 0 },
    conversationTitle: 'Chat', running: false, ...patch,
  };
}

const NAMES: Record<string, string> = { [MARA]: 'Mara', [TOM]: 'Tom' };
const rank = (chats: ConversationSummary[], todos: TaskView[] = [], briefing?: Array<{ conversationId: string }>) =>
  importantChats(chats, { todos, briefing, now: NOW, nameOf: (id) => NAMES[id] ?? 'Agent' });
const ids = (rows: ReturnType<typeof rank>) => rows.map((row) => row.chat.id);

test('one live signal per chat, strongest first: waits > important > unread > working > recent; nothing happening: not listed', () => {
  const recent = chat({ lastPreview: { authorId: HUMAN_ID, text: 'Thanks', at: NOW - 2 * H } });
  const working = chat({ working: [MARA] });
  const unread = chat({ unread: 2, lastPreview: { authorId: MARA, text: 'Done', at: NOW - H } });
  const important = chat({ importantUnread: 1, unread: 1 } as Partial<ConversationSummary>);
  const waits = chat();
  const quiet = chat();
  const strong = rank([recent, working, unread, important, waits, quiet], [todo(waits.id)]);
  assert.deepEqual(ids(strong), [waits.id, important.id, unread.id], 'three strong ones fill the rows (the weak ones only fill up to 3)');
  assert.deepEqual(strong.map((row) => row.signal), ['waits', 'important', 'unread']);
  const all = rank([recent, working, quiet, unread]);
  assert.deepEqual(all.map((row) => row.signal), ['unread', 'working', 'recent']);
});

test('reasons: the waiting to-do (the oldest of several), the working agent; unread and recent show the last message (no reason)', () => {
  const one = chat();
  const many = chat();
  const busy = chat({ working: [MARA, HUMAN_ID] });
  const team = chat({ working: [TOM, MARA] });
  const unread = chat({ unread: 3 });
  const oldest = todo(many.id, { title: 'Sign the form', createdAt: NOW - 3 * H });
  const rows = rank([one, many, unread], [todo(one.id, { title: 'Approve the logo' }), todo(many.id, { createdAt: NOW - H }), oldest]);
  const by = new Map(rows.map((row) => [row.chat.id, row]));
  assert.equal(by.get(one.id)!.reason, 'Waits for you: Approve the logo');
  assert.equal(by.get(many.id)!.reason, '2 things wait for you');
  assert.equal(by.get(many.id)!.todo?.id, oldest.id, 'the oldest waiting to-do (a click opens the chat at it)');
  assert.equal(by.get(unread.id)!.reason, undefined);
  const working = new Map(rank([busy, team]).map((row) => [row.chat.id, row]));
  assert.equal(working.get(busy.id)!.reason, 'Mara is working', 'the person is never "working"');
  assert.equal(working.get(team.id)!.reason, 'Tom and 1 more are working');
});

test('what does not wait on the person: their own to-dos, snoozed ones, timers that have not rung, due on a later day', () => {
  const own = chat();
  const snoozed = chat();
  const timer = chat();
  const rang = chat();
  const later = chat();
  const todos = [
    todo(own.id, { createdBy: HUMAN_ID }),
    todo(snoozed.id, { status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: NOW - H, until: NOW + H } }),
    todo(timer.id, { createdBy: SYSTEM_ID, widget: { type: 'timer', label: 'Tea', at: new Date(NOW + 10 * M).toISOString() } }),
    todo(rang.id, { createdBy: SYSTEM_ID, status: 'needs_you', widget: { type: 'timer', label: 'Tea', at: new Date(NOW - M).toISOString() } }),
    todo(later.id, { dueAt: NOW + 30 * H }),
  ];
  const rows = importantChats([own, snoozed, timer, rang, later], { todos, now: NOW, dayEnd: NOW + 15 * H, nameOf: () => 'Agent' });
  assert.deepEqual(ids(rows), [rang.id], 'only the timer that rang waits on the person');
});

test('never listed: app chats, agent-only rooms, archived chats, people\'s own chats; a muted chat\'s unread does not count', () => {
  const todoChat = chat({ unread: 4, settings: { system: 'todo' } });
  const room = chat({ working: [MARA], settings: { hiddenFromList: true } });
  const agentsOnly = chat({ working: [MARA] }, [MARA, TOM]);
  const archived = chat({ unread: 2, archivedAt: NOW - H });
  const peoples = chat({ unread: 2 }, [ANNA, MARA]);
  const muted = chat({ unread: 5, settings: { notifications: 'off' } });
  const mutedWorking = chat({ unread: 5, working: [MARA], settings: { notifications: 'off' } });
  const rows = rank([todoChat, room, agentsOnly, archived, peoples, muted, mutedWorking]);
  assert.deepEqual(ids(rows), [mutedWorking.id]);
  assert.equal(rows[0].signal, 'working', 'muted: the next signal counts');
});

test('people\'s own chats: no active "human" and people hold it (or held it so) – a chat the person is in is theirs', () => {
  assert.equal(peoplesOwnChat(chat({}, [ANNA, MARA])), true);
  assert.equal(peoplesOwnChat(chat({ settings: { peopleChat: true } }, [MARA])), true, 'its last person left: still theirs');
  const left = chat({}, [HUMAN_ID, ANNA]);
  left.members[0].leftAt = NOW - H;
  assert.equal(peoplesOwnChat(left), true, 'the owner left it');
  assert.equal(peoplesOwnChat(chat({}, [HUMAN_ID, ANNA, MARA])), false, 'the person is a member (also: a person\'s own session, "human" is the caller)');
  assert.equal(listable(chat({}, [HUMAN_ID, ANNA])), true);
});

test('the person\'s own activity counts for 24 h only', () => {
  const fresh = chat({ lastPreview: { authorId: HUMAN_ID, text: 'Draft it', at: NOW - 23 * H } });
  const stale = chat({ lastPreview: { authorId: HUMAN_ID, text: 'Old', at: NOW - 25 * H } });
  const theirs = chat({ lastPreview: { authorId: MARA, text: 'Here it is', at: NOW - H } });
  assert.deepEqual(ids(rank([fresh, stale, theirs])), [fresh.id]);
});

test('within a signal: newer activity first, then the id', () => {
  const older = chat({ id: 'ch_b', unread: 1, lastPreview: { authorId: MARA, text: 'a', at: NOW - 3 * H } });
  const newer = chat({ id: 'ch_c', unread: 1, lastPreview: { authorId: MARA, text: 'b', at: NOW - H } });
  const tie = chat({ id: 'ch_a', unread: 1, lastPreview: { authorId: MARA, text: 'c', at: NOW - 3 * H } });
  assert.deepEqual(ids(rank([older, newer, tie])), ['ch_c', 'ch_a', 'ch_b']);
});

test('the briefing\'s picks first in its order while they still have a live signal, with the live reason; gone or quiet ones drop', () => {
  const unread = chat({ unread: 1 });
  const working = chat({ working: [MARA] });
  const quietNow = chat();
  const waits = chat();
  const briefing = [{ conversationId: working.id }, { conversationId: 'ch_gone' }, { conversationId: quietNow.id }, { conversationId: unread.id }];
  const rows = rank([unread, working, quietNow, waits], [todo(waits.id)], briefing);
  assert.deepEqual(ids(rows), [working.id, unread.id, waits.id]);
  assert.deepEqual(rows.map((row) => row.picked), [true, true, false]);
  assert.equal(rows[0].reason, 'Mara is working', 'the live reason, not the morning\'s count');
});

test('at most 5 rows; beyond the first 3 only strong ones (picked, waiting, unread)', () => {
  const weak = Array.from({ length: 4 }, (_, index) => chat({ working: [MARA], lastMessageAt: NOW - index * M }));
  assert.equal(rank(weak).length, 3, 'only working chats: 3');
  const strong = Array.from({ length: 7 }, () => chat({ unread: 1 }));
  assert.equal(rank(strong).length, CHATS_MAX);
  const mixed = rank([...weak, chat({ unread: 2 }), chat({ unread: 1 }), chat({ unread: 3 })]);
  assert.deepEqual(mixed.map((row) => row.signal), ['unread', 'unread', 'unread'], 'three strong fill the first places; no weak one after them');
  const picked = rank(weak, [], weak.map((entry) => ({ conversationId: entry.id })));
  assert.equal(picked.length, 4, 'the briefing\'s picks count as strong');
  assert.deepEqual(rank([]), []);
});

test('one ranking with the morning briefing (shared/model/chat-rank.ts): the same chats in the same order, never one Home drops', () => {
  const later = chat({ id: 'ch_later' });
  const timerChat = chat({ id: 'ch_timer', lastMessageAt: NOW - H });
  const muted = chat({ id: 'ch_muted', unread: 4, settings: { notifications: 'off' } });
  const agentsOnly = chat({ id: 'ch_agents', unread: 2 }, [MARA, TOM]);
  const people = chat({ id: 'ch_people', unread: 2 }, [ANNA, MARA]);
  const asked = chat({ id: 'ch_asked', lastMessageAt: NOW - 2 * H });
  const unread = chat({ id: 'ch_unread', unread: 1, lastMessageAt: NOW - 3 * H });
  const busy = chat({ id: 'ch_busy', working: [MARA] });
  const todos = [
    todo(later.id, { dueAt: NOW + 3 * 24 * H }), // due on a later day: under Later, waits on nobody now
    todo(timerChat.id, { widget: { type: 'timer', label: 'Tea', at: new Date(NOW + H).toISOString() }, dueAt: NOW + H }), // has not rung
    todo(asked.id),
  ];
  const chats = [later, timerChat, muted, agentsOnly, people, asked, unread, busy];
  const home = rank(chats, todos).map((row) => row.chat.id);
  const waits = new Map([...waitingByChat(todos, NOW)].map(([id, list]) => [id, list.length]));
  const briefing = rankChats(chats, { waits, nameOf: (id) => NAMES[id] ?? id, now: NOW }).map((row) => row.conversationId);
  assert.deepEqual(home, ['ch_asked', 'ch_unread', 'ch_busy']);
  assert.deepEqual(briefing, home);
});

// C3 fix: one source for who works – a working chat's reason names who the chat header's live line names first
// (chat/live-text.ts workingIds: the activity's entries in order, then the summary's list).
test('a working chat names who the chat header names first', () => {
  const team = chat({ working: [MARA, TOM] }, [HUMAN_ID, MARA, TOM]);
  const order = workingIds(team, [{ agentId: TOM, conversationId: team.id, note: 'bash' }, { agentId: 'ag_x', conversationId: 'elsewhere', note: '' }]);
  assert.deepEqual(order, [TOM, MARA]);
  const [row] = importantChats([team], { todos: [], now: NOW, nameOf: (id) => NAMES[id] ?? 'Agent', workingOf: () => order });
  assert.equal(row.reason, 'Tom and 1 more are working');
});
