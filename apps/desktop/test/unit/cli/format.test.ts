// C7: the wf terminal client's human output (chats, messages, to-dos, tasks, agents, events), its
// exit codes and error mapping, the argument parser and chat/agent/topic resolution.
// Owns: these assertions only. Never: connects to a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOptions, integer, parseArgs, timeoutMs } from '../../../src/runtime/wf-cli/args.ts';
import { CliError, closeError, exitCodeOf, fromRpcError } from '../../../src/runtime/wf-cli/errors.ts';
import {
  clock, formatAgents, formatChats, formatEvent, formatMessage, formatMessages, formatTasks, formatTodos, namesOf, terminalJson, terminalText,
} from '../../../src/runtime/wf-cli/format.ts';
import { pickAgent, pickChat } from '../../../src/runtime/wf-cli/resolve.ts';
import { AT, agent, agentMember, chat, humanMember, message, task } from './fixtures.ts';

const manager = agent({ id: 'ag_manager0001', name: 'Manager', role: 'Manager' });
const editor = agent({ id: 'ag_editor00001', name: 'Video Editor', role: 'Editor', managerId: manager.id, status: 'working', statusNote: 'cutting intro' });
const name = namesOf([manager, editor]);

test('names: the person is "You", system lines "System", unknown ids stay ids', () => {
  assert.equal(name('human'), 'You');
  assert.equal(name('system'), 'System');
  assert.equal(name(manager.id), 'Manager');
  assert.equal(name('ag_gone'), 'ag_gone');
});

test('clock: time only today, date and time on other days', () => {
  assert.equal(clock(AT, AT + 60_000), '14:02');
  assert.equal(clock(AT, AT + 2 * 86_400_000), '2026-10-20 14:02');
});

test('chats: a name line with counters and an id line with the last message; unnamed 1:1 chats use the agent name', () => {
  const lines = formatChats([
    chat({ id: 'ch_launch0001', title: 'Launch', titleNamed: true, unread: 2, working: [manager.id], openTasks: 1, pinned: true, lastPreview: { authorId: manager.id, text: 'Echo: Hello\nteam', at: AT } }),
    chat({ id: 'ch_direct0001', members: [humanMember('ch_direct0001'), agentMember('ch_direct0001', editor.id)] }),
    chat({ id: 'ch_room000001', title: 'Research room', members: [agentMember('ch_room000001', editor.id)] }),
  ], name, AT);
  assert.deepEqual(lines, [
    'Launch · pinned · 2 unread · Manager working · 1 open task',
    '  ch_launch0001 · Manager: Echo: Hello team (14:02)',
    'Video Editor',
    '  ch_direct0001 · no messages yet',
    'Research room · team room',
    '  ch_room000001 · no messages yet',
  ]);
  assert.deepEqual(formatChats([], name, AT), ['No chats.']);
});

test('messages: author and time, indented continuation lines, flags, files, status lines, answers, failures', () => {
  assert.deepEqual(formatMessage(message({ id: 'm1', seq: 1, body: 'Hello team\nsecond line\n\nthird', priority: 'important' }), name, AT), [
    '14:02  You (important): Hello team', '       second line', '', '       third',
  ]);
  assert.deepEqual(formatMessage(message({ id: 'm2', seq: 2, authorId: manager.id, authorKind: 'agent', body: 'Here it is', attachments: [{ fileId: 'f', name: 'plan.pdf', mime: 'application/pdf', size: 1200 }] }), name, AT), [
    '14:02  Manager: Here it is', '       [file] plan.pdf (application/pdf, 1200 bytes)',
  ]);
  assert.deepEqual(formatMessage(message({ id: 'm3', seq: 3, kind: 'status', authorId: 'system', authorKind: 'system', body: 'x', meta: { status: { type: 'task_done', text: 'Draft plan is done' } } }), name, AT), ['14:02  · Draft plan is done']);
  assert.deepEqual(formatMessage(message({ id: 'm4', seq: 4, authorId: manager.id, authorKind: 'agent', state: 'failed', body: '', meta: { error: 'No model could take this.' } }), name, AT), ['14:02  Manager (failed): No model could take this.']);
  assert.deepEqual(formatMessage(message({ id: 'm5', seq: 5, kind: 'answer', body: '```json\n{}\n```', meta: { answer: { blockKey: 'k', summary: 'Chose B' } } }), name, AT), ['14:02  You: Chose B']); // B-076: the pick as the person's own line
  assert.deepEqual(formatMessage(message({ id: 'm6', seq: 6, authorId: editor.id, authorKind: 'agent', state: 'streaming', body: 'Work' }), name, AT), ['14:02  Video Editor (typing): Work']);
  assert.deepEqual(formatMessages([], name, AT), ['No messages.']);
});

test('to-dos, tasks and agents: one line each with the id last', () => {
  assert.deepEqual(formatTodos([task({ id: 'task_a', title: 'Record a voice line', assigneeKind: 'human', status: 'needs_you', widget: { type: 'record' } })], AT), ['• Record a voice line · record · in Launch · task_a']);
  assert.deepEqual(formatTodos([], AT), ['Nothing needs you right now.']);
  assert.deepEqual(formatTasks([
    task({ id: 'task_b', title: 'Draft plan', status: 'working', assigneeKind: 'agent', assigneeId: manager.id, progress: { done: 1, total: 3 }, running: true }),
    task({ id: 'task_c', title: 'Buy domain', status: 'needs_you', assigneeKind: 'human', dueAt: AT }),
  ], name, AT), [
    'working    Draft plan · Manager · Launch · 1/3 steps · running · task_b',
    'needs_you  Buy domain · You · Launch · due 14:02 · task_c',
  ]);
  assert.deepEqual(formatAgents([manager, editor, agent({ id: 'ag_old', name: 'Old', archivedAt: AT })], name), [
    'Manager · idle · reports to You · ag_manager0001',
    'Video Editor · Editor · working · cutting intro · reports to Manager · ag_editor00001',
    'Old · archived · reports to You · ag_old',
  ]);
});

test('events: streams are skipped in human output, known events are summarised, others show id/name/status', () => {
  // B-075: a run's live row updates as message.updated in state 'streaming' (up to twice a second) – a stream, not news.
  assert.equal(formatEvent('message.updated', message({ id: 'm', seq: 2, authorId: manager.id, body: '', state: 'streaming' }), name, AT), undefined);
  assert.match(formatEvent('message.created', message({ id: 'm', seq: 2, authorId: manager.id, body: '', state: 'streaming' }), name, AT) ?? '', /message\.created  Manager: \(no text\) · streaming$/);
  assert.equal(formatEvent('browser.frame', { agentId: 'a', data: 'AAAA' }, name, AT), undefined);
  assert.match(formatEvent('message.updated', message({ id: 'm', seq: 2, authorId: manager.id, body: 'Echo: hi' }), name, AT) ?? '', /^14:02:00  message\.updated  Manager: Echo: hi · final$/);
  assert.match(formatEvent('task.upserted', task({ id: 't', title: 'Draft plan', status: 'done' }), name, AT) ?? '', /task\.upserted  Draft plan · done$/);
  assert.match(formatEvent('agent.activity', { active: [{ agentId: manager.id, note: 'thinking' }] }, name, AT) ?? '', /Manager: thinking$/);
  assert.match(formatEvent('notify', { kind: 'done', title: 'Done', body: 'Plan ready' }, name, AT) ?? '', /notify  Done: Plan ready$/);
  assert.match(formatEvent('device.removed', { id: 'dev_1' }, name, AT) ?? '', /device\.removed  dev_1$/);
  assert.match(formatEvent('usage.updated', [{ a: 1 }], name, AT) ?? '', /usage\.updated  \[\{"a":1\}\]$/);
});

test('exit codes: bad request 2, forbidden 3, not found 4, unreachable 5, interrupted 130, everything else 1', () => {
  assert.deepEqual(['bad_request', 'forbidden', 'not_found', 'unreachable', 'interrupted', 'conflict', 'timeout', 'internal', 'failed', 'needs_approval'].map((kind) => exitCodeOf(kind as never)), [2, 3, 4, 5, 130, 1, 1, 1, 1, 1]);
});

test('runtime errors: an unknown method is a bad request (2), a missing item stays not found (4)', () => {
  const unknown = fromRpcError({ code: 'not_found', message: 'Unknown method.', details: { method: 'no.such' } }, 'no.such');
  assert.equal(unknown.kind, 'bad_request');
  assert.equal(unknown.message, 'Unknown method: no.such.');
  const missing = fromRpcError({ code: 'not_found', message: 'Chat not found.' }, 'chats.get');
  assert.deepEqual([missing.kind, missing.message], ['not_found', 'Chat not found.']);
  assert.equal(fromRpcError(undefined, 'x').kind, 'internal');
  assert.equal(closeError(4401).kind, 'forbidden');
  assert.equal(closeError(4403).kind, 'forbidden');
  assert.equal(closeError(1001).kind, 'unreachable');
  assert.equal(closeError(1006).kind, 'unreachable');
});

test('arguments: options anywhere, --name=value, -- ends options, - is an argument, unknown options refused', () => {
  const parsed = parseArgs(['--data', 'C:\\p', 'send', 'Launch', '--important', 'hello', '--', '--not-an-option', '-']);
  assert.equal(parsed.command, 'send');
  assert.deepEqual(parsed.args, ['Launch', 'hello', '--not-an-option', '-']);
  assert.equal(parsed.options.get('data'), 'C:\\p');
  assert.equal(parsed.options.get('important'), true);
  assert.deepEqual(parseArgs(['read', 'x', '--limit=5', '-1', '- item']).args, ['x', '-1', '- item']);
  assert.throws(() => parseArgs(['chats', '--colour']), (error: CliError) => error.kind === 'bad_request' && /--colour/.test(error.message));
  assert.throws(() => parseArgs(['chats', '-x']), /Unknown option -x/);
  assert.throws(() => parseArgs(['read', 'x', '--limit']), /--limit needs a value/);
  assert.throws(() => parseArgs(['read', 'x', '--limit', '--json']), /--limit needs a value/);
  assert.throws(() => parseArgs(['chats', '--all=yes']), /takes no value/);
  assert.equal(parseArgs(['-h']).options.get('help'), true);
  assert.throws(() => checkOptions(parseArgs(['chats', '--limit', '3']), ['all']), /wf chats does not take --limit/);
  checkOptions(parseArgs(['chats', '--all', '--json', '--data', 'x']), ['all']);
  assert.equal(integer(parseArgs(['read', 'x', '--limit', '7']), 'limit', 1, 200), 7);
  for (const bad of ['0', '201', '2.5', 'abc', '']) assert.throws(() => integer(parseArgs(['read', 'x', `--limit=${bad}`]), 'limit', 1, 200), /whole number from 1 to 200/);
  assert.equal(timeoutMs(parseArgs(['watch', 'x', '--timeout', '1.5'])), 1500);
  for (const bad of ['0', '-1', 'soon', '90000']) assert.throws(() => timeoutMs(parseArgs(['watch', 'x', `--timeout=${bad}`])), /--timeout/);
});

test('chat resolution: id, exact name, prefix, part of the name; main-list chats first; several matches are refused', () => {
  const launch = chat({ id: 'ch_launch0001', title: 'Launch', titleNamed: true });
  const launchRoom = chat({ id: 'ch_launchroom1', title: 'Launch', titleNamed: true, settings: { hiddenFromList: true } });
  const direct = chat({ id: 'ch_direct0001', members: [humanMember('ch_direct0001'), agentMember('ch_direct0001', editor.id)] });
  const budget = chat({ id: 'ch_budget0001', title: 'Budget 2027', titleNamed: true });
  const budgetOld = chat({ id: 'ch_budget0002', title: 'Budget 2026', titleNamed: true });
  const all = [launchRoom, launch, direct, budget, budgetOld];
  assert.equal(pickChat(all, 'ch_launchroom1', name).id, 'ch_launchroom1', 'an id always wins');
  assert.equal(pickChat(all, 'launch', name).id, 'ch_launch0001', 'exact folded name; the main list before team rooms');
  assert.equal(pickChat(all, 'video', name).id, 'ch_direct0001', 'prefix of the derived name');
  assert.equal(pickChat(all, '2027', name).id, 'ch_budget0001', 'part of the name');
  assert.throws(() => pickChat(all, 'budget', name), (error: CliError) => error.kind === 'bad_request' && /Budget 2027 \(ch_budget0001\), Budget 2026 \(ch_budget0002\)/.test(error.message));
  assert.throws(() => pickChat(all, 'nothing like it', name), (error: CliError) => error.kind === 'not_found' && /wf chats --all/.test(error.message));
  assert.throws(() => pickChat(all, '   ', name), (error: CliError) => error.kind === 'not_found');
});

test('agent resolution: active agents before archived ones of the same name', () => {
  const archived = agent({ id: 'ag_oldmanager', name: 'Manager', archivedAt: AT });
  assert.equal(pickAgent([archived, manager, editor], 'manager').id, manager.id);
  assert.equal(pickAgent([archived, manager, editor], 'ag_oldmanager').id, 'ag_oldmanager');
  assert.equal(pickAgent([archived, manager, editor], 'vid').id, editor.id);
});

test('terminal safety: control characters become U+FFFD, CR a line break; JSON escapes DEL/C1 losslessly', () => {
  assert.equal(terminalText('ok\u001b]52;c;cm0g\u0007\u001b[2K\rSent\u0008\u007f\u009b2J\tend\r\nnext'), 'ok\uFFFD]52;c;cm0g\uFFFD\uFFFD[2K\nSent\uFFFD\uFFFD\uFFFD2J\tend\nnext');
  assert.equal(terminalText('Plain text · äöü 🙂\n  indented'), 'Plain text · äöü 🙂\n  indented', 'ordinary text is untouched');
  const json = terminalJson(JSON.stringify({ body: 'a\u001b[8m\u009b\u007fz' }));
  assert.equal(json, String.raw`{"body":"a\u001b[8m\u009b\u007fz"}`);
  assert.equal(JSON.parse(json).body, 'a\u001b[8m\u009b\u007fz');
  assert.deepEqual(formatMessage(message({ id: 'm7', seq: 7, body: 'first\rSent to Launch.' }), name, AT), ['14:02  You: first', '       Sent to Launch.'], 'a lone CR starts an indented line');
});
