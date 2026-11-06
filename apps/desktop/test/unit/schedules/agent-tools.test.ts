// The agents' schedule tools with the one `when` shape (B-044, src/runtime/tools/builtin/schedule.ts) against
// the real chat/schedule services: each result echoes the rule and the next runs (zone-offset ISO times in
// the profile zone), a scheduled post or routine writes exactly one quiet "Scheduled" line (with its first
// run) – a reminder none –, the old top-level at/cron/everyMinutes are refused by the schema, and
// schedules.update pauses, resumes, re-times and rewords own schedules or those of managed agents – never
// the person's or another's; one the person paused (RPC schedules.update, or stored before B-044 without
// pausedBy) only the person resumes.
// Owns: these assertions only. Never: real timers, network or a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { scheduleTools } from '../../../src/runtime/tools/builtin/schedule.ts';
import { validate } from '../../../src/runtime/tools/validate.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const H = 3_600_000;

function setup(t: { after(fn: () => void): void }) {
  const f = rpcFixture();
  t.after(f.cleanup);
  f.org.add(agent('ag_ava', 'Ava'));
  f.org.add(agent('ag_bob', 'Bob'));
  f.services.settings.update({ profile: { timezone: 'Europe/Berlin' } });
  const chat = f.chats.create({ agentIds: ['ag_ava', 'ag_bob'], createdBy: 'human' });
  const ctx = (agentId = 'ag_ava') => ({ agent: f.org.get(agentId), runId: 'run_1', conversationId: chat.id, mode: 'general', services: f.services, signal: new AbortController().signal, status() {} }) as unknown as ToolContext;
  const tool = (name: string) => scheduleTools.find((entry) => entry.name === name)!;
  const call = async (name: string, args: Record<string, unknown>, agentId?: string) => {
    const errors = validate(args, tool(name).inputSchema);
    assert.deepEqual(errors, [], `${name} ${JSON.stringify(args)}`);
    return tool(name).run(args, ctx(agentId));
  };
  return { f, chat, tool, call };
}

const out = (result: ToolOutput) => result.structured as { scheduleId: string; rule: string; next: string[]; active: boolean; pausedBy?: string };
const textOf = (result: ToolOutput) => String((result.content[0] as { text: string }).text);

test('message / remind / routine take one when shape and echo the rule and the next runs; one quiet line each', async (t) => {
  const { f, chat, call } = setup(t);
  const daily = await call('schedules.message', { text: 'Standup', when: { repeat: { times: ['09:00', '17:30'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] } } });
  assert.ok(!daily.isError, textOf(daily));
  assert.equal(out(daily).rule, 'daily at 09:00, 17:30 on Mon, Tue, Wed, Thu, Fri');
  assert.equal(out(daily).next.length, 3);
  for (const at of out(daily).next) assert.match(at, /T(09:00|17:30)\+0[12]:00$/, at);
  const stored = f.scheduler.get(out(daily).scheduleId)!;
  assert.deepEqual(stored.spec.times, ['09:00', '17:30']);
  assert.equal(stored.spec.tz, 'Europe/Berlin', 'the profile time zone');
  const once = await call('schedules.remind', { note: 'Check the render', when: { once: '+2h' } });
  assert.deepEqual(out(once).next, [out(once).next[0]]);
  assert.match(out(once).rule, /^once /);
  const routine = await call('schedules.routine', { title: 'Comments', task: { title: 'Answer comments' }, when: { repeat: { every: '1d', count: 7 } } });
  assert.equal(out(routine).rule, 'every 1d · 7 runs in total');
  const lines = f.chats.messages(chat.id).filter((message) => message.kind === 'status' && message.meta.status?.type === 'schedule_created');
  assert.deepEqual(lines.map((line) => line.body), ['Scheduled · Standup', 'Scheduled · Comments'], 'one line per post or routine, none for a reminder');
  assert.equal(lines[0].meta.status?.details?.nextAt, stored.nextAt, 'the line knows the first run');
  assert.equal(lines[0].authorId, 'ag_ava');
});

test('B-050 K10: a scheduled message takes a level like chat.send – silent posts quietly when it fires; urgent stays', async (t) => {
  const { f, chat, call } = setup(t);
  const quiet = out(await call('schedules.message', { text: 'Numbers filed', level: 'silent', when: { once: '+1h' } }));
  assert.deepEqual(f.scheduler.get(quiet.scheduleId)!.payload, { body: 'Numbers filed', silent: true });
  const urgent = out(await call('schedules.message', { text: 'Server down?', urgent: true, when: { once: '+1h' } }));
  assert.equal(f.scheduler.get(urgent.scheduleId)!.payload.priority, 'important', 'the older name');
  const plain = out(await call('schedules.message', { text: 'Standup', level: 'normal', urgent: true, when: { once: '+1h' } }));
  assert.deepEqual(f.scheduler.get(plain.scheduleId)!.payload, { body: 'Standup' }, 'level wins over urgent');
  assert.match(textOf(await call('schedules.list', { mine: true })), /\[message, silent\] Numbers filed/);

  await call('schedules.update', { scheduleId: urgent.scheduleId, level: 'silent' });
  assert.deepEqual(f.scheduler.get(urgent.scheduleId)!.payload, { body: 'Server down?', silent: true }, 'the old level goes');
  const reminder = out(await call('schedules.remind', { note: 'Look', when: { once: '+1h' } }));
  assert.match(textOf(await call('schedules.update', { scheduleId: reminder.scheduleId, level: 'silent' })), /Only a scheduled message has a level/);

  f.scheduler.runNow(quiet.scheduleId);
  const posted = f.chats.messages(chat.id).find((message) => message.kind === 'text' && message.body === 'Numbers filed')!;
  assert.deepEqual([posted.silent, posted.priority, posted.authorId], [true, 'normal', 'ag_ava'], 'posted quietly');
});

test('the old top-level at / cron / everyMinutes are refused; a bad when is answered in plain words', async (t) => {
  const { tool, call } = setup(t);
  assert.ok(validate({ text: 'x', at: '+1h' }, tool('schedules.message').inputSchema).some((line) => /at: unknown property/.test(line)));
  assert.ok(validate({ text: 'x', cron: '0 9 * * *' }, tool('schedules.message').inputSchema).some((line) => /when: required/.test(line)));
  assert.ok(validate({ note: 'x', when: { everyMinutes: 5 } }, tool('schedules.remind').inputSchema).some((line) => /unknown property/.test(line)));
  const both = await call('schedules.remind', { note: 'x', when: { once: '+1h', repeat: { every: '1h' } } });
  assert.ok(both.isError);
  assert.match(textOf(both), /Give when/);
  const past = await call('schedules.message', { text: 'x', when: { once: '2020-01-01T09:00' } });
  assert.match(textOf(past), /That time is in the past/);
});

test('schedules.update pauses, resumes, re-times and rewords; only own schedules or those of managed agents', async (t) => {
  const { f, chat, call } = setup(t);
  const created = out(await call('schedules.message', { text: 'Weekly numbers', when: { repeat: { cron: '0 9 * * 1' } } }));
  const paused = await call('schedules.update', { scheduleId: created.scheduleId, paused: true });
  assert.equal(out(paused).active, false);
  assert.deepEqual(out(paused).next, [], 'paused: no next runs');
  const resumed = out(await call('schedules.update', { scheduleId: created.scheduleId, paused: false, when: { repeat: { times: ['08:15'] } }, text: 'Numbers of the week' }));
  assert.equal(resumed.active, true);
  assert.equal(resumed.rule, 'daily at 08:15');
  assert.equal(resumed.next.length, 3);
  const schedule = f.scheduler.get(created.scheduleId)!;
  assert.equal(schedule.payload.body, 'Numbers of the week');
  assert.equal(schedule.title, 'Numbers of the week');
  const reminder = out(await call('schedules.remind', { note: 'Look again', when: { once: '+3h' } }));
  await call('schedules.update', { scheduleId: reminder.scheduleId, text: 'Look at the numbers' });
  assert.equal(f.scheduler.get(reminder.scheduleId)!.payload.note, 'Look at the numbers');
  const routine = out(await call('schedules.routine', { title: 'Comments', task: { title: 'Answer comments', steps: ['Reply'] }, when: { once: '+1h' } }));
  await call('schedules.update', { scheduleId: routine.scheduleId, text: 'Answer new comments', title: 'New comments' });
  assert.deepEqual(f.scheduler.get(routine.scheduleId)!.payload.taskTemplate, { title: 'Answer new comments', steps: ['Reply'] });
  assert.equal(f.scheduler.get(routine.scheduleId)!.title, 'New comments');
  assert.match(textOf(await call('schedules.update', { scheduleId: created.scheduleId })), /Give paused, when, text, notes, title or level/);
  assert.match(textOf(await call('schedules.update', { scheduleId: created.scheduleId, when: { repeat: { every: 'often' } } })), /Cannot read "every"/);
  assert.match(textOf(await call('schedules.update', { scheduleId: 'sch_missing', paused: true })), /not found/);

  const human = f.scheduler.create({ ownerId: 'human', conversationId: chat.id, kind: 'message', title: 'Mine', spec: { at: f.clock.now() + H }, payload: { body: 'Mine' } });
  assert.match(textOf(await call('schedules.update', { scheduleId: human.id, paused: true })), /Only the owner or its manager/);
  const bobs = out(await call('schedules.remind', { note: 'Bob', when: { once: '+1h' } }, 'ag_bob'));
  assert.equal(out(await call('schedules.update', { scheduleId: bobs.scheduleId, paused: true })).active, false, 'Ava manages Bob here');
  f.org.canManage = () => false;
  assert.match(textOf(await call('schedules.update', { scheduleId: bobs.scheduleId, paused: false })), /Only the owner or its manager/);
  assert.match(textOf(await call('schedules.cancel', { scheduleId: bobs.scheduleId })), /Only the owner or its manager/);
});

test('a schedule the person paused is resumed only by the person; an agent may resume its own pause', async (t) => {
  const { f, call } = setup(t);
  const owner = new TestClient(f.server, OWNER);
  t.after(owner.detach);
  const created = out(await call('schedules.routine', { title: 'Comments', task: { title: 'Answer comments' }, when: { repeat: { every: '1d' } } }));
  await owner.call('schedules.update', { id: created.scheduleId, active: false });
  const stored = f.scheduler.get(created.scheduleId)!;
  assert.equal(stored.pausedBy, 'human', 'who paused it is stored');
  assert.deepEqual(stored.payload, { taskTemplate: { title: 'Answer comments' } }, 'and kept out of the payload');
  const refused = await call('schedules.update', { scheduleId: created.scheduleId, paused: false });
  assert.ok(refused.isError);
  assert.match(textOf(refused), /The person paused this schedule; only they can resume it\./);
  assert.equal(f.scheduler.get(created.scheduleId)!.active, false);
  assert.match(textOf(await call('schedules.list', { mine: true })), /\[routine, paused by the person\] Comments/);
  const retimed = out(await call('schedules.update', { scheduleId: created.scheduleId, when: { repeat: { every: '2d' } } }));
  assert.equal(retimed.active, false, 'a new time does not resume it');
  assert.equal(retimed.pausedBy, 'person');
  await call('schedules.update', { scheduleId: created.scheduleId, paused: true }); // pausing again keeps the person's pause
  assert.equal(f.scheduler.get(created.scheduleId)!.pausedBy, 'human');
  assert.equal((await owner.call<{ active: boolean; pausedBy?: string }>('schedules.update', { id: created.scheduleId, active: true })).active, true);
  assert.equal(f.scheduler.get(created.scheduleId)!.pausedBy, undefined, 'resumed: no pause left');

  assert.equal(out(await call('schedules.update', { scheduleId: created.scheduleId, paused: true })).active, false);
  assert.equal(f.scheduler.get(created.scheduleId)!.pausedBy, 'ag_ava');
  assert.equal(out(await call('schedules.update', { scheduleId: created.scheduleId, paused: false })).active, true, 'its own pause');
  await call('schedules.update', { scheduleId: created.scheduleId, paused: true });
  await owner.call('schedules.update', { id: created.scheduleId, active: false });
  assert.equal(f.scheduler.get(created.scheduleId)!.pausedBy, 'human', 'the person\'s pause always counts');
  assert.match(textOf(await call('schedules.update', { scheduleId: created.scheduleId, paused: false })), /only they can resume it/);
});

test('a pause stored before B-044 (no pausedBy – only the person could pause then) stays the person\'s; an ended schedule may be given a new time', async (t) => {
  const { f, chat, call } = setup(t);
  const created = out(await call('schedules.routine', { title: 'Comments', task: { title: 'Answer comments' }, when: { repeat: { every: '1d' } } }));
  f.scheduler.update(created.scheduleId, { active: false }); // as the RPC stored it before B-044: no one recorded
  assert.equal(f.scheduler.get(created.scheduleId)!.pausedBy, undefined);
  assert.match(textOf(await call('schedules.update', { scheduleId: created.scheduleId, paused: false })), /only they can resume it/);
  assert.equal(f.scheduler.get(created.scheduleId)!.active, false);
  const past = f.scheduler.create({ ownerId: 'ag_ava', conversationId: chat.id, kind: 'reminder', title: 'Look', spec: { at: f.clock.now() - H }, payload: { note: 'Look' } });
  f.scheduler.update(past.id, { active: false }); // its one time has passed: ended, not paused
  const revived = out(await call('schedules.update', { scheduleId: past.id, paused: false, when: { once: '+1h' } }));
  assert.equal(revived.active, true);
  assert.equal(revived.next.length, 1);
});

test('a manager lists its team\'s schedules with a routine\'s notes and changes those notes (B-072: a stale rule in a report\'s routine)', async (t) => {
  const { f, call } = setup(t);
  const bobs = out(await call('schedules.routine', { title: 'Deadline check', task: { title: 'Check the deadline', notes: 'Do not run a declined command another way.\nCheck the shipping list.' }, when: { once: '+1h' } }, 'ag_bob'));
  const listed = textOf(await call('schedules.list', {}));
  assert.ok(listed.includes(`${bobs.scheduleId} [routine] Deadline check`) && listed.includes(' · of Bob\n  notes: Do not run a declined command another way.'), listed);
  assert.doesNotMatch(textOf(await call('schedules.list', { mine: true })), /Deadline check/, 'mine: only Ava\'s own');
  await call('schedules.update', { scheduleId: bobs.scheduleId, notes: 'Check the shipping list.' });
  assert.deepEqual(f.scheduler.get(bobs.scheduleId)!.payload.taskTemplate, { title: 'Check the deadline', notes: 'Check the shipping list.' });
  await call('schedules.update', { scheduleId: bobs.scheduleId, notes: '' });
  assert.deepEqual(f.scheduler.get(bobs.scheduleId)!.payload.taskTemplate, { title: 'Check the deadline' }, '"" clears the notes');
  const reminder = out(await call('schedules.remind', { note: 'Look', when: { once: '+2h' } }));
  assert.match(textOf(await call('schedules.update', { scheduleId: reminder.scheduleId, notes: 'x' })), /Only a routine has task notes/);
  f.org.canManage = () => false;
  assert.doesNotMatch(textOf(await call('schedules.list', {})), /Deadline check/, 'not managed: not listed');
});
