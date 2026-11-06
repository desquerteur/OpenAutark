// Integration (T12): a task is carried to completion through the real in-process chain
// (world.ts: TaskService, Ownership, WakeQueue, Scheduler, Dispatcher, TurnExecutor, RunJournal,
// ManualClock, scripted FakeEngine) – only the scheduler's single timer moves time on.
// Scenario (the simple loop, tasks/ownership.ts): a /task with two steps lands as team work → the chat lead
// claims it and plans → one step done → a turn that does not move the task waits a pause before the next →
// the owner asks the person itself (human.ask) and waits – one re-check a day later at most → the answer resumes the task at once → completed without a
// verifier stays 'claimed' → the follow-up routine fires a tracked task 48 h later → the process dies
// mid-turn and a restart on the same database (reconcile + recover) loses nothing and finishes the routine
// task once. Every gap between turns, the silence of background turns (B-047 D4: their text stays in the
// run journal) and the turn total are asserted.
// Owns: these assertions only. Never: real timers, sleeps, engines or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import { CONTINUE_MS, RECHECK_MS, stallDelay } from '../../../src/runtime/tasks/ownership.ts';
import { INTERRUPTED_NOTE } from '../../../src/runtime/tasks/recover-notes.ts';
import { boot, type Brain, type TurnContext, type World } from './world.ts';

const H = 3600_000;
const DAY = 24 * H;
const TITLE = 'Order the launch stickers';
const ROUTINE = 'Check the sticker delivery';
const PORTAL = 'The supplier portal asks for a login before checkout.';
const ASK = 'Supplier portal login';
const tom = agent('ag_tom', 'Tom');

/** Tom's side of the story: what a careful agent does on each turn of the two tasks. */
const brain: Brain = async (turn) => {
  const task = turn.taskId ? turn.services.tasks.get(turn.taskId) : undefined;
  if (task?.title === TITLE) return orderTurn(turn, task);
  if (task?.title === ROUTINE) return routineTurn(turn, task);
  return { text: 'Noted.' };
};

async function orderTurn(turn: TurnContext, task: TaskView): Promise<{ text: string }> {
  if (task.assigneeKind === 'team') {
    await turn.call('tasks.claim', { taskId: task.id });
    await turn.call('tasks.update', { taskId: task.id, plan: ['Pick the design', 'Order 500 stickers'] });
    return { text: 'I take this one: design first, then the order.' };
  }
  const [design, order] = task.steps;
  if (task.steps.some((step) => step.assigneeKind === 'human' && step.status === 'done')) { // the person's click came
    await turn.call('tasks.complete', { taskId: order.id, summary: 'Ordered 500 stickers', evidence: [{ kind: 'note', label: 'order SO-1042' }] });
    const routine = await turn.call('schedules.routine', { title: ROUTINE, task: { title: ROUTINE }, when: { repeat: { every: '1w', start: 'PT48H', count: 4 } } });
    await turn.call('tasks.complete', {
      taskId: task.id, summary: 'Ordered 500 round stickers.', evidence: [{ kind: 'file', label: 'order-confirmation.pdf', ref: 'files/order-confirmation.pdf' }],
      followUps: [{ label: ROUTINE, scheduleId: routine.scheduleId }],
    });
    return { text: 'Ordered: 500 round stickers, the confirmation is saved.' };
  }
  if (design.status !== 'done') {
    await turn.call('tasks.complete', { taskId: design.id, summary: 'Round logo', evidence: [{ kind: 'note', label: 'round logo picked' }] });
    return { text: 'Design picked: the round logo.' };
  }
  if (task.steps.some((step) => step.assigneeKind === 'human' && step.status !== 'done')) return { text: 'Waiting for your supplier login.' };
  if (!task.ledger.stalls) return { text: PORTAL }; // the first try moves nothing
  // Stuck once: the owner asks the person itself – nothing escalates for it.
  await turn.call('human.ask', { title: ASK, reason: 'credential', widget: { type: 'confirm', instructions: 'Log in to the supplier portal once, then confirm.' }, why: PORTAL, taskId: task.id });
  await turn.call('tasks.update', { taskId: task.id, status: 'waiting', note: 'Waiting for the supplier login' });
  return { text: 'I asked you for the supplier login.' };
}

async function routineTurn(turn: TurnContext, task: TaskView): Promise<{ text?: string; hang?: boolean }> {
  if (!turn.input.includes(INTERRUPTED_NOTE)) {
    await turn.call('tasks.update', { taskId: task.id, status: 'working', note: 'Checking the tracking page' });
    return { hang: true }; // the process dies during this turn
  }
  await turn.call('tasks.complete', { taskId: task.id, summary: 'The stickers arrive on Friday.', evidence: [{ kind: 'link', label: 'tracking', ref: 'https://tracking.example/SO-1042' }] });
  return { text: 'Checked: the stickers arrive on Friday.' };
}

/** A world with Tom's 1:1 chat and the person's task in it, as the /task composer sends it (title and steps). */
async function withTask() {
  const w = boot({ agents: [tom], brain });
  const chat = w.chats.create({ title: 'Launch', agentIds: [tom.id], createdBy: HUMAN_ID });
  w.start();
  const task = w.tasks.create({
    conversationId: chat.id, title: TITLE, steps: ['Pick the design', 'Order 500 stickers'], doneWhen: 'The order confirmation is saved',
    clientId: 'slash-1', createdBy: HUMAN_ID,
  });
  await w.settle();
  const onTask = (world: World = w) => world.turns.filter((turn) => turn.taskId === task.id);
  const current = () => w.tasks.get(task.id)!;
  const asked = () => current().steps.find((step) => step.title === ASK && step.assigneeKind === 'human');
  /** Moves time on (the scheduler's timer only) until the owner asked the person; the to-do. */
  const toPerson = async () => {
    for (let i = 0; i < 20 && !asked(); i++) await w.step();
    const step = asked();
    assert.ok(step, 'the owner asked the person');
    return w.tasks.get(step.id)!;
  };
  return { w, chat, task, onTask, current, toPerson };
}

const snapshot = (world: World) => ({
  tasks: world.db.all('SELECT id, parent_id, status, assignee_kind, assignee_id, rev, ledger, result, waiting_on FROM tasks ORDER BY id'),
  schedules: world.db.all('SELECT id, kind, active, next_at, runs FROM schedules ORDER BY id'),
});

test('a /task is carried to completion: claim, a step, a paced stall, the person, a routine, and a restart that loses nothing', async () => {
  const { w, chat, task, onTask, current, toPerson } = await withTask();
  assert.equal(task.assigneeKind, 'team', 'a /task without an assignee is team work');
  assert.equal(task.steps.length, 2);

  // The lead claims the team task in its first turn and keeps a plan.
  assert.deepEqual(onTask().map((turn) => turn.reason), ['task']);
  assert.equal(current().assigneeId, tom.id);
  assert.equal(current().status, 'open', 'B-078: "working" only while a run is live – the claim turn ended');
  assert.deepEqual(current().ledger.plan, ['Pick the design', 'Order 500 stickers']);
  const unread = w.chats.summary(chat.id).unread;
  assert.equal(unread, 0, 'the claim turn is background work: its answer stays in the run journal (B-047 D4)');

  // Work, one turn that moves nothing, then the owner asks – paced by real progress, never a 1-second loop.
  const todo = await toPerson();
  const turns = onTask();
  assert.equal(turns.length, 4, 'bounded: claim, one step, the stuck try, the ask');
  const gaps = turns.slice(1).map((turn, i) => turn.at - turns[i].at);
  assert.deepEqual(gaps, [CONTINUE_MS, CONTINUE_MS, stallDelay(1)], 'progress continues at once, a turn without progress waits');
  assert.ok(turns.slice(1).every((turn) => turn.reason === 'retry'), 'continuations are the ownership loop\'s follow-ups');

  // The owner's own ask: one to-do on the person's list, for what only the person can give.
  assert.equal(todo.humanReason, 'credential');
  assert.equal(todo.widget?.type, 'confirm');
  assert.ok(w.tasks.todos().some((item) => item.id === todo.id));

  // Background turns keep their text in the run journal (B-047 D4): no chat message from a continuation.
  const runs = new Map(w.turns.map((turn) => [turn.runId, turn]));
  const replies = w.chats.messages(chat.id, { limit: 500 }).filter((message) => message.authorId === tom.id && message.kind === 'text');
  const background = replies.filter((message) => runs.get(message.runId ?? '')?.reason === 'retry');
  assert.deepEqual(background.map((message) => message.body), ['I asked you for the supplier login.'], 'of the continuations only the turn that asked the person speaks in the chat');

  // The answer resumes the task now – no timer, the same instant.
  const answeredAt = w.clock.now();
  const before = w.turns.length;
  w.tasks.answer({ taskId: todo.id, answer: { confirmed: true }, by: HUMAN_ID });
  await w.settle();
  const resumed = w.turns.slice(before).filter((turn) => turn.taskId === task.id);
  assert.deepEqual(resumed.map((turn) => [turn.reason, turn.at]), [['message', answeredAt]], 'B-076: as for a line the person typed');
  assert.match(resumed[0].input, /(?:^|\n)human: Done$/, 'the click is the person\'s line in the chat (world.ts renders "author: body")');
  assert.doesNotMatch(resumed[0].input, /ui-answer|marked a step/, 'no second word about it');

  // Completed without a verifier: done, but only claimed – and the note says why.
  const done = current();
  assert.equal(done.status, 'done');
  assert.ok(done.steps.filter((step) => step.assigneeKind !== 'human').every((step) => step.status === 'done'), done.steps.map((step) => `${step.title}:${step.status}`).join(', '));
  assert.equal(done.result?.verification, 'claimed_by_agent');
  assert.ok(w.notified.some((item) => item.kind === 'done' && item.taskId === task.id), 'the person hears it is done');
  assert.equal(w.wakes.list(tom.id).filter((wake) => wake.taskId === task.id).length, 0, 'finished work plans no further turn');

  // The follow-up routine: nothing runs for 48 h, then it fires a tracked task for Tom.
  const routine = w.scheduler.list({ ownerId: tom.id }).find((item) => item.kind === 'routine')!;
  assert.deepEqual(done.result?.followUps, [{ label: ROUTINE, scheduleId: routine.id }]);
  const quietFrom = w.turns.length;
  const doneAt = w.clock.now();
  const fired = () => w.tasks.list({ conversationId: chat.id }).find((item) => item.title === ROUTINE);
  for (let i = 0; i < 3 && !fired(); i++) await w.step(); // the timer of the cancelled re-check may fire first, harmlessly
  assert.equal(w.clock.now() - doneAt, 48 * H, 'the routine fires 48 h later');
  const routineTask = fired()!;
  assert.equal(routineTask.assigneeId, tom.id);
  const cut = w.turns.at(-1)!;
  assert.deepEqual(w.turns.slice(quietFrom).map((turn) => turn.taskId), [routineTask.id], 'only the routine task ran');
  assert.equal(w.dispatcher.activity().length, 1, 'its turn is still running');

  // The process dies mid-turn; a new runtime on the same database recovers.
  const kept = snapshot(w);
  w.crash();
  const w2 = boot({ agents: [tom], db: w.db, clock: w.clock, brain });
  assert.deepEqual(snapshot(w2), kept, 'building the services changes no task, step, ledger, result or schedule');
  const started = w2.start();
  assert.deepEqual(started.runs.runIds, [cut.runId]);
  assert.equal(started.continued, 1, 'the cut-off routine task continues');
  await w2.settle();
  const again = w2.turns.filter((turn) => turn.taskId === routineTask.id);
  assert.equal(again.length, 1, 'one turn finishes it');
  assert.ok(again[0].input.includes(INTERRUPTED_NOTE), again[0].input);
  assert.equal(w2.tasks.get(routineTask.id)!.status, 'done');
  assert.equal(w2.runs.get(cut.runId)?.status, 'interrupted');
  assert.equal(w2.tasks.list({ conversationId: chat.id }).filter((item) => item.title === ROUTINE).length, 1, 'the routine fired once');
  const schedule = w2.scheduler.get(routine.id)!;
  assert.deepEqual([schedule.active, schedule.runs, schedule.nextAt], [true, 1, routine.nextAt! + 7 * DAY]);
  assert.equal(w2.timers.only()?.ms, schedule.nextAt! - w2.clock.now(), 'the next routine is armed after the restart');
  assert.equal(w2.tasks.get(task.id)!.status, 'done');
  // Reconcile and recover lost nothing: every other task, step, ledger and result is as before the crash.
  const others = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.id !== routineTask.id && row.parent_id !== routineTask.id);
  assert.deepEqual(others(snapshot(w2).tasks), others(kept.tasks), 'the finished task, its steps, ledger and result are unchanged');
  assert.equal(onTask(w2).length, 0, 'finished work never runs again');
  assert.equal(w.turns.length + w2.turns.length, turns.length + 3, 'bounded: the work before the ask, the answer, the cut-off and the finished routine turn');
});

// A task that waits on the person gets one re-check a day later; tasks/lifecycle.ts completing() (and ownership.afterTurn) end it.
test('a task that waits on the person: one re-check a day later, and it ends when the task finishes', async () => {
  const { w, task, onTask, current, toPerson } = await withTask();
  const todo = await toPerson();
  const askedAt = w.clock.now();
  assert.equal(current().status, 'waiting');
  assert.deepEqual(w.wakes.list(tom.id).filter((wake) => wake.taskId === task.id).map((wake) => wake.dueAt), [askedAt + RECHECK_MS], 'one re-check a day later, nothing sooner');
  w.tasks.answer({ taskId: todo.id, answer: { confirmed: true }, by: HUMAN_ID });
  await w.settle();
  assert.equal(current().status, 'done');
  const doneAt = w.clock.now();
  const left = w.wakes.list(tom.id).filter((wake) => wake.taskId === task.id).map((wake) => wake.reason);
  await w.step(); // the next armed thing: the routine (48 h) – never a stale re-check
  const late = onTask().filter((turn) => turn.at > doneAt).map((turn) => turn.reason);
  assert.deepEqual({ left, late }, { left: [], late: [] }, 'no follow-up and no turn for finished work');
});

// A step's completion does not move its parent's rev, so tasks.complete itself must count as progress
// (agents/turn-progress.ts) – otherwise the third step in a row would wait a stall pause.
test('an owner that finishes one checklist step per turn is never treated as stalled', async () => {
  const STEPS = ['Draft', 'Review', 'Polish', 'Print', 'Ship'];
  const stepper: Brain = async (turn) => {
    const task = turn.taskId ? turn.services.tasks.get(turn.taskId) : undefined;
    if (task?.title !== 'Make the flyer') return { text: 'Noted.' };
    if (task.assigneeKind === 'team') {
      await turn.call('tasks.claim', { taskId: task.id });
      return { text: 'I take this one.' };
    }
    const next = task.steps.find((step) => step.status !== 'done');
    const id = next?.id ?? task.id;
    await turn.call('tasks.complete', { taskId: id, summary: `${next?.title ?? 'Flyer'} done`, evidence: [{ kind: 'note', label: `${next?.title ?? 'flyer'} done` }] });
    return { text: next ? `${next.title}: done.` : 'The flyer is shipped.' };
  };
  const w = boot({ agents: [tom], brain: stepper });
  const chat = w.chats.create({ title: 'Flyer', agentIds: [tom.id], createdBy: HUMAN_ID });
  w.start();
  const task = w.tasks.create({ conversationId: chat.id, title: 'Make the flyer', steps: STEPS, clientId: 'slash-2', createdBy: HUMAN_ID });
  await w.settle();
  for (let i = 0; i < 20 && w.tasks.get(task.id)!.status !== 'done'; i++) await w.step();
  const turns = w.turns.filter((turn) => turn.taskId === task.id);
  const gaps = turns.slice(1).map((turn, i) => turn.at - turns[i].at);
  assert.equal(w.tasks.get(task.id)!.status, 'done');
  assert.deepEqual(gaps, Array(STEPS.length + 1).fill(CONTINUE_MS), 'every step turn is followed by a continuation, never a pause');
  assert.equal(w.tasks.get(task.id)!.ledger.stalls ?? 0, 0, 'no stall');
});
