// B-057 R1-4 and S17 – what an agent's own turns are told about splitting. The 'splits' section (context/split-section.ts
// activeSplitsLine, from SplitService.activeOn): its groups still at work on this thread (pending or running, newest
// first, at most 3) with "k of N done, j running"; absent without such groups (the volatile prompt stays as it was), on
// other threads and for a split's own turn. S17 as the owner set it on 30.10.2026: splitting is the agent's own choice –
// one environment line names it, a message that suggested Ultra carries a short note, and no section is a standing rule.
// Owns: these checks. Never: an engine or the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitThread } from '../../../src/shared/model/splits.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { ACTIVE_HEADER, ULTRA_NOTE, activeSplitsLine, ultraNote } from '../../../src/runtime/context/split-section.ts';
import { splitLine } from '../../../src/runtime/context/environment.ts';
import { volatileSections } from '../../../src/runtime/context/prompt-volatile.ts';
import { CHAT, part, splitAndEnd, world, type World } from './fixture.ts';

const TAIL = 'Their results come to me when all their parts have ended.';
const AVA = { id: 'ag_ava', name: 'Ava' } as Agent;

/** The volatile sections of Ava's turn on `thread` (only the split service and the chat are real here – the rest is skipped). */
function sections(w: World, thread: string) {
  const services = { splits: w.splits, chats: w.services.chats, clock: w.clock, log: { debug() {} } } as unknown as RuntimeServices;
  return volatileSections(services, { agent: AVA, conversationId: thread === CHAT ? CHAT : undefined, thread, route: { modelId: 'codex:gpt-6.1-sol', effort: 'high' } as never });
}

test('the line names the groups still at work on this thread with the right counts', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B'), part('C')], 'Review the release');
  const [a, b] = w.lanes.started;
  assert.deepEqual(w.splits.activeOn('ag_ava', CHAT), [{ id: groupId, goal: 'Review the release', status: 'running', parts: 3, done: 0, running: 3, ended: 0 }]);
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT), `${ACTIVE_HEADER}\nStill at work: group ${groupId} "Review the release" – 0 of 3 done, 3 running. ${TAIL}`);
  w.lanes.end(a, 'done', { answer: 'A' });
  w.lanes.end(b, 'failed', { error: 'The part failed.' });
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT), `${ACTIVE_HEADER}\nStill at work: group ${groupId} "Review the release" – 1 of 3 done, 1 running, 1 did not finish. ${TAIL}`);

  // A second group, split by a turn that has not ended yet: newest first.
  w.runs.start({ id: 'run_two', agentId: 'ag_ava', conversationId: CHAT, trigger: 'message' });
  const pending = w.splits.create(w.ctx({ runId: 'run_two' }), { goal: 'Check the docs', parts: [part('D'), part('E')] });
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT),
    `${ACTIVE_HEADER}\nStill at work: group ${pending.id} "Check the docs" – 2 parts, not started yet; group ${groupId} "Review the release" – 1 of 3 done, 1 running, 1 did not finish. ${TAIL}`);
  assert.equal(w.splits.activeOn('ag_ava', CHAT, 1).length, 1, 'bounded');

  // Not there: other threads, other agents, a split's own thread.
  assert.equal(activeSplitsLine(w.services, 'ag_ava', 'task:task_1'), '');
  assert.equal(activeSplitsLine(w.services, 'ag_ben', CHAT), '');
  assert.equal(activeSplitsLine(w.services, 'ag_ava', splitThread(a)), '');
  assert.equal(activeSplitsLine(w.services, 'ag_ava', undefined), '');
  assert.equal(activeSplitsLine({} as RuntimeServices, 'ag_ava', CHAT), '', 'no split service wired');
});

test('a settled group leaves the line (its results come as the "Split results" block instead)', () => {
  const w = world();
  splitAndEnd(w, [part('A')]);
  assert.notEqual(activeSplitsLine(w.services, 'ag_ava', CHAT), '');
  w.lanes.end(w.lanes.started[0], 'done', { answer: 'A' });
  assert.deepEqual(w.splits.activeOn('ag_ava', CHAT), []);
  assert.equal(activeSplitsLine(w.services, 'ag_ava', CHAT), '');
});

test('the volatile prompt: a "splits" section in the agent\'s own turn while groups work there, none otherwise or in a split\'s turn', () => {
  const w = world();
  assert.equal(sections(w, CHAT).some((section) => section.name === 'splits'), false, 'no groups: the prompt is as before');
  const groupId = splitAndEnd(w, [part('A'), part('B')]);
  const own = sections(w, CHAT).find((section) => section.name === 'splits');
  assert.match(own?.text ?? '', new RegExp(`^${ACTIVE_HEADER}\\nStill at work: group ${groupId} "Review the release" – 0 of 2 done, 2 running\\.`));
  const inSplit = sections(w, splitThread(w.lanes.started[0]));
  assert.ok(inSplit.some((section) => section.name === 'split'), 'the split\'s own section');
  assert.equal(inSplit.some((section) => section.name === 'splits'), false, 'a split is not told about its own group as work of its own');
});

test('Ultra is a choice, never a rule: one environment line, a short note on a message that suggested it', () => {
  // Owner 30.10.2026: "Ultra ist ein Modus, dass der Agent selber wählen kann … nur eine Möglichkeit, die die KI nutzen kann."
  const line = splitLine(new Set(['agents.split', 'tools.find']));
  assert.match(line, /^Splitting: I need not do everything myself/);
  assert.match(line, /I can split myself into parallel parts \(agents\.split\); whether and when is my call\.$/);
  assert.ok(line.length <= 200, `one short line (${line.length} characters)`);
  assert.equal(splitLine(new Set(['tools.find'])), '', 'only where the agent may split');
  // Live round D: Codex offers its own collaboration tools in every thread and used them when asked to split.
  const codex = splitLine(new Set(['agents.split', 'tools.find']), 'codex');
  assert.ok(codex.startsWith(line), 'the same choice first');
  assert.match(codex, /Codex's own collaboration tools \(spawn_agent, followup_task, send_message, wait_agent, interrupt_agent, list_agents\) stay outside this app's journal and costs, so I leave them unused – my parallel work goes through agents\.split\.$/);
  assert.equal(splitLine(new Set(['agents.split']), 'claude'), line, 'other engines: the line alone');
  assert.match(splitLine(new Set(['tools.find']), 'codex'), /^Codex's own collaboration tools .* leave them unused\.$/, 'without agents.split: only the warning');
  assert.equal(ultraNote({ authorKind: 'human', meta: { ultra: true } }), ` ${ULTRA_NOTE}`);
  assert.equal(ultraNote({ authorKind: 'human', meta: {} }), '');
  assert.equal(ultraNote({ authorKind: 'agent', meta: { ultra: true } }), '', 'never on an agent\'s line');
  assert.equal(ultraNote({}), '');
  assert.match(ULTRA_NOTE, /^\(Ultra suggested: .*agents\.split.* – whether I split is my call\)$/);
  assert.ok(ULTRA_NOTE.length <= 130, `a short note (${ULTRA_NOTE.length} characters)`);
  for (const text of [line, ULTRA_NOTE]) assert.doesNotMatch(text, /\b(must|rule|always|every substantive|first action)\b/i, 'no obligation');
  assert.equal(sections(world(), CHAT).some((section) => section.name === 'ultra' || /## Ultra/.test(section.text)), false, 'no Ultra section in the volatile prompt');
});
