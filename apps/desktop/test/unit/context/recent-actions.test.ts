// Continuation across engines (PR3, context/recent-actions.ts): the tool calls of unfinished runs
// since the agent's last done run in this chat reach a turn as "Previous attempt (not visible in
// the chat)" only when its engine cannot know them (another engine or account, a new session, a
// stateless engine); unknown effects say "I verify before repeating"; summaries are redacted and
// bounded; a turn fails over once after tool calls only when every effect is known – and the
// continuation on the other account gets the recap.
// Owns: these assertions only. Never: a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectsKnown, needsRecap, RECAP_LIMITS, RECAP_TITLE, recapText, recentActions } from '../../../src/runtime/context/recent-actions.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { buildTurn, planTurn } from '../../../src/runtime/agents/turn-prepare.ts';
import { canFailover } from '../../../src/runtime/agents/turn-attempt.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import type { RouteRequest, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { RunItem } from '../../../src/shared/model/runs.ts';
import { setup } from '../agents/fixture.ts';

const LIMIT: EngineTurnResult = { text: '', stop: 'limit', error: { code: 'rate_limited', message: 'The usage limit of this account was reached.' } };

function journalSetup(caps: Parameters<typeof setup>[0] = {}) {
  const h = setup(caps);
  const runs = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const secrets = { redact: (text: string) => text.replaceAll('hunter2', 'secret://sec_pw') };
  Object.assign(h.services, { runs, secrets });
  const call = (runId: string, name: string, summary: string, effectStatus: RunItem['effectStatus'], extra: Record<string, unknown> = {}) =>
    runs.item(runId, { kind: 'tool_call', name, data: { callId: `${runId}:${name}:${summary.length}`, summary, ...extra }, effectStatus });
  /** One finished run of Tom in this chat with the given calls. */
  const past = (id: string, status: 'done' | 'failed' | 'interrupted' | 'unknown', engine: string, accountId: string, calls: Array<[string, string, RunItem['effectStatus']]> = [], conversationId = h.chat.id) => {
    runs.start({ id, agentId: h.tom.id, conversationId, trigger: 'message' });
    for (const [name, summary, effect] of calls) call(id, name, summary, effect);
    runs.finish(id, { status, engine: engine as never, accountId });
    h.clock.advance(1000);
  };
  return { ...h, runs, call, past, services: h.services as RuntimeServices };
}

test('the unfinished runs since the last done one in this chat, with their outcomes; other chats stay out', () => {
  const h = journalSetup();
  const other = h.chats.create({ agentIds: [h.tom.id], createdBy: 'human' });
  h.past('run_a', 'failed', 'codex', 'acc_x', [['shell.exec', 'npm publish (old)', 'unknown']]);
  h.past('run_b', 'done', 'codex', 'acc_x', [['tasks.create', 'Create task "Draft"', 'none']]);
  h.past('run_c', 'failed', 'codex', 'acc_x', [['browser.act', 'click Buy (shop.example)', 'confirmed'], ['shell.exec', 'deploy.sh', 'unknown'], ['email.send', 'Send to ana@example.com', 'failed']]);
  h.past('run_o', 'failed', 'codex', 'acc_x', [['shell.exec', 'other chat', 'unknown']], other.id);
  h.runs.start({ id: 'run_now', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  h.runs.item('run_now', { kind: 'tool_call', name: 'bash', data: { callId: 'own_1', own: true, args: { command: 'ls' } }, effectStatus: 'none' });
  h.runs.item('run_now', { kind: 'tool_call', name: 'bash', data: { callId: 'own_2', own: true, args: { command: 'rm -rf build' } }, effectStatus: 'none' });
  h.runs.item('run_now', { kind: 'tool_result', data: { callId: 'own_1', ok: true, summary: 'listed' }, effectStatus: 'none' });

  const actions = recentActions(h.services, { agentId: h.tom.id, conversationId: h.chat.id }, 'run_now');
  assert.deepEqual(actions.map((action) => [action.runId, action.tool, action.outcome]), [
    ['run_c', 'browser.act', 'done'], ['run_c', 'shell.exec', 'unknown'], ['run_c', 'email.send', 'failed'],
    ['run_now', 'bash', 'done'], ['run_now', 'bash', 'unknown'],
  ], 'stops at the last done run; an engine call without a result is unknown');
  assert.equal(actions[0].engine, 'codex');
  assert.match(actions[4].text, /rm -rf build/);
  assert.deepEqual(recentActions(h.services, { agentId: h.tom.id }), [], 'no chat and no task: nothing');
  assert.equal(effectsKnown(h.services, 'run_c'), false);
  assert.equal(effectsKnown(h.services, 'run_now'), false);
});

test('our internal tools (effect "none") are judged by their result: none is unknown, ok:false failed (regression)', () => {
  const h = journalSetup();
  h.runs.start({ id: 'run_cut', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'task' });
  const result = (callId: string, ok: boolean) => h.runs.item('run_cut', { kind: 'tool_result', name: 'x', data: { callId, ok }, effectStatus: 'none' });
  h.runs.item('run_cut', { kind: 'tool_call', name: 'shell.exec', data: { callId: 'c1', summary: 'Run: npm run deploy', category: 'write_system' }, effectStatus: 'none' });
  h.runs.item('run_cut', { kind: 'tool_call', name: 'files.write', data: { callId: 'c2', summary: 'Write notes.md', category: 'write_local' }, effectStatus: 'none' });
  result('c2', false);
  h.runs.item('run_cut', { kind: 'tool_call', name: 'files.write', data: { callId: 'c3', summary: 'Write plan.md', category: 'write_local' }, effectStatus: 'none' });
  result('c3', true);
  h.runs.finish('run_cut', { status: 'interrupted' });

  const actions = recentActions(h.services, { agentId: h.tom.id, conversationId: h.chat.id });
  assert.deepEqual(actions.map((action) => [action.tool, action.outcome]), [['shell.exec', 'unknown'], ['files.write', 'failed'], ['files.write', 'done']]);
  assert.match(recapText(actions, 'UTC')!, /shell\.exec: Run: npm run deploy → effect unknown – I verify before repeating/, 'a cut-off command is never reported done');
  assert.equal(effectsKnown(h.services, 'run_cut'), false, 'no failover over a command without its result');
  result('c1', true);
  assert.equal(effectsKnown(h.services, 'run_cut'), true);
});

test('the recap is needed only when the running engine cannot know the calls', () => {
  const actions = [{ at: 0, runId: 'r', engine: 'codex', accountId: 'acc_1', tool: 'shell.exec', text: 'x', outcome: 'done' as const }];
  const same = { engine: 'codex', accountId: 'acc_1', sessionNew: false, stateless: false };
  assert.equal(needsRecap(actions, same), false, 'the same session already knows');
  assert.equal(needsRecap(actions, { ...same, engine: 'claude' }), true, 'another engine');
  assert.equal(needsRecap(actions, { ...same, accountId: 'acc_2' }), true, 'another account');
  assert.equal(needsRecap(actions, { ...same, sessionNew: true }), true, 'a new session');
  assert.equal(needsRecap(actions, { ...same, stateless: true }), true, 'a stateless engine');
  assert.equal(needsRecap([], { ...same, engine: 'claude' }), false, 'nothing to tell');
});

test('the recap flags unknown effects, is redacted and stays within 15 lines and 3000 characters', () => {
  const h = journalSetup();
  h.runs.start({ id: 'run_1', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  h.call('run_1', 'browser.act', 'fill password with hunter2 on shop.example', 'confirmed');
  h.call('run_1', 'shell.exec', 'npm publish', 'pending');
  const text = recapText(recentActions(h.services, { agentId: h.tom.id, conversationId: h.chat.id }, 'run_1'), 'UTC')!;
  const lines = text.split('\n');
  assert.equal(lines[0], RECAP_TITLE);
  assert.match(lines[1], /^- \d\d:\d\d browser\.act: fill password with secret:\/\/sec_pw on shop\.example → done$/);
  assert.match(lines[2], /shell\.exec: npm publish → effect unknown – I verify before repeating$/);
  assert.ok(!text.includes('hunter2'));

  for (let i = 0; i < 30; i++) h.call('run_1', 'web.fetch', `fetch page ${i} ${'x'.repeat(170)}`, 'none');
  const long = recapText(recentActions(h.services, { agentId: h.tom.id, conversationId: h.chat.id }, 'run_1'), 'UTC')!;
  const longLines = long.split('\n');
  assert.ok(long.length <= RECAP_LIMITS.chars, `${long.length} characters`);
  assert.ok(longLines.length - 2 <= RECAP_LIMITS.lines);
  assert.match(longLines[1], /^\(\d+ earlier actions not shown\)$/);
  assert.match(longLines.at(-1)!, /fetch page 29/, 'the newest are kept');
});

test('buildTurn adds the recap on another engine or a new session, not to the session that ran it', async () => {
  const h = journalSetup({ sessions: true });
  h.past('run_0', 'failed', 'claude', h.account.id, [['browser.act', 'click Pay (shop.example)', 'unknown']]);
  h.runs.start({ id: 'run_1', agentId: h.tom.id, conversationId: h.chat.id, trigger: 'message' });
  const sessions = new SessionStore(h.db);
  sessions.save({ agentId: h.tom.id, conversationId: h.chat.id, engine: 'claude', accountId: h.account.id, ref: 'thread_1', generation: 1, cursorSeq: 0, updatedAt: h.clock.now() });
  const inputOf = async () => {
    const plan = (await planTurn(h.services, h.request()))!;
    const turn = await buildTurn(h.services, plan, h.request(), h.route, []);
    return (turn.input[0] as { text: string }).text;
  };
  assert.ok(!(await inputOf()).includes(RECAP_TITLE), 'the same Claude session knows what it did');

  h.runs.finish('run_0', { status: 'failed', engine: 'codex' as never, accountId: 'acc_codex' });
  const elsewhere = await inputOf();
  assert.ok(elsewhere.includes(RECAP_TITLE), 'it ran on Codex');
  assert.match(elsewhere, /browser\.act: click Pay \(shop\.example\) → effect unknown – I verify before repeating/);
  assert.ok(h.runs.items('run_1').some((item) => item.kind === 'note' && item.data.previousAttempt === 1), 'journaled');

  h.runs.finish('run_0', { status: 'failed', engine: 'claude' as never, accountId: h.account.id });
  sessions.remove(h.tom.id, h.chat.id, 'claude');
  assert.ok((await inputOf()).includes(RECAP_TITLE), 'a new session does not know it either');
});

test('a limit after tool calls fails over once when every effect is known – the continuation gets the recap', async () => {
  const h = journalSetup();
  const inputs: Record<string, string[]> = {};
  const effect: { status: RunItem['effectStatus'] } = { status: 'confirmed' };
  h.state.script = async (input) => {
    (inputs[input.account.id] ??= []).push((input.input[0] as { text: string }).text);
    if (input.account.id === 'acc_1') {
      input.onEvent({ type: 'tool_start', callId: 'toolu_1', name: 'tasks.create', args: {}, own: false });
      h.call(input.runId, 'tasks.create', 'Create task "Draft the post"', effect.status); // what the registry journals
      return LIMIT;
    }
    return LIMIT; // the second account is used up too: no second failover
  };
  Object.assign(h.services, {
    accounts: { get: (id: string) => ({ ...h.account, id }), updateLimits: () => {}, markLimited: () => {}, candidates: () => [] },
    router: { route: async (request: RouteRequest) => ({ ...h.route, accountId: request.exclude?.includes('acc_1') ? (request.exclude.includes('acc_2') ? 'acc_3' : 'acc_2') : 'acc_1' }) },
  });
  const failovers = (runId: string) => h.runs.items(runId).filter((item) => item.kind === 'note' && item.data.failover).map((item) => item.data.failover);

  await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_known' }));
  assert.deepEqual(Object.keys(inputs), ['acc_1', 'acc_2'], 'one failover, not two');
  assert.match(inputs.acc_2[0], /Previous attempt \(not visible in the chat\):\n- \d\d:\d\d tasks\.create: Create task "Draft the post" → done/);
  assert.deepEqual(failovers('run_known'), [{ from: h.route.modelId, fromAccount: 'acc_1', to: h.route.modelId, toAccount: 'acc_2', reason: 'limit', afterTools: 1 }]);

  effect.status = 'unknown';
  for (const key of Object.keys(inputs)) delete inputs[key];
  h.clock.advance(1000);
  await new TurnExecutor(() => h.services).execute(h.request({ runId: 'run_unknown' }));
  assert.deepEqual(Object.keys(inputs), ['acc_1'], 'an unknown effect is never re-run elsewhere');
  assert.deepEqual(failovers('run_unknown'), []);
  assert.equal(canFailover({ result: LIMIT, streamed: '', reasoning: '', toolCalls: 1, usage: { inputTokens: 0, outputTokens: 0 }, ms: 1 }, new AbortController().signal), false, 'tool calls without known effects');
});
