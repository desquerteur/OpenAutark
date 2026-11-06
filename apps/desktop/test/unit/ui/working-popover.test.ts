// B-048 E4.5: the chat header's working popover as data and the live run's model line
// (chat/live-text.ts workingRows, modelLine, noteText; chat/run-line.ts liveWords): one row per
// member working in this chat in start order – name, "model · effort", live note, task –, agents
// the summary marks working without an entry get a plain row; the model comes from the run's live values
// (B-075: the summary's live runs – its row's meta.live), before that from the message's meta, never invented;
// the newest words are its row's newest paragraph. Plus the wiring the window relies on:
// the live line is a button for everyone, the popover is anchored to the reserved sub line and
// keeps "Stop all agent work" as its last entry for whoever may stop.
// Owns: these assertions only. Never: renders or reads the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentActivity } from '../../../src/shared/model/runs.ts';
import { EFFORT_LABEL, liveRuns, modelLine, noteText, workingRows } from '../../../src/ui/chat/live-text.ts';
import { liveWords, workingLine } from '../../../src/ui/chat/run-line.ts';

const names: Record<string, string> = { m: 'Manager', a: 'Ava', i: 'Mira' };
const nameOf = (id: string) => names[id];
const entry = (agentId: string, runId: string, startedAt: number, patch: Partial<AgentActivity> = {}): AgentActivity =>
  ({ agentId, runId, conversationId: 'c1', note: '', startedAt, ...patch });

test('modelLine: the activity\'s display name and effort; a bare id without a name; the message meta before the activity knows', () => {
  assert.equal(modelLine({ model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'xhigh' }), 'Opus 5.5 · Very high');
  assert.equal(modelLine({ model: 'codex:gpt-6.1-sol', effort: 'medium' }), 'gpt-6.1-sol · Medium', 'no display name: the id without its provider');
  assert.equal(modelLine({ modelName: 'Local Qwen' }), 'Local Qwen', 'no effort: the name alone');
  assert.equal(modelLine({}, { model: 'GPT-6.1 Sol', effort: 'high' }), 'GPT-6.1 Sol · High', 'the streaming message meta while routing');
  assert.equal(modelLine({ modelName: 'Claude Sonnet 5', effort: 'low' }, { model: 'Claude Opus 5.5', effort: 'high' }), 'Sonnet 5 · Low', 'after a failover the activity wins over the first meta');
  assert.equal(modelLine({}, { model: 'GPT-6.1 Sol', effort: 'turbo' }), 'GPT-6.1 Sol', 'an unknown effort word is not shown');
  assert.equal(modelLine(undefined), '', 'routing: an empty slot');
  assert.equal(modelLine({}, { model: 42 }), '');
  assert.deepEqual(Object.keys(EFFORT_LABEL), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('noteText: what the agent does in words, upper case first, else "Working"', () => {
  assert.equal(noteText('bash'), 'Running a command');
  assert.equal(noteText('waiting for approval'), 'Waiting for approval');
  assert.equal(noteText('cutting intro'), 'Cutting intro');
  assert.equal(noteText(''), 'Working');
  assert.equal(noteText('   '), 'Working');
  assert.equal(noteText(undefined), 'Working');
});

test('workingRows: this chat\'s runs in start order, then summary-only agents; other chats stay out', () => {
  const chat = { id: 'c1', working: ['i', 'a', 'm'] };
  const entries = [
    entry('a', 'run_a', 30, { note: 'bash', taskId: 'tk_1', model: 'claude:claude-opus-5-5', modelName: 'Claude Opus 5.5', effort: 'high' }),
    entry('m', 'run_m', 10, { note: 'cutting intro' }),
    entry('i', 'run_x', 5, { conversationId: 'other', note: 'bash' }),
  ];
  const rows = workingRows(chat, entries, nameOf, (runId) => (runId === 'run_m' ? { model: 'GPT-6.1 Sol', effort: 'medium' } : undefined));
  assert.deepEqual(rows, [
    { key: 'run_m', agentId: 'm', runId: 'run_m', name: 'Manager', model: 'GPT-6.1 Sol · Medium', note: 'Cutting intro' },
    { key: 'run_a', agentId: 'a', runId: 'run_a', name: 'Ava', model: 'Opus 5.5 · High', note: 'Running a command', taskId: 'tk_1' },
    { key: 'agent:i', agentId: 'i', name: 'Mira', model: '', note: 'Working' },
  ]);
  assert.deepEqual(workingRows({ id: 'c1', working: [] }, [], nameOf), [], 'nobody works');
  assert.equal(workingRows({ id: 'c1', working: ['x'] }, [], nameOf)[0]!.name, 'Agent', 'an unknown agent is "Agent"');
});

test('B-075 liveRuns: the summary\'s live runs (the chat\'s streaming rows) as the rows the popover and the lines read', () => {
  const chat = { id: 'c1', working: ['a', 'm'], live: [
    { runId: 'run_a', agentId: 'a', messageId: 'msg_a', note: 'bash', model: 'Claude Opus 5.5', effort: 'high', taskId: 'tk_1', startedAt: 30 },
    { runId: 'run_m', agentId: 'm', messageId: 'msg_m', effort: 'turbo', startedAt: 10 },
  ] };
  const entries = liveRuns(chat);
  assert.deepEqual(entries[1], { agentId: 'm', runId: 'run_m', conversationId: 'c1', note: '', startedAt: 10 }, 'an unknown effort word is left out');
  assert.deepEqual(workingRows(chat, entries, nameOf).map((row) => [row.key, row.model, row.note, row.taskId]), [
    ['run_m', '', 'Working', undefined], ['run_a', 'Opus 5.5 · High', 'Running a command', 'tk_1'],
  ]);
  assert.deepEqual(liveRuns({ id: 'c1' }), [], 'nobody works');
});

test('liveWords: the newest paragraph while it is written, never a tag', () => {
  assert.equal(liveWords({ body: 'Intro.\n\nWriting the answer now' }), 'Writing the answer now');
  assert.equal(liveWords({ body: 'Checked the invoices. [[silent]]' }), 'Checked the invoices.');
  assert.equal(liveWords({ body: '' }), '');
  assert.equal(liveWords({}), '');
  // the live block's line keeps its behaviour (words, else the note)
  assert.equal(workingLine({ body: '', note: 'Running ls' }), 'Running ls');
});

const source = (file: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/chat', file), 'utf8');

test('wiring: the live line is a button for everyone; the popover hangs on the reserved sub line and ends with the stop', () => {
  const line = source('LiveLine.tsx');
  assert.ok(!/<span[^>]*class="chat-live[\s"]/.test(line), 'never plain text (its inner .chat-live-text span aside)');
  assert.match(line, /<button type="button" class="chat-live tabular"[^>]*aria-haspopup="dialog" aria-expanded=\{props\.open\}/);
  const header = source('ChatHeader.tsx');
  assert.match(header, /<div class="chat-sub" ref=\{working\.anchor\}/, 'anchored to the always reserved sub line');
  assert.match(header, /<WorkingPopover chat=\{chat\} anchor=\{working\.anchor\.current\} open=\{working\.open\} onClose=\{working\.close\} \/>/);
  const popover = source('WorkingPopover.tsx');
  assert.match(popover, /const stop = workAction\(workStop\.value\) === 'stop';/);
  assert.ok(popover.lastIndexOf('<span>Stop all agent work</span>') > popover.indexOf('<ul class="working-rows">'), 'the stop is the last entry');
  assert.match(popover, /<Popover [^>]*class="working-popover" label="Agent work">/, 'over the content (a portalled popover)');
  const block = source('WorkingMessage.tsx');
  assert.match(block, /<span class="working-model tabular" title=\{model \|\| undefined\}>\{model\}<\/span>/, 'the byline slot is always there');
});

test('review fixes: Escape gives focus back to the live line; a row without steps or words says so instead of opening empty (B-075: steps come from the row on every device)', () => {
  const popover = source('WorkingPopover.tsx');
  // lib/popover.tsx focuses the anchor on Escape – the sub line div is no focus target, so close() must hand focus to the button.
  assert.match(popover, /close: \(\) => \{\s*\/\/[^\n]*\n\s*if \(document\.activeElement\?\.closest\('\.working-popover'\)\) anchor\.current\?\.querySelector<HTMLElement>\('\.chat-live'\)\?\.focus\(/);
  assert.match(popover, /\{!items\.length && !words && <p class="working-row-empty">No steps yet<\/p>\}/);
});
