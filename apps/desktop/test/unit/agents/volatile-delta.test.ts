// B-049 F6 – volatile deltas: a resumed native session gets only the volatile sections that changed since its last
// finished turn (agents/volatile-delta.ts), with one line naming the unchanged ones and one the sections no longer
// current; a new, renewed or rebuilt session gets them all. Unit cases on volatileDelta and its kv state, then the real
// turn path (TurnExecutor, the real context service, a recording Codex-like engine with sessions): new session full,
// resumed + unchanged, resumed + changed, a failed turn records nothing, a renewed session full again.
// Owns: these assertions only. Never: real engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, model } from '../context/fixture.ts';
import { account } from '../models/harness.ts';
import { TurnExecutor } from '../../../src/runtime/agents/turn.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { forgetSent, recordSent, sectionTitle, sentTo, volatileDelta, type VolatileSection } from '../../../src/runtime/agents/volatile-delta.ts';
import type { Engine, EngineCaps, EngineTurnInput, EngineTurnResult } from '../../../src/runtime/engines/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { ModelInfo, RouteDecision } from '../../../src/shared/model/providers.ts';

const s = (name: string, text: string): VolatileSection => ({ name, text });
const NOW_1 = s('now', '## Now\nThu 29 Oct 2026, 10:00');
const NOW_2 = s('now', '## Now\nThu 29 Oct 2026, 10:05');
const PERMS = s('permissions', '## Permissions\nStandard: internal work is free.');
const CHAT = s('chat', '## This chat\nDesk (c_1) · 1:1 chat with Alex');
const TASK = s('task', '## Current task\nTitle: Cut the video');
const PINNED = s('pinned', '## Pinned memory (notes that always apply; I check them against the current state)\n- Brand: blue');

test('volatileDelta: a new session gets every section', () => {
  const all = volatileDelta([NOW_1, PERMS, CHAT], undefined);
  assert.equal(all.text, [NOW_1, PERMS, CHAT].map((part) => part.text).join('\n\n'));
  assert.deepEqual(Object.keys(all.sections), ['now', 'permissions', 'chat']);
  assert.equal(sectionTitle(PINNED), 'Pinned memory');
  assert.equal(sectionTitle(s('x', 'no header')), 'no header');
});

test('volatileDelta: resumed – only changed sections in full, one line for the unchanged, one for the ones no longer current', () => {
  const first = volatileDelta([NOW_1, PERMS, CHAT, TASK], undefined);
  const unchanged = volatileDelta([NOW_2, PERMS, CHAT, TASK], first.sections);
  assert.equal(unchanged.text, `${NOW_2.text}\n\nUnchanged since my last turn: Permissions, This chat, Current task.`);
  const changedPerms = s('permissions', '## Permissions\nFull autonomy: this PC belongs to the AI team.');
  const changed = volatileDelta([NOW_2, changedPerms, CHAT, PINNED], unchanged.sections);
  assert.equal(changed.text, [changedPerms.text, PINNED.text, 'Unchanged since my last turn: Now, This chat.\nNo longer current: Current task.'].join('\n\n'));
  assert.ok(!changed.text.includes('Standard: internal'), 'the old permissions are not repeated');
  assert.deepEqual(Object.keys(changed.sections), ['now', 'permissions', 'chat', 'pinned']);
  const again = volatileDelta([NOW_2, changedPerms, CHAT, PINNED], changed.sections);
  assert.equal(again.text, 'Unchanged since my last turn: Now, Permissions, This chat, Pinned memory.');
});

test('volatileDelta: a section whose builder threw keeps its last record – not "no longer current", not shown', () => {
  const first = volatileDelta([NOW_1, PERMS, PINNED], undefined);
  const broken = volatileDelta([NOW_2, PERMS, { name: 'pinned', text: '', failed: true }], first.sections);
  assert.equal(broken.text, `${NOW_2.text}\n\nUnchanged since my last turn: Permissions.`);
  assert.deepEqual(broken.sections.pinned, first.sections.pinned, 'the session still holds the pinned memory it got');
  const back = volatileDelta([NOW_2, PERMS, PINNED], broken.sections);
  assert.ok(back.text.includes('Unchanged since my last turn: Now, Permissions, Pinned memory.'));
  const fresh = volatileDelta([NOW_1, { name: 'pinned', text: '', failed: true }], undefined);
  assert.equal(fresh.text, NOW_1.text, 'a new session gets no empty failed section');
  assert.deepEqual(Object.keys(fresh.sections), ['now']);
});

test('sentTo / recordSent: per agent, chat and engine, bound to the session ref', () => {
  const f = fixture();
  const key = { agentId: 'ag_1', conversationId: 'c_1', engine: 'codex' as const };
  assert.equal(sentTo(f.db, key, 'thr_1'), undefined);
  recordSent(f.db, key, 'thr_1', { now: { hash: 'a', title: 'Now' } }, 1);
  assert.deepEqual(sentTo(f.db, key, 'thr_1'), { now: { hash: 'a', title: 'Now' } });
  assert.equal(sentTo(f.db, key, 'thr_2'), undefined, 'another session ref holds nothing of it');
  assert.equal(sentTo(f.db, { ...key, engine: 'claude' }, 'thr_1'), undefined);
  assert.equal(sentTo(f.db, { ...key, conversationId: 'c_2' }, 'thr_1'), undefined);
});

const COMPUTER_MODE: ModeInfo = {
  key: 'computer', name: 'Computer', description: 'Work on the screen of a PC.', skills: [], tools: ['*'], category: 'computer-use',
  workspace: 'computer', instructions: '# Computer mode\n\nLook at the screen before every click.',
};

function setup() {
  const f = fixture();
  const vic = f.vid;
  const chat = f.chats.create({ title: 'Desk', agentIds: [vic.id], createdBy: 'human' });
  const calls: EngineTurnInput[] = [];
  const state: { fail?: boolean; compact?: boolean; sessions: number } = { sessions: 0 };
  const caps: EngineCaps = { sessions: true, dynamicTools: true, mcp: false, images: false, rebase: true, structured: false, ownTools: true };
  const engine = {
    id: 'codex', caps,
    async run(input: EngineTurnInput): Promise<EngineTurnResult> {
      calls.push(input);
      const session = input.session ?? { ref: `codex-s${++state.sessions}`, generation: 1 };
      if (state.fail) return { text: '', stop: 'error', session, error: { code: 'internal', message: 'model error' } };
      return { text: `answer ${calls.length}`, stop: 'done', session, ...(state.compact ? { compacted: true } : {}) };
    },
  } as unknown as Engine;
  const models = new Map<string, ModelInfo>([['codex:sol', model('codex:sol', 'frontier', 'GPT Sol')]]);
  const route: RouteDecision = { modelId: 'codex:sol', engine: 'codex', accountId: 'acc_codex', effort: 'medium', category: 'chat', reason: 'test', by: 'rules', alternatives: [] };
  const acc = account('acc_codex', 'codex');
  const modes = new Map([[GENERAL_MODE.key, GENERAL_MODE], [COMPUTER_MODE.key, COMPUTER_MODE]]);
  Object.assign(f.services, {
    modes: { get: (key: string) => { const mode = modes.get(key); if (!mode) throw new Error(`unknown mode ${key}`); return mode; }, list: () => [...modes.values()] },
    router: { route: async () => route },
    engines: { get: () => engine },
    accounts: { get: (id: string) => (id === acc.id ? acc : undefined), markLimited: () => {}, updateLimits: () => {} },
    catalog: { get: (id: string) => models.get(id), list: () => [...models.values()] },
    subconscious: {},
    tools: { get: () => undefined, specsFor: () => [], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  });
  let runs = 0;
  return {
    ...f, vic, chat, calls, state,
    send: (body: string) => f.chats.send({ conversationId: chat.id, body, authorId: 'human' }),
    turn: () => new TurnExecutor(() => f.services).execute({
      runId: `run_${++runs}`, agentId: vic.id, conversationId: chat.id, reason: 'message', notes: [],
      signal: new AbortController().signal, control: { lastSeq: 0, steeredSeq: 0 },
    }),
  };
}

const volatileOf = (input: EngineTurnInput) => input.system.volatile;

test('turn path: new session full; resumed only what changed; a failed turn records nothing; a renewed session full again', async () => {
  const h = setup();
  h.send('Hello');
  assert.equal((await h.turn()).status, 'done');
  const first = volatileOf(h.calls[0]);
  assert.equal(h.calls[0].session, undefined);
  for (const header of ['## Now', '## This chat']) assert.ok(first.includes(header), `new session: ${header}`);
  assert.ok(!first.includes('Unchanged since my last turn'));

  h.clock.advance(5 * 60_000);
  h.send('Next');
  await h.turn();
  const resumed = volatileOf(h.calls[1]);
  assert.equal(h.calls[1].session?.ref, 'codex-s1');
  assert.ok(resumed.includes('## Now'), 'the time changed');
  assert.ok(!resumed.includes('## This chat'), resumed);
  assert.match(resumed, /Unchanged since my last turn: [^\n]*This chat/);
  assert.ok(resumed.includes('My final text'), 'the publishing line goes every turn');
  assert.ok(resumed.length < first.length);

  h.tasks.create({ conversationId: h.chat.id, title: 'Cut the launch video', assigneeKind: 'agent', assigneeId: h.vic.id, createdBy: 'human' });
  h.state.fail = true;
  h.send('And?');
  await h.turn();
  const failed = volatileOf(h.calls[2]);
  assert.match(failed, /## My open tasks and promises\n- [^\n]*Cut the launch video/, 'a changed section goes in full');
  h.state.fail = false;
  h.send('Again');
  await h.turn();
  assert.match(volatileOf(h.calls[3]), /## My open tasks and promises/, 'the failed turn recorded nothing: sent again');
  h.send('Once more');
  await h.turn();
  assert.ok(!volatileOf(h.calls[4]).includes('## My open tasks and promises'), 'held after a finished turn');
  assert.match(volatileOf(h.calls[4]), /Unchanged since my last turn: [^\n]*My open tasks and promises/);

  h.chats.update(h.chat.id, { settings: { mode: 'computer' } }, 'human');
  h.send('Take a screenshot');
  await h.turn();
  const renewed = h.calls[5];
  assert.equal(renewed.session, undefined, 'a renewed (new) session');
  for (const header of ['## Now', '## This chat', '## My open tasks and promises']) assert.ok(volatileOf(renewed).includes(header), `renewed: ${header}`);
  assert.ok(!volatileOf(renewed).includes('Unchanged since my last turn'));
});

test('turn path: after the engine compacted the session (result.compacted) the next turn gets every section again', async () => {
  const h = setup();
  h.send('Hello');
  await h.turn();
  h.send('Next');
  await h.turn();
  assert.match(volatileOf(h.calls[1]), /Unchanged since my last turn: [^\n]*This chat/, 'resumed: a delta');

  h.state.compact = true; // a long turn: the engine compacted its history, the earlier context blocks may be gone
  h.send('A long job');
  assert.equal((await h.turn()).status, 'done');
  assert.equal(sentTo(h.db, { agentId: h.vic.id, conversationId: h.chat.id, engine: 'codex' }, 'codex-s1'), undefined, 'nothing recorded after a compaction');
  h.state.compact = false;
  h.send('And now?');
  await h.turn();
  const after = h.calls[3];
  assert.equal(after.session?.ref, 'codex-s1', 'the same session resumes');
  for (const header of ['## Now', '## This chat']) assert.ok(volatileOf(after).includes(header), `after compaction: ${header}`);
  assert.ok(!volatileOf(after).includes('Unchanged since my last turn'), volatileOf(after));
  h.send('Then');
  await h.turn();
  assert.match(volatileOf(h.calls[4]), /Unchanged since my last turn: [^\n]*This chat/, 'recorded again after a finished turn: deltas resume');
});

test('forgetSent: drops the record of that key only', () => {
  const f = fixture();
  const key = { agentId: 'ag_1', conversationId: 'c_1', engine: 'codex' as const };
  const other = { ...key, conversationId: 'c_2' };
  recordSent(f.db, key, 'thr_1', { now: { hash: 'a', title: 'Now' } }, 1);
  recordSent(f.db, other, 'thr_2', { now: { hash: 'b', title: 'Now' } }, 1);
  forgetSent(f.db, key);
  assert.equal(sentTo(f.db, key, 'thr_1'), undefined);
  assert.deepEqual(sentTo(f.db, other, 'thr_2'), { now: { hash: 'b', title: 'Now' } });
});
