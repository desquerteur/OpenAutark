// B-041 track A1, contract §5.6: check-off ↔ calendar – the pure rule (calendar/rules.ts blockChange) over every
// case, and the bus listener (calendar/task-link.ts) on real to-dos and steps: ticked before the block → the block
// goes; during → it ends now ('cut'); after → 'done'; cancelled → it goes; reopened → planned again while it has
// not ended (a cut block with the end its estimate gave it), else it goes so the to-do can be planned again; handed to the team before its time → it goes; a removed to-do or chat takes its block along and the
// window hears 'calendar.removed'; the sources' mirror hook hears every change.
// Owns: checks of the check-off rule and its listener only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { blockChange } from '../../../src/runtime/calendar/rules.ts';
import { at, world } from './fixture.ts';

const block = { startAt: 1_000, endAt: 2_000, state: 'planned' as const };
const done = (completedAt?: number) => ({ status: 'done' as const, completedAt, assigneeKind: 'human' as const });

test('the rule: before / during / after the block, cancelled, reopened, handed on', () => {
  assert.deepEqual(blockChange(block, done(500), 9_999), { action: 'remove' }, 'ticked before the block: the time is free');
  assert.deepEqual(blockChange(block, done(1_000), 9_999), { action: 'remove' }, 'at its very start: nothing of it was used');
  assert.deepEqual(blockChange(block, done(1_400), 9_999), { action: 'cut', endAt: 1_400 }, 'during: it ends then');
  assert.deepEqual(blockChange(block, done(2_000), 9_999), { action: 'done' }, 'at its end');
  assert.deepEqual(blockChange(block, done(5_000), 9_999), { action: 'done' }, 'after');
  assert.deepEqual(blockChange(block, done(), 1_500), { action: 'cut', endAt: 1_500 }, 'no finish time: now');
  assert.deepEqual(blockChange({ ...block, state: 'done' }, done(3_000), 9_999), { action: 'none' }, 'already settled');
  for (const state of ['planned', 'done', 'cut'] as const) {
    assert.deepEqual(blockChange({ ...block, state }, { status: 'cancelled', assigneeKind: 'human' }, 1_500), { action: 'remove' }, `cancelled (${state})`);
  }
  const open = { status: 'open' as const, assigneeKind: 'human' as const };
  assert.deepEqual(blockChange({ ...block, state: 'done' }, open, 1_500), { action: 'planned', endAt: 2_000 }, 'reopened while the block has not ended');
  assert.deepEqual(blockChange({ ...block, state: 'done' }, open, 2_500), { action: 'remove' }, 'reopened after a done block ended: it goes, the to-do is unplanned');
  const cutAt = { ...block, state: 'cut' as const, endAt: 1_200 };
  assert.deepEqual(blockChange(cutAt, { ...open, estimateMin: 1 }, 1_500), { action: 'planned', endAt: 61_000 }, 'reopened during the time its estimate gave: planned again with that end');
  assert.deepEqual(blockChange(cutAt, open, 1_500), { action: 'planned', endAt: 1_000 + 30 * 60_000 }, 'no estimate: the default 30 min');
  assert.deepEqual(blockChange(cutAt, { ...open, estimateMin: 1 }, 61_000), { action: 'remove' }, 'reopened after that time: it goes, the to-do is unplanned');
  assert.deepEqual(blockChange(block, open, 1_500), { action: 'none' }, 'an open to-do keeps its planned block');
  assert.deepEqual(blockChange(block, { status: 'open', assigneeKind: 'team' }, 500), { action: 'remove' }, 'handed to the team before its time');
  assert.deepEqual(blockChange(block, { status: 'open', assigneeKind: 'agent' }, 1_500), { action: 'none' }, 'a block that started stays');
});

function planned(w: ReturnType<typeof world>, title: string, from: string, to: string, extra = {}) {
  const task = w.todo(title, extra);
  const event = w.calendar.upsertBlock(task.id, at(from), at(to), 'planner');
  return { task, event };
}

test('ticked before its block: the block goes, the window and the mirror hear it', () => {
  const w = world({ now: '08:00' });
  const { task, event } = planned(w, 'Küche aufräumen', '10:00', '10:30');
  w.clock.set(at('09:00'));
  w.tasks.setStatus(task.id, 'done', HUMAN_ID);
  assert.equal(w.calendar.repo.get(event.id), undefined);
  assert.deepEqual(w.removedEvents().at(-1), { id: event.id, ownerId: 'human', taskId: task.id });
  assert.deepEqual(w.changes.at(-1), { removed: event.id });
});

test('ticked during its block: it ends now (cut); after it: done – each sent once', () => {
  const w = world({ now: '08:00' });
  const during = planned(w, 'Wäsche waschen', '10:00', '11:00');
  const after = planned(w, 'Steuern erledigen', '08:30', '09:00');
  w.clock.set(at('10:20'));
  w.tasks.setStatus(during.task.id, 'done', HUMAN_ID);
  w.tasks.setStatus(after.task.id, 'done', HUMAN_ID);
  const cut = w.calendar.repo.get(during.event.id)!;
  assert.deepEqual([cut.state, cut.startAt, cut.endAt, cut.rev], ['cut', at('10:00'), at('10:20'), 1]);
  const settled = w.calendar.repo.get(after.event.id)!;
  assert.deepEqual([settled.state, settled.endAt], ['done', at('09:00')]);
  const sent = w.upserted().filter((row) => row.id === during.event.id);
  assert.deepEqual(sent.map((row) => row.state), ['planned', 'cut'], 'created, then cut');
  w.tasks.update(during.task.id, { notes: 'Weichspüler' }, HUMAN_ID);
  assert.equal(w.upserted().filter((row) => row.id === during.event.id).length, 2, 'later changes of the done to-do leave the block alone');
});

test('a step (an agent-raised to-do under a task) follows the same rule', () => {
  const w = world({ now: '08:00' });
  const chat = w.chat();
  const parent = w.tasks.create({ conversationId: chat.id, title: 'Steuern', createdBy: 'ag_mara', assigneeKind: 'agent', assigneeId: 'ag_mara' });
  const step = w.tasks.create({ conversationId: chat.id, title: 'Zettel vorbeibringen', createdBy: 'ag_mara', assigneeKind: 'human', humanReason: 'physical', parentId: parent.id });
  const event = w.calendar.upsertBlock(step.id, at('11:00'), at('11:30'), 'planner');
  w.clock.set(at('11:10'));
  w.tasks.setStatus(step.id, 'done', HUMAN_ID);
  assert.deepEqual([w.calendar.repo.get(event.id)!.state, w.calendar.repo.get(event.id)!.endAt], ['cut', at('11:10')]);
});

test('cancelled: the block goes; reopened: a settled block that has not ended is planned again', () => {
  const w = world({ now: '08:00' });
  const cancelled = planned(w, 'Paket abholen', '15:00', '15:30');
  w.tasks.setStatus(cancelled.task.id, 'cancelled', HUMAN_ID);
  assert.equal(w.calendar.repo.get(cancelled.event.id), undefined);

  const again = planned(w, 'Buch', '09:00', '12:00');
  w.clock.set(at('12:30'));
  w.tasks.setStatus(again.task.id, 'done', HUMAN_ID);
  assert.equal(w.calendar.repo.get(again.event.id)!.state, 'done');
  const moved = w.calendar.move(again.event.id, at('14:00'), at('15:00'), w.calendar.repo.get(again.event.id)!.rev, HUMAN_ID);
  assert.equal(moved.state, 'done');
  w.tasks.setStatus(again.task.id, 'open', HUMAN_ID);
  assert.equal(w.calendar.repo.get(again.event.id)!.state, 'planned', 'its block is ahead again: planned');
});

test('ticked by mistake during its block and unticked: planned again with its end; reopened after it ended: unplanned, and moving a settled block plans it', () => {
  const w = world({ now: '08:00' });
  const kitchen = planned(w, 'Küche aufräumen', '10:00', '10:30', { estimateMin: 30 });
  w.clock.set(at('10:15'));
  w.tasks.setStatus(kitchen.task.id, 'done', HUMAN_ID);
  assert.deepEqual([w.calendar.repo.get(kitchen.event.id)!.state, w.calendar.repo.get(kitchen.event.id)!.endAt], ['cut', at('10:15')]);
  w.clock.set(at('10:16'));
  w.tasks.setStatus(kitchen.task.id, 'open', HUMAN_ID);
  const back = w.calendar.repo.get(kitchen.event.id)!;
  assert.deepEqual([back.state, back.startAt, back.endAt], ['planned', at('10:00'), at('10:30')], 'its block runs on');

  const wash = planned(w, 'Wäsche waschen', '11:00', '11:30');
  w.clock.set(at('11:45'));
  w.tasks.setStatus(wash.task.id, 'done', HUMAN_ID);
  assert.equal(w.calendar.repo.get(wash.event.id)!.state, 'done');
  w.clock.set(at('12:00'));
  w.tasks.setStatus(wash.task.id, 'open', HUMAN_ID);
  assert.equal(w.calendar.repo.get(wash.event.id), undefined, 'the block is over: it goes, the to-do is unplanned and can be planned again');

  const book = planned(w, 'Buch', '12:30', '13:00');
  const row = w.calendar.repo.get(book.event.id)!;
  const stale = w.calendar.save({ ...row, state: 'cut', endAt: at('12:40'), rev: row.rev + 1 }, row.rev); // a settled block of an open to-do (data from before)
  const moved = w.calendar.move(stale.id, at('15:00'), at('15:30'), stale.rev, HUMAN_ID);
  assert.deepEqual([moved.state, moved.setBy], ['planned', 'person'], 'moving it plans the open to-do again');
});

test('handed to the team before its time: the block goes; a block that started stays', () => {
  const w = world({ now: '08:00' });
  const later = planned(w, 'Webseite verbessern', '14:00', '15:00');
  const started = planned(w, 'Rechnung prüfen', '07:30', '08:30');
  w.tasks.assign(later.task.id, { kind: 'agent', id: 'ag_mara' }, HUMAN_ID);
  w.tasks.assign(started.task.id, { kind: 'agent', id: 'ag_mara' }, HUMAN_ID);
  assert.equal(w.calendar.repo.get(later.event.id), undefined);
  assert.ok(w.calendar.repo.get(started.event.id));
});

test('a removed to-do takes its block along: the cascade is sent as removed; a deleted chat detaches its to-do and keeps the block (B-054)', () => {
  const w = world({ now: '08:00' });
  const gone = planned(w, 'Steuern', '10:00', '10:30');
  w.tasks.remove(gone.task.id, HUMAN_ID);
  assert.deepEqual(w.removedEvents().map((row) => row.id), [gone.event.id]);

  const chat = w.chat();
  const parent = w.tasks.create({ conversationId: chat.id, title: 'Umzug', createdBy: HUMAN_ID, assigneeKind: 'agent', assigneeId: 'ag_mara' });
  const step = w.tasks.create({ conversationId: chat.id, title: 'Kartons holen', createdBy: 'ag_mara', assigneeKind: 'human', humanReason: 'physical', parentId: parent.id });
  const stepBlock = w.calendar.upsertBlock(step.id, at('16:00'), at('16:30'), 'planner');
  w.tasks.remove(parent.id, HUMAN_ID);
  assert.ok(w.removedEvents().some((row) => row.id === stepBlock.id && row.taskId === step.id), "a step's block goes with its task");

  const other = w.chat();
  const inChat = w.tasks.create({ conversationId: other.id, title: 'Anrufen', createdBy: HUMAN_ID, assigneeKind: 'human' });
  const chatBlock = w.calendar.upsertBlock(inChat.id, at('17:00'), at('17:15'), 'planner');
  w.chats.remove(other.id);
  assert.equal(w.tasks.get(inChat.id)?.conversationId, undefined, 'the to-do lives on without the chat (P1)');
  assert.ok(w.calendar.repo.get(chatBlock.id), 'so its block stays');
  assert.ok(!w.removedEvents().some((row) => row.id === chatBlock.id));
});

test('without start() nothing listens; stop() ends the listening', () => {
  const w = world({ now: '08:00', start: false });
  const quiet = planned(w, 'Küche', '10:00', '10:30');
  w.tasks.setStatus(quiet.task.id, 'done', HUMAN_ID);
  assert.ok(w.calendar.repo.get(quiet.event.id), 'not started: the block stays');
  w.calendar.start();
  w.calendar.stop();
  const after = planned(w, 'Wäsche', '11:00', '11:30');
  w.tasks.setStatus(after.task.id, 'done', HUMAN_ID);
  assert.ok(w.calendar.repo.get(after.event.id));
});
