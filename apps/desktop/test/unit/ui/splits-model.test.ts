// B-057 S18 – splits in the UI: the words of split rows (splits/split-text.ts: "Split · 3 of 5 done", "3 of 5 parts
// working", "#3 title", model · effort, status icon kinds, durations), the selectors the views share (sidebar groups,
// a parent run's groups and which one belongs to which agents.split call, a chat's running groups, running splits per
// agent), the store (splits/split-model.ts: applying groups, shared reads), the chat's live texts (one line and one
// popover row per group, never one per split; no live block per split run) and the split route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import type { SplitGroupView, SplitStatus, SplitView } from '../../../src/shared/model/splits.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import {
  RECENT_MS, SIDEBAR_GROUPS, changedAgents, chatGroups, elapsedText, groupCounts, groupDone, groupForCall, groupWorking, isActiveGroup, isLiveGroup,
  partLabel, partOf, runGroups, runningByAgent, sidebarGroups, splitDuration, splitIconKind, splitModelText, splitRunKeys, tokensText,
} from '../../../src/ui/splits/split-text.ts';
import { applyGroup, applyGroups, findSplit, groupsOfRun, loadSplits, splitGroups } from '../../../src/ui/splits/split-model.ts';
import { liveStatus, workingIds, workingRows } from '../../../src/ui/chat/live-text.ts';
import { liveWork } from '../../../src/ui/chat/message-rows.ts';
import { formatRoute, parseRoute } from '../../../src/ui/lib/router.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import { activity } from '../../../src/ui/lib/store.ts';
import { liveByAgent, runningSplits } from '../../../src/ui/team/org-state.ts';

const NOW = 1_800_000_000_000;

function split(idx: number, status: SplitStatus, patch: Partial<SplitView> = {}): SplitView {
  return {
    id: `sp_${idx}`, groupId: 'sg_1', agentId: 'ag_mira', idx, of: 5, title: `Part ${idx}`, brief: 'Do it', context: 'fork', after: [],
    worktree: false, status, attempts: 0, createdAt: NOW, runs: 0, ...patch,
  };
}

function group(id: string, patch: Partial<SplitGroupView> = {}): SplitGroupView {
  return {
    id, agentId: 'ag_mira', parentRunId: 'run_p', conversationId: 'c1', thread: 'c1', goal: 'Review the code', ultra: false,
    status: 'running', parts: 5, createdAt: NOW, splits: [split(1, 'done'), split(2, 'running')], ...patch,
  };
}

const activityEntry = (runId: string, patch: Partial<AgentActivity> = {}): AgentActivity => ({ agentId: 'ag_mira', runId, conversationId: 'c1', note: '', startedAt: NOW, ...patch });
const splitEntry = (runId: string, groupId: string, idx: number, patch: Partial<AgentActivity> = {}): AgentActivity =>
  activityEntry(runId, { split: { id: `sp_${idx}`, groupId, idx, of: 5, parentRunId: 'run_p', title: `Part ${idx}` }, ...patch });

test('the step line, the live line and the part labels', () => {
  const five = group('sg_1', { splits: [split(1, 'done'), split(2, 'done'), split(3, 'done'), split(4, 'running'), split(5, 'queued')] });
  assert.equal(groupDone(five), '3 of 5 done', '"Split · 3 of 5 done"');
  assert.equal(groupWorking(five), '1 of 5 parts working');
  assert.equal(groupWorking(group('sg_2', { parts: 2, splits: [split(1, 'done'), split(2, 'failed')] })), '1 of 2 done', 'nothing runs: how many are done');
  assert.deepEqual(groupCounts(five), { total: 5, done: 3, running: 1, waiting: 1, failed: 0, settled: 3 });
  assert.equal(groupCounts(group('sg_3', { parts: 0, splits: [split(1, 'done')] })).total, 1, 'at least the listed splits');
  assert.equal(partLabel({ idx: 3, title: 'Check the invoices' }), '#3 Check the invoices');
  assert.equal(partOf({ idx: 3, of: 5 }), 'Part 3 of 5');
});

test('status icon kinds: waiting for pending and queued, otherwise the status', () => {
  assert.equal(splitIconKind('pending'), 'waiting');
  assert.equal(splitIconKind('queued'), 'waiting');
  for (const status of ['running', 'done', 'failed', 'stopped', 'skipped'] as const) assert.equal(splitIconKind(status), status);
});

test('model · effort: the run\'s when it ran, else what the agent asked for; nothing for the parent\'s own model', () => {
  const names: Record<string, string> = { 'claude:claude-opus-5-5': 'Claude Opus 5.5', 'codex:gpt-6': 'GPT-6' };
  const nameOf = (id: string) => names[id];
  assert.equal(splitModelText({ run: { id: 'r', status: 'running', model: 'claude:claude-opus-5-5', effort: 'high' } }, nameOf), 'Claude Opus 5.5 · High');
  assert.equal(splitModelText({ model: 'cheap', effort: 'low' }, nameOf), 'Cheaper model · Low');
  assert.equal(splitModelText({ model: 'strong' }, nameOf), 'Stronger model');
  assert.equal(splitModelText({ model: 'codex:gpt-6', effort: 'xhigh' }, nameOf), 'GPT-6 · Very high');
  assert.equal(splitModelText({ model: 'same' }, nameOf), '');
  assert.equal(splitModelText({}, nameOf), '');
  assert.equal(splitModelText({ model: 'same', effort: 'medium' }, nameOf), 'Medium', 'the same model with another effort');
  assert.equal(splitModelText({ run: { id: 'r', status: 'done', model: 'x:unknown' } }, nameOf), 'x:unknown', 'an id without a catalog name stays the id');
  // A running part's run row has no model yet: the live activity's route names it (its display name first).
  const live = { model: 'claude:claude-opus-5-5', modelName: 'Opus 5.5', effort: 'high' as const };
  assert.equal(splitModelText({ effort: 'low', run: { id: 'r', status: 'running' } }, nameOf, live), 'Opus 5.5 · High');
  assert.equal(splitModelText({ effort: 'low', run: { id: 'r', status: 'running' } }, nameOf, { model: 'codex:gpt-6' }), 'GPT-6 · Low', 'no live effort: the asked one');
  assert.equal(splitModelText({ run: { id: 'r', status: 'done', model: 'codex:gpt-6', effort: 'xhigh' } }, nameOf, live), 'GPT-6 · Very high', 'what it ran on wins');
});

test('durations: once a part ended (no ticking clock while it runs); tokens', () => {
  assert.equal(elapsedText(undefined, undefined, NOW), '');
  assert.equal(elapsedText(NOW, NOW + 4_000), '4 s');
  assert.equal(elapsedText(NOW, NOW + 125_000), '2 min 5 s');
  assert.equal(elapsedText(NOW, NOW + 3_780_000), '1 h 3 min');
  assert.equal(splitDuration(split(1, 'done', { startedAt: NOW, endedAt: NOW + 9_000 })), '9 s');
  assert.equal(splitDuration(split(1, 'running', { startedAt: NOW })), '', 'a running part shows its spinner');
  assert.equal(splitDuration(split(1, 'skipped')), '', 'never started');
  assert.equal(tokensText({ inputTokens: 12_400, outputTokens: 2_100 }), '12.4k in · 2.1k out');
  assert.equal(tokensText({ inputTokens: 512 }), '512 in · 0 out');
  assert.equal(tokensText(undefined), '');
});

test('sidebar groups: the agent\'s active ones and those finished recently, newest first, at most a few', () => {
  const list = [
    group('g_old', { status: 'gathered', createdAt: NOW - RECENT_MS - 10, endedAt: NOW - RECENT_MS - 5 }),
    group('g_recent', { status: 'gathered', createdAt: NOW - 1000, endedAt: NOW - 500 }),
    group('g_active', { status: 'settled', createdAt: NOW - RECENT_MS * 2 }),
    group('g_other', { agentId: 'ag_ava' }),
    group('g_empty', { splits: [] }),
  ];
  assert.deepEqual(sidebarGroups(list, 'ag_mira', NOW).map((entry) => entry.id), ['g_recent', 'g_active']);
  const many = Array.from({ length: SIDEBAR_GROUPS + 2 }, (_, index) => group(`g_${index}`, { createdAt: NOW + index }));
  assert.equal(sidebarGroups(many, 'ag_mira', NOW).length, SIDEBAR_GROUPS);
  assert.equal(sidebarGroups(many, 'ag_mira', NOW)[0]!.id, `g_${SIDEBAR_GROUPS + 1}`);
  assert.ok(isActiveGroup({ status: 'pending' }) && isActiveGroup({ status: 'settled' }) && !isActiveGroup({ status: 'gathered' }) && !isActiveGroup({ status: 'stopped' }));
});

test('a parent run\'s groups in order, and which one belongs to which agents.split call', () => {
  const first = group('sg_a', { createdAt: NOW + 10 });
  const second = group('sg_b', { createdAt: NOW + 50 });
  const ofRun = runGroups([second, group('sg_x', { parentRunId: 'run_other' }), first], 'run_p');
  assert.deepEqual(ofRun.map((entry) => entry.id), ['sg_a', 'sg_b']);
  assert.equal(groupForCall(ofRun, NOW + 5)?.id, 'sg_a', 'the first group made after the call started');
  assert.equal(groupForCall(ofRun, NOW + 20)?.id, 'sg_b');
  assert.equal(groupForCall(ofRun, NOW + 5, '{"ok":true,"groupId":"sg_b","parts":5}')?.id, 'sg_b', 'the result names it');
  assert.equal(groupForCall(ofRun, NOW + 5, '{"ok":true,"groupId":"sg_new","parts":2}'), undefined, 'named but not read yet: no other call\'s group');
  assert.equal(groupForCall(ofRun, NOW + 99, ''), ofRun[1], 'a result without a group id: the run\'s last');
  assert.equal(groupForCall(ofRun, NOW + 99), undefined, 'a call still running never shows an earlier call\'s group');
  assert.equal(groupForCall([], NOW), undefined);
});

test('a chat\'s running groups: one live block each, in start order – made in this chat or reported for it', () => {
  const later = group('sg_later', { startedAt: NOW + 50 });
  const earlier = group('sg_early', { startedAt: NOW + 10 });
  const settled = group('sg_done', { splits: [split(1, 'done')] });
  const pending = group('sg_pending', { status: 'pending', splits: [split(1, 'pending')] });
  const elsewhere = group('sg_else', { conversationId: 'c2' });
  const named = group('sg_named', { conversationId: undefined, startedAt: NOW + 70 });
  const list = [later, earlier, settled, pending, elsewhere, named];
  assert.deepEqual(chatGroups(list, 'c1').map((entry) => entry.id), ['sg_early', 'sg_later']);
  assert.deepEqual(chatGroups(list, 'c1', [splitEntry('run_s', 'sg_named', 1)]).map((entry) => entry.id), ['sg_early', 'sg_later', 'sg_named']);
  assert.ok(isLiveGroup(later) && !isLiveGroup(settled) && !isLiveGroup(pending));
});

test('running splits per agent come from the live activity; a key changes only when a split starts or ends', () => {
  const active = [activityEntry('run_main'), splitEntry('run_s1', 'sg_1', 1), splitEntry('run_s2', 'sg_1', 2), splitEntry('run_a', 'sg_9', 1, { agentId: 'ag_ava' })];
  assert.deepEqual([...runningByAgent(active)], [['ag_mira', 2], ['ag_ava', 1]]);
  const before = splitRunKeys(active);
  const noted = splitRunKeys(active.map((entry) => ({ ...entry, note: 'Running a command' })));
  assert.deepEqual(changedAgents(before, noted), [], 'a new step changes nothing');
  assert.deepEqual(changedAgents(before, splitRunKeys(active.slice(0, 2).concat(active[3]!))), ['ag_mira'], 'a split ended');
  assert.deepEqual(changedAgents(before, splitRunKeys([activityEntry('run_main')])).sort(), ['ag_ava', 'ag_mira'], 'all ended');
});

test('the chat: no live block per split run; the header line and the popover fold a group into one', () => {
  const active = [activityEntry('run_main', { agentId: 'ag_ava', startedAt: NOW + 1 }), splitEntry('run_s1', 'sg_1', 1, { startedAt: NOW + 5 }), splitEntry('run_s2', 'sg_1', 2, { startedAt: NOW + 6 })];
  assert.deepEqual(liveWork([]), [], 'B-075: live blocks are rows – a split run has none, its group has one block');
  const names: Record<string, string> = { ag_mira: 'Mira', ag_ava: 'Ava' };
  const nameOf = (id: string) => names[id];
  const chat = { id: 'c1', working: [] };
  assert.equal(liveStatus(chat, undefined, active, nameOf), 'Ava, Mira: 2 of 5 parts working');
  assert.equal(liveStatus(chat, 'ag_mira', [active[1]!, active[2]!], nameOf), '2 of 5 parts working', 'a 1:1: only what it does');
  const rows = workingRows(chat, active, nameOf);
  assert.deepEqual(rows.map((row) => [row.key, row.note]), [['run_main', 'Working'], ['split:sg_1', '2 of 5 parts working']]);
  assert.equal(rows[1]!.groupId, 'sg_1');
  const handed = workingRows(chat, [active[0]!], nameOf, undefined, [{ id: 'sg_7', agentId: 'ag_mira', startedAt: NOW, note: '3 of 4 parts working' }]);
  assert.deepEqual(handed.map((row) => [row.key, row.name, row.model, row.note]), [['split:sg_7', 'Mira', '', '3 of 4 parts working'], ['run_main', 'Ava', '', 'Working']], 'in start order');
  const named = workingRows(chat, [], nameOf, undefined, [{ id: 'sg_8', agentId: 'ag_mira', startedAt: NOW, note: '1 of 2 parts working', goal: 'Check the invoices' }]);
  assert.equal(named[0]!.model, 'Check the invoices', 'a group row names its goal in the model slot');
  const two = [...active, splitEntry('run_t1', 'sg_2', 1, { startedAt: NOW + 9 })];
  assert.deepEqual(workingIds(chat, two), ['ag_ava', 'ag_mira'], 'who works: each agent once');
  assert.equal(liveStatus(chat, undefined, two, nameOf), 'Ava, Mira: 2 of 5 parts working +1', 'one line per group');
  assert.deepEqual(workingRows(chat, two, nameOf).map((row) => row.key), ['run_main', 'split:sg_1', 'split:sg_2']);
});

test('the agent\'s ring and status line ignore its split runs; the sidebar counts them', () => {
  const previous = activity.value;
  try {
    activity.value = [splitEntry('run_s1', 'sg_1', 1), splitEntry('run_s2', 'sg_1', 2), activityEntry('run_main', { conversationId: 'c9' })];
    assert.equal(liveByAgent.value.get('ag_mira')?.runId, 'run_main', 'the main turn, never a split\'s run');
    assert.equal(runningSplits.value.get('ag_mira'), 2);
    activity.value = [splitEntry('run_s1', 'sg_1', 1)];
    assert.equal(liveByAgent.value.has('ag_mira'), false, 'only splits run: no main live entry');
    assert.equal(runningSplits.value.get('ag_mira'), 1);
  } finally {
    activity.value = previous;
  }
});

test('the store: groups by id, a split with its group, a parent run\'s groups; reads in flight are shared', async (t) => {
  const previous = session.value;
  t.after(() => { session.value = previous; });
  session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  splitGroups.value = new Map();
  applyGroups([group('sg_1'), group('sg_2', { parentRunId: 'run_q', createdAt: NOW + 1 })]);
  assert.equal(findSplit('sp_2')?.group.id, 'sg_1');
  assert.equal(findSplit('sp_404'), undefined);
  applyGroup(group('sg_1', { splits: [split(1, 'done'), split(2, 'done')] }));
  assert.equal(findSplit('sp_2')?.split.status, 'done', 'an update replaces the group');
  assert.deepEqual(groupsOfRun('run_q').map((entry) => entry.id), ['sg_2']);

  const calls: Array<{ method: string; params: unknown }> = [];
  (rpc as unknown as { call: unknown }).call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    return [group('sg_3', { parentRunId: 'run_r' })];
  };
  const [one, two] = await Promise.all([loadSplits({ parentRunId: 'run_r' }), loadSplits({ parentRunId: 'run_r' })]);
  assert.equal(calls.length, 1, 'one read for the same query');
  assert.equal(one[0]!.id, 'sg_3');
  assert.equal(two[0]!.id, 'sg_3');
  assert.deepEqual(calls[0], { method: 'splits.list', params: { parentRunId: 'run_r' } });
  assert.deepEqual(groupsOfRun('run_r').map((entry) => entry.id), ['sg_3'], 'the read went into the store');
  (rpc as unknown as { call: unknown }).call = async () => { throw new Error('offline'); };
  assert.deepEqual(await loadSplits({ agentId: 'ag_mira' }), [], 'an error reads as nothing');
});

test('the split route: #/team/<agentId>/split/<splitId>', () => {
  assert.deepEqual(parseRoute('#/team/ag_mira/split/sp_3'), { view: 'team', agentId: 'ag_mira', splitId: 'sp_3' });
  assert.equal(formatRoute({ view: 'team', agentId: 'ag_mira', splitId: 'sp_3' }), '#/team/ag_mira/split/sp_3');
  assert.deepEqual(parseRoute('#/team/ag_mira/split'), { view: 'team', agentId: 'ag_mira' }, 'no split id: the agent');
  assert.deepEqual(parseRoute('#/team/ag_mira'), { view: 'team', agentId: 'ag_mira' });
});

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const read = (file: string) => readFileSync(path.join(ui, file), 'utf8');

test('wiring and fixed boxes: the step, the live block, the sidebar cell, the Ultra cell', () => {
  assert.match(read('team/run-steps.tsx'), /entry\.call\.name === SPLIT_TOOL && entry\.result\?\.data\.ok !== false\) return <SplitStep /, 'a refused split call stays an ordinary line');
  assert.match(read('chat/WorkingMessage.tsx'), /liveGroupsOf\(props\.conversationId\)/);
  assert.match(read('lib/store-events.ts'), /wireSplits\(\);/);
  // Owner 30.10.2026: Ultra is suggested for the next message (the draft keeps it, like the level), not a chat setting.
  assert.match(read('chat/Composer.tsx'), /<UltraCell chat=\{chat\} on=\{ultra\} onToggle=\{\(next\) => updateDraft\(chat\.id, \{ ultra: next \|\| undefined \}\)\} \/>\s*<ModelChip /, 'the Ultra switch right beside the model chip, on the draft');
  assert.match(read('chat/composer/send.ts'), /\.\.\.\(saved\.ultra && send\.ultraOffered \? \{ ultra: true \} : \{\}\)/, 'sent with the message – only while the chat offers the cell');
  assert.match(read('chat/Composer.tsx'), /ultraOffered: ultraOffered\(chat\)/, 'every send path (also /silent, /important) passes it');
  assert.match(read('chat/composer/draft.ts'), /draftFor\(conversationId\)\.value = \{ text: '', attachments: \[\], level: 'normal' \};/, 'a sent draft is fresh: Ultra off');
  const cell = read('chat/composer/UltraCell.tsx');
  assert.match(cell, /<span class="ultra-switch placeholder" aria-hidden="true" \/>/, 'an inert placeholder of the same size where it is not offered');
  assert.match(cell, /role="switch" aria-checked=\{props\.on\}/);
  assert.doesNotMatch(cell, /chats\.update/, 'no chat setting');
  assert.match(read('chat/MessageItem.tsx'), /message\.meta\.ultra === true && <Icon name="lightning" size=\{12\} class="ultra-marker"/, 'the sent message shows it');
  assert.doesNotMatch(cell, /visibility\s*:|(?<![\w-])hidden=/, 'never hidden through visibility');
  assert.doesNotMatch(read('styles/splits.css'), /visibility\s*:/);
  const nav = read('splits/SplitNav.tsx');
  assert.match(nav, /<span class="team-split-count tabular"/, 'the count cell is always drawn');
  assert.match(read('team/TeamNav.tsx'), /\{splits && open && <SplitNavRows /, 'split rows only inside the person\'s expansion');
  const css = read('styles/splits.css');
  const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.team-split-count'), /min-width: 20px/);
  assert.match(rule('.team-splits'), /scrollbar-gutter: stable/);
  assert.match(rule('.team-split-row'), /height: 34px/);
  assert.match(css, /\.split-row-head \{[^}]*height: 24px/);
  assert.match(read('styles/index.css'), /@import "\.\/splits\.css";/);
});
