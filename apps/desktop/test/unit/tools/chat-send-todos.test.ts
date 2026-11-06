// chat.send to-dos (tools/builtin/chat.ts, LEFT-B): a ```app todo=true mini-app an agent posts with
// chat.send becomes a "For you" to-do like one in a turn's answer – also when the message has no
// ```ui block – and the person is told; an app without todo=true stays in the chat only; ask
// blocks and apps of one message both become to-dos; `urgent` posts an important message.
// Owns: these assertions only. Never: real engines, timers or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { appWidgetOf } from '../../../src/shared/blocks/app-todo.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { chatTools } from '../../../src/runtime/tools/builtin/chat.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { agent, harness } from '../chat/harness.ts';

const APP = [
  'Please record the voice-over here:',
  '```app title="Voice take" todo=true reason=physical',
  '<button onclick="wf.complete({take:1})">Done</button>',
  '```',
].join('\n');

function setup() {
  const h = harness();
  h.org.add(agent('ag_ava', 'Ava'));
  const chat = h.chats.create({ agentIds: ['ag_ava'], createdBy: HUMAN_ID });
  const tool = chatTools.find((item) => item.name === 'chat.send')!;
  const ctx = {
    agent: h.org.get('ag_ava')!, runId: 'run_send', conversationId: chat.id, mode: 'general',
    services: h.services as RuntimeServices, signal: new AbortController().signal, status: () => {},
  } as ToolContext;
  const send = async (args: Record<string, unknown>) => {
    const out = await tool.run(args as never, ctx);
    return JSON.parse((out.content[0] as { text: string }).text) as { messageId: string };
  };
  return { ...h, chat, send };
}

test('a mini-app to-do sent with chat.send is on the For-you list, without any ui block', async () => {
  const h = setup();
  const { messageId } = await h.send({ text: APP });
  const todos = h.tasks.todos();
  assert.equal(todos.length, 1);
  assert.equal(todos[0].title, 'Voice take');
  assert.equal(todos[0].humanReason, 'physical');
  assert.equal(todos[0].createdBy, 'ag_ava');
  assert.equal(todos[0].messageId, messageId);
  const widget = appWidgetOf(todos[0].widget);
  assert.deepEqual([widget?.type, widget?.messageId, widget?.index], ['app', messageId, 0], 'the widget points at the fence');
  assert.ok(h.notified.some((item) => item.kind === 'todo' && item.taskId === todos[0].id), 'the person is told');
});

test('an app without todo=true stays in the chat; ask blocks and apps of one message both become to-dos', async () => {
  const h = setup();
  await h.send({ text: '```app title="Preview"\n<p>Just a preview</p>\n```' });
  assert.equal(h.tasks.todos().length, 0);
  const both = '```ui\n{"type":"confirm","important":true,"label":"Approve the cover?"}\n```\n' + APP;
  await h.send({ text: both });
  assert.deepEqual(h.tasks.todos().map((todo) => todo.widget?.type).sort(), ['app', 'confirm']);
});

test('urgent posts an important message', async () => {
  const h = setup();
  const { messageId } = await h.send({ text: 'The server is down.', urgent: true });
  assert.equal(h.chats.message(messageId)?.priority, 'important');
});
