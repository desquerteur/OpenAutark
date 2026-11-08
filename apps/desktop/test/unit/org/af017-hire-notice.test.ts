// AF-017: a hire by an agent is never invisible – agents.create posts one 'agent_hired' status line into the chat
// the hiring agent works in (a split's call: its parent chat) and sends the person a 'done' notification; a hire
// without a chat still notifies; a failing chat or notification never fails the hire. The chat list makes the line
// its own row (ui/chat/message-rows.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Org } from '../../../src/runtime/org/service.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { standingRuleValues } from '../../../src/runtime/org/hire.ts';
import { agentOrgTools } from '../../../src/runtime/tools/builtin/agents-org.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import type { NotificationInput, RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Message, StatusLine } from '../../../src/shared/model/chat.ts';
import { groupRows, isHireLine } from '../../../src/ui/chat/message-rows.ts';
import { clock, memoryDb, recordingBus, RESOURCES } from '../store/helpers.ts';

const settings = defaultSettings({ locale: 'en-US', timezone: 'UTC' });
const prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));

function setup(options: { failing?: boolean } = {}) {
  const standingRules = (values?: Readonly<Record<string, string>>) => prompts.renderText('agent-default', { ...standingRuleValues(settings), ...values });
  const org = new Org({ db: memoryDb(), bus: recordingBus().bus, clock: clock(), templatesDir: path.join(RESOURCES, 'agents'), standingRules });
  const lines: Array<{ conversationId: string; line: StatusLine; authorId?: string }> = [];
  const notes: NotificationInput[] = [];
  const chats = { status: (conversationId: string, line: StatusLine, opts: { authorId?: string } = {}) => { if (options.failing) throw new Error('db gone'); lines.push({ conversationId, line, authorId: opts.authorId }); } };
  const notifications = { notify: (input: NotificationInput) => { if (options.failing) throw new Error('bus gone'); notes.push(input); } };
  const services = { org, settings: { get: () => settings }, modes: { list: () => [] }, chats, notifications } as unknown as RuntimeServices;
  const manager = org.ensureSeed()!;
  const create = (args: Record<string, unknown>, extra: Partial<ToolContext> = {}): Promise<ToolOutput> =>
    agentOrgTools.find((tool) => tool.name === 'agents.create')!.run(args, { agent: manager, runId: 'run_1', mode: 'manager', services, signal: new AbortController().signal, status: () => undefined, ...extra } as ToolContext);
  return { org, manager, create, lines, notes };
}

test('a hire in a chat leaves the agent_hired line there and notifies the person', async () => {
  const { manager, create, lines, notes } = setup();
  const out = await create({ name: 'Making', role: 'Builds prototypes' }, { conversationId: 'cnv_1' });
  assert.equal(out.isError, undefined);
  const agentId = (out.structured as { agentId: string }).agentId;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].conversationId, 'cnv_1');
  assert.equal(lines[0].authorId, manager.id);
  assert.equal(lines[0].line.type, 'agent_hired');
  assert.equal(lines[0].line.text, `${manager.name} hired Making · Builds prototypes`);
  assert.deepEqual({ ...lines[0].line.details, spaceId: undefined, space: undefined }, { agentId, name: 'Making', role: 'Builds prototypes', by: manager.id, spaceId: undefined, space: undefined });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'done');
  assert.equal(notes[0].title, 'New agent: Making');
  assert.ok(notes[0].body.startsWith('Builds prototypes · '), notes[0].body); // role · (area, when it lands in one) · hired by
  assert.ok(notes[0].body.endsWith(`hired by ${manager.name}`), notes[0].body);
  assert.equal(notes[0].conversationId, 'cnv_1');
});

test('a split posts into its parent chat; a hire without any chat still notifies', async () => {
  const split = setup();
  await split.create({ name: 'Mara', role: 'Researcher' }, { split: { parentConversationId: 'cnv_parent' } as ToolContext['split'] });
  assert.equal(split.lines[0]?.conversationId, 'cnv_parent');
  const none = setup();
  await none.create({ name: 'Nora', role: 'Writer' });
  assert.equal(none.lines.length, 0);
  assert.equal(none.notes.length, 1);
  assert.equal(none.notes[0].conversationId, undefined);
});

test('a team hire announces every new agent; a refused hire announces nothing', async () => {
  const { create, lines, notes } = setup();
  await create({ agents: [{ name: 'Ida', role: 'Designer' }, { name: 'Designer', role: 'Designer' }] }, { conversationId: 'cnv_1' });
  assert.deepEqual(lines.map((entry) => entry.line.details?.name), ['Ida']);
  assert.equal(notes.length, 1);
});

test('a failing chat or notification never fails the hire', async () => {
  const { org, create } = setup({ failing: true });
  const out = await create({ name: 'Making', role: 'Builds prototypes' }, { conversationId: 'cnv_1' });
  assert.equal(out.isError, undefined);
  assert.ok(org.list().some((agent) => agent.name === 'Making'));
});

function status(seq: number, type: StatusLine['type']): Message {
  return {
    id: `m${seq}`, conversationId: 'c', seq, authorId: 'mgr', authorKind: 'agent', kind: 'status', body: type, attachments: [], mentions: [],
    priority: 'normal', state: 'final', silent: true, meta: { status: { type, text: type } }, createdAt: seq,
  };
}

test('the chat list shows a hire as its own row, never folded into a burst of status lines', () => {
  const rows = groupRows([status(1, 'note'), status(2, 'agent_hired'), status(3, 'note'), status(4, 'note')]);
  assert.deepEqual(rows.map((row) => (row.kind === 'status' ? row.messages.map((message) => message.seq) : [])), [[1], [2], [3, 4]]);
  assert.equal(isHireLine(status(2, 'agent_hired')), true);
  assert.equal(isHireLine(status(1, 'note')), false);
});
