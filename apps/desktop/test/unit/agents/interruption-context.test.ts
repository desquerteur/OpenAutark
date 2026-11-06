// Owns: interruption context through real persisted runs and the turn input builder.
// Never: uses live engines, accounts, network connections or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { CRASH_ERROR } from '../../../src/runtime/store/runs.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { BRIEF_INTERRUPTION_MS, interruptionContext, recordTurnInput } from '../../../src/runtime/agents/interruption-context.ts';
import { buildTurn, noteLines, planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { setup } from './fixture.ts';

async function rig() {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.runs = runs;
  const original = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Export the report' });
  const request = h.request({ runId: 'run_old' });
  const plan = (await planTurn(h.services, request))!;
  runs.start({ id: request.runId, agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  recordTurnInput(h.services, plan, request, original.seq);
  const fail = (error = 'Internet connection lost') => runs.finish(request.runId, { status: 'failed', error });
  const next = h.request({ runId: 'run_next', reason: 'retry' });
  const context = (patch = {}) => interruptionContext(h.services, plan, { ...next, ...patch }, h.chats.messages(h.chat.id, { limit: 1 })[0].seq, 'UTC');
  return { ...h, journal: runs, original, plan, fail, next, context };
}

test('a short retry with unchanged input adds no interruption narrative', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(BRIEF_INTERRUPTION_MS - 1);
  assert.deepEqual(h.context(), {});
});

test('a longer pause brackets the actual input with app events and the real cause', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(BRIEF_INTERRUPTION_MS);
  h.services.context.delta = () => ({ text: 'CEO: Export the report', images: [], lastSeq: h.original.seq });
  const turn = await buildTurn(h.services, h.plan, h.next, h.route, []);
  const text = turn.input.map(part => part.type === 'text' ? part.text : '').join('');
  assert.match(text, /App system events: interrupted work/);
  assert.match(text, /Internet connection lost/);
  assert.match(text, /Retrying now, 60s.*no new input/);
  assert.ok(text.indexOf('Internet connection lost') < text.indexOf('CEO: Export the report'));
  assert.ok(text.indexOf('CEO: Export the report') < text.indexOf('Retrying now'));
});

test('a new CEO message and a cron event are visible even during a brief interruption', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(1000);
  const cronAt = h.clock.now();
  h.clock.advance(1000);
  const message = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'What is happening?' });
  const context = h.context({ reason: 'message', notes: [{ at: cronAt, text: 'Send the invoice', reason: 'schedule' }] });
  assert.match(context.before!, /Scheduled event/);
  assert.match(context.before!, new RegExp(`New chat input #${message.seq}`));
  assert.ok(context.before!.indexOf('Internet connection lost') < context.before!.indexOf('Scheduled event'));
  assert.ok(context.before!.indexOf('Scheduled event') < context.before!.indexOf('New chat input'));
  assert.match(context.after!, /input changed/);
  assert.doesNotMatch(context.before!, /What is happening\?|Send the invoice/, 'full bodies remain in the normal input');
});

test('status lines and failed own replies are not new input', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(1000);
  h.chats.status(h.chat.id, { type: 'note', text: 'Retrying interrupted work' });
  const draft = h.chats.beginAgentMessage(h.chat.id, h.tom.id, 'run_old');
  h.chats.finishAgentMessage(draft.id, { body: 'Partial answer', state: 'failed' });
  assert.deepEqual(h.context(), {});
});

test('editing the original message is changed input', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(1000);
  h.chats.edit(h.original.id, 'Do not export; preview it first', 'human');
  assert.match(h.context().before!, /Changed chat input/);
  assert.match(h.context().after!, /input changed/);
});

test('a changed task is input; ownership bookkeeping alone is not', async () => {
  const h = await rig();
  const task = h.tasks.create({ title: 'Export report', notes: 'October', assigneeKind: 'agent', assigneeId: h.tom.id, createdBy: 'human' });
  h.plan.task = task;
  recordTurnInput(h.services, h.plan, h.request({ runId: 'run_old' }), h.original.seq);
  h.fail();
  h.clock.advance(1000);
  h.plan.task = { ...task, ledger: { ...task.ledger, nextCheckAt: h.clock.now() + 60_000 } };
  assert.deepEqual(h.context(), {});
  h.plan.task = { ...task, notes: 'November instead' };
  assert.match(h.context().before!, /task input has changed/);
});

test('a chat-free event gets restart context only for its own source', async () => {
  const h = await rig();
  const request = h.request({ runId: 'run_mail', conversationId: undefined, reason: 'event', origin: { source: 'mail:inbox', label: 'New mail' } });
  const plan = (await planTurn(h.services, request))!;
  h.journal.start({ id: request.runId, agentId: h.tom.id, trigger: 'event', origin: request.origin });
  recordTurnInput(h.services, plan, request, 0);
  h.clock.advance(3600_000);
  h.journal.reconcile();
  const retry = { ...request, runId: 'run_mail_retry' };
  assert.match(interruptionContext(h.services, plan, retry, 0, 'UTC').before!, /app has restarted/);
  const other = { ...plan, origin: { source: 'mail:other', label: 'Other inbox' }, thread: 'src:mail:other' };
  assert.deepEqual(interruptionContext(h.services, other, retry, 0, 'UTC'), {});
});

test('restart uses the last recorded activity, never pretends the restart time is the crash time', async () => {
  const h = await rig();
  h.clock.advance(2 * 3600_000);
  h.journal.reconcile();
  assert.equal(h.journal.get('run_old')?.error, CRASH_ERROR);
  const context = h.context();
  assert.match(context.before!, /Last recorded activity.*interruption time is unknown.*app has restarted/);
  assert.match(context.after!, /7200s/);
});

test('success clears the interruption context and another thread never inherits it', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(120_000);
  const other = h.chats.create({ agentIds: [h.tom.id], createdBy: 'human' });
  const otherPlan = (await planTurn(h.services, h.request({ conversationId: other.id })))!;
  assert.deepEqual(interruptionContext(h.services, otherPlan, h.next, 0, 'UTC'), {});
  h.journal.start({ id: 'run_done', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'retry' });
  h.journal.finish('run_done', { status: 'done' });
  assert.deepEqual(h.context(), {});
});

test('repeated failures retain the original pause and redact the cause', async () => {
  const h = await rig();
  h.fail();
  h.clock.advance(3600_000);
  h.journal.start({ id: 'run_retry', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'retry' });
  recordTurnInput(h.services, h.plan, { ...h.next, runId: 'run_retry' }, h.original.seq);
  h.journal.finish('run_retry', { status: 'failed', error: 'Limit secret-value reached' });
  h.services.secrets.redact = text => text.replaceAll('secret-value', '[redacted]');
  h.clock.advance(1000);
  const context = h.context();
  assert.match(context.before!, /Limit \[redacted\] reached/);
  assert.doesNotMatch(context.before!, /secret-value/);
  assert.match(context.after!, /3601s/);
});

test('actual attempts persist only input coordinates; a resumed builder sees them', async () => {
  const h = setup();
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.runs = runs;
  h.services.router = { route: async () => h.route } as typeof h.services.router;
  const message = h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Export the report' });
  h.services.context.delta = () => ({ text: 'CEO: Export the report', images: [], lastSeq: message.seq });
  h.state.script = async () => ({ text: '', stop: 'error', error: { code: 'unavailable', message: 'Connection lost' } });
  await new TurnExecutor(() => h.services).execute(h.request());
  const marker = new KvRepo(h.db).get<{ lastSeq: number }>('turnInput', `${h.tom.id}:${h.chat.id}`);
  assert.equal(marker?.lastSeq, message.seq);
  assert.doesNotMatch(JSON.stringify(marker), /Export the report/);
  h.clock.advance(120_000);
  const request = h.request({ runId: 'run_2', reason: 'retry' });
  const plan = (await planTurn(h.services, request))!;
  const turn = await buildTurn(h.services, plan, request, h.route, []);
  assert.match(turn.input[0].type === 'text' ? turn.input[0].text : '', /Connection lost/);
});

test('merged notes keep per-event attribution; app retries are never the AI\'s own notes', () => {
  const lines = noteLines({ reason: 'message', notes: [
    { text: 'Send the invoice', at: 0, reason: 'schedule' },
    { text: 'The app restarted', at: 1, reason: 'retry' },
  ] }, 'UTC');
  assert.match(lines[0], /^My own scheduled note/);
  assert.match(lines[1], /^Note from the app.*retry/);
  assert.doesNotMatch(lines[1], /My own/);
});

for (const changed of [true, false]) test(`a same-run failover explains ${changed ? 'new input during the failed attempt' : 'a long reconnect wait'}`, async () => {
  const h = setup();
  h.services.runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  h.services.accounts.get = id => ({ ...h.account, id });
  let routes = 0;
  h.services.router = { route: async () => {
    if (++routes === 1) return h.route;
    if (!changed) h.clock.advance(120_000);
    return { ...h.route, accountId: 'acc_backup' };
  } } as typeof h.services.router;
  h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Export the report' });
  h.services.context.delta = () => {
    const messages = h.chats.messages(h.chat.id, { limit: 60 });
    return { text: messages.filter(message => message.authorKind === 'human').map(message => message.body).join('\n'), images: [], lastSeq: messages.at(-1)!.seq };
  };
  let attempts = 0;
  let text = '';
  h.state.script = async input => {
    if (++attempts === 1) {
      if (changed) {
        h.clock.advance(1000);
        h.chats.send({ conversationId: h.chat.id, authorId: 'human', body: 'Preview it first' });
      }
      return { text: '', stop: 'error', error: { code: 'unavailable', message: 'Connection lost mid-turn' } };
    }
    text = input.input.map(part => part.type === 'text' ? part.text : '').join('');
    return { text: 'Continued', stop: 'done' };
  };
  await new TurnExecutor(() => h.services).execute(h.request());
  assert.equal(attempts, 2);
  assert.match(text, /Connection lost mid-turn/);
  assert.match(text, /Retrying now/);
  assert.match(text, changed ? /input changed/ : /120s.*no new input/);
});
