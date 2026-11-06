// Pure task/to-do view helpers (src/ui/tasks/model.ts): grouping and ordering, progress text,
// owners, binding approvals, "Show as…", recent-done windows, per-chat sections, the Work
// index, evidence actions, due inputs and the leaving merge for the exit animation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task, TaskView } from '../../../src/shared/model/tasks.ts';
import {
  DAY_MS, askTargetOf, canToggleStep, compareTodos, dueState,
  orderedSteps, ownerOf, progressLabel, progressPercent, progressShort,
  recentDone, removedItems, searchTasks, showAsOptions, widgetIcon, withLeaving, withStep, withoutStep,
} from '../../../src/ui/tasks/model.ts';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
let seq = 0;

function task(patch: Partial<TaskView> = {}): TaskView {
  seq++;
  return {
    id: patch.id ?? `task_${seq}`, conversationId: 'ch_a', title: `Task ${seq}`, notes: '', status: 'open', assigneeKind: 'team',
    createdBy: 'human', priority: 0, ledger: {}, attempts: 0, sort: seq, rev: 1, createdAt: NOW - 1000 * seq, updatedAt: NOW,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Alpha', running: false,
    ...patch,
  };
}

function step(patch: Partial<Task> = {}): Task {
  const { steps: _s, progress: _p, conversationTitle: _c, running: _r, ...rest } = task(patch);
  return { ...rest, parentId: patch.parentId ?? 'task_parent' };
}


test('searchTasks matches title, notes and chat name case-insensitively', () => {
  const a = task({ title: 'Render intro', notes: '' });
  const b = task({ title: 'Other', notes: 'needs the INTRO music' });
  const c = task({ title: 'Third', conversationTitle: 'Intro chat' });
  const d = task({ title: 'Nothing' });
  assert.deepEqual(searchTasks([a, b, c, d], 'intro').map((t) => t.id), [a.id, b.id, c.id]);
  assert.equal(searchTasks([a, d], '  ').length, 2);
});

test('compareTodos: due first (none last), then priority, then age', () => {
  const late = task({ dueAt: NOW + 5000 });
  const soon = task({ dueAt: NOW + 1000 });
  const urgent = task({ priority: 2 });
  const old = task({ createdAt: NOW - 99_999 });
  const sorted = [old, urgent, late, soon].sort(compareTodos).map((t) => t.id);
  assert.deepEqual(sorted, [soon.id, late.id, urgent.id, old.id]);
});

test('progress helpers', () => {
  assert.equal(progressLabel({ done: 6, total: 10 }), '6 of 10');
  assert.equal(progressShort({ done: 1, total: 3 }), '1/3');
  assert.equal(progressLabel({ done: 0, total: 0 }), '');
  assert.equal(progressPercent({ done: 1, total: 3 }), 33);
  assert.equal(progressPercent({ done: 5, total: 3 }), 100);
  assert.equal(progressPercent({ done: 0, total: 0 }), 0);
});

test('a task owner: an agent, or the team while it has none', () => {
  assert.deepEqual(ownerOf({ assigneeKind: 'agent', assigneeId: 'ag_x' }), { kind: 'agent', id: 'ag_x' });
  assert.deepEqual(ownerOf({ assigneeKind: 'agent' }), { kind: 'team' });
});

test('a to-do answer goes to the task; "Show as" is for human to-dos only', () => {
  const human = task({ assigneeKind: 'human', createdBy: 'ag_1', widget: { type: 'approve', action: 'Pay' } });
  assert.deepEqual(askTargetOf(human), { kind: 'task', taskId: human.id });
  assert.ok(showAsOptions(human).length > 0);
  assert.equal(showAsOptions(task({ assigneeKind: 'agent' })).length, 0);
});

test('widget icons follow the widget type and record mode', () => {
  assert.equal(widgetIcon({ type: 'record', mode: 'video' }), 'camera');
  assert.equal(widgetIcon({ type: 'record', mode: 'audio' }), 'microphone');
  assert.equal(widgetIcon({ type: 'timer', label: 'x' }), 'clock');
  assert.equal(widgetIcon(undefined), 'check-circle');
});

test('dueState', () => {
  assert.equal(dueState(undefined, NOW), 'none');
  assert.equal(dueState(NOW - 1, NOW), 'overdue');
  assert.equal(dueState(NOW + 3_600_000, NOW), 'soon');
  assert.equal(dueState(NOW + 2 * DAY_MS, NOW), 'later');
});

test('recentDone: top-level finished inside the window, newest first', () => {
  const recent = task({ status: 'done', completedAt: NOW - DAY_MS });
  const newer = task({ status: 'done', completedAt: NOW - 1000 });
  const old = task({ status: 'done', completedAt: NOW - 5 * DAY_MS });
  const cancelled = task({ status: 'cancelled', completedAt: NOW - 1000 });
  const stepDone = task({ status: 'done', completedAt: NOW, parentId: 'task_x' });
  assert.deepEqual(recentDone([recent, old, newer, cancelled, stepDone], NOW, 3).map((t) => t.id), [newer.id, recent.id]);
  assert.deepEqual(recentDone([recent, cancelled], NOW, 3, ['done', 'cancelled']).map((t) => t.id), [cancelled.id, recent.id]);
});

test('steps: only human steps toggle; order and progress stay consistent', () => {
  assert.equal(canToggleStep({ assigneeKind: 'human', status: 'open' }), true);
  assert.equal(canToggleStep({ assigneeKind: 'agent', status: 'open' }), false);
  assert.equal(canToggleStep({ assigneeKind: 'human', status: 'cancelled' }), false);
  const first = step({ sort: 2 });
  const second = step({ sort: 1 });
  assert.deepEqual(orderedSteps([first, second]).map((s) => s.id), [second.id, first.id]);
  const parent = task({ steps: [first, second], progress: { done: 0, total: 2 } });
  const updated = withStep(parent, { ...first, status: 'done' });
  assert.deepEqual(updated.progress, { done: 1, total: 2 });
  const added = withStep(updated, step({ status: 'open' }));
  assert.deepEqual(added.progress, { done: 1, total: 3 });
  assert.deepEqual(withoutStep(added, first.id).progress, { done: 0, total: 2 });
});


test('leaving items are re-inserted at their former place', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  const gone = removedItems([a, b, c], [a, c]);
  assert.deepEqual(gone, [{ item: b, index: 1 }]);
  assert.deepEqual(withLeaving([a, c], gone), [{ item: a, leaving: false }, { item: b, leaving: true }, { item: c, leaving: false }]);
  // An item that came back is not duplicated.
  assert.deepEqual(withLeaving([a, b, c], gone).map((row) => row.item.id), ['a', 'b', 'c']);
  // Index past the end is clamped.
  assert.deepEqual(withLeaving([], [{ item: c, index: 5 }]), [{ item: c, leaving: true }]);
});

test('only items gone from the whole list leave; items pushed past a limit or filtered out stay open', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' };
  // Visible slice [a, b, c] → [d, a, b]: c was pushed past the limit by d but is still a to-do.
  assert.deepEqual(removedItems([a, b, c], [d, a, b], [d, a, b, c]), []);
  // b was answered (gone from the whole list): only b leaves.
  assert.deepEqual(removedItems([a, b, c], [a, c], [a, c, d]), [{ item: b, index: 1 }]);
  // Switching the chat filter: the other chat's items still exist, nothing animates.
  assert.deepEqual(removedItems([a, b], [c], [a, b, c]), []);
});
