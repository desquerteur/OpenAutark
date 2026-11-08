// AF-001: messages.send from an agent's own wf (an owner socket that carries the agent's id – ClientScope owner `agentId`,
// http/ws.ts, engines/agent-token.ts). The line is the agent's, written through the agent's own chat.send tool, so every rule
// of a line an agent writes holds: only into chats it is a member of, the important brake, ask blocks becoming to-dos, who
// it wakes (never the agent itself) and, while the agent has a turn running here, that run's id and its journal entry.
// A line said in a call, a model hint, pin, Ultra, attachments and attached secrets are the person's: refused here.
// Owns: mapping messages.send params onto chat.send and its result back onto the Message. Never: posts as the person
// for an agent's socket, or runs the tool for an archived or unknown agent.

import { randomUUID } from 'node:crypto';
import { WorkforceError } from '../../../shared/errors.ts';
import type { Message } from '../../../shared/model/chat.ts';
import type { ToolContext, ToolOutput } from '../../tools/types.ts';
import { bad, id, input, onlyKeys, optBool, optId, optMemberIds, optOneOf, optText, text } from '../params.ts';
import type { HandlerContext } from '../table.ts';

const KEYS = ['conversationId', 'body', 'mentions', 'priority', 'silent', 'replyTo', 'clientId'] as const;
const PERSON_ONLY = ['attachments', 'model', 'effort', 'pin', 'speech', 'secrets', 'ultra'] as const;
const MAX_BODY = 60_000; // chat.send's text limit

/** The agent of an agent's wf socket (undefined for every other caller). */
export function sendingAgent(ctx: Pick<HandlerContext, 'scope'>): string | undefined {
  return ctx.scope.kind === 'owner' && ctx.scope.agentId ? ctx.scope.agentId : undefined;
}

/** messages.send for an agent's wf: the agent's chat.send; returns the posted message. */
export async function sendAsAgent(params: unknown, ctx: HandlerContext, agentId: string): Promise<Message> {
  const o = input(params);
  const refused = PERSON_ONLY.find((key) => Object.hasOwn(o, key));
  if (refused) bad(refused, `no ${refused}: an agent's wf sends text, mentions, priority or silent and replyTo (files go with the chat.send tool)`);
  onlyKeys(o, KEYS);
  const conversationId = id(o, 'conversationId');
  const body = text(o, 'body', { max: MAX_BODY, multiline: true });
  const priority = optOneOf(o, 'priority', ['normal', 'important']);
  const silent = optBool(o, 'silent');
  if (silent && priority === 'important') bad('silent', 'either silent or priority important, not both');
  const mentions = optMemberIds(o, 'mentions', 20);
  const replyTo = optId(o, 'replyTo');
  const clientId = optText(o, 'clientId', { max: 100 });

  const services = ctx.services;
  const agent = services.org.get(agentId);
  if (!agent || agent.archivedAt) throw new WorkforceError('forbidden', 'This agent is archived or no longer exists, so it cannot write.');
  // The agent's main-lane turn running now, if any: its line then belongs to that run (meta.sentDuringRun, the journal).
  const run = services.dispatcher.activity().find((entry) => entry.agentId === agentId && !entry.split);
  const toolCtx: Omit<ToolContext, 'services'> = {
    agent, runId: run?.runId ?? '', mode: agent.mode || 'general', signal: ctx.signal, status: () => undefined,
    ...(run?.conversationId ? { conversationId: run.conversationId } : {}), ...(run?.taskId ? { taskId: run.taskId } : {}),
  };
  const args = {
    chatId: conversationId, text: body,
    ...(silent ? { level: 'silent' as const } : priority ? { level: priority } : {}),
    ...(mentions?.length ? { mentions } : {}), ...(replyTo ? { replyTo } : {}),
  };
  const output = await services.tools.call('chat.send', args, toolCtx, `wf-${clientId ?? randomUUID()}`);
  const result = resultOf(output);
  if (output.isError || typeof result?.messageId !== 'string') {
    throw new WorkforceError('forbidden', textOf(output) || 'The agent could not send this message.', { details: { conversationId, agentId } });
  }
  const message = services.chats.message(result.messageId);
  if (!message) throw new WorkforceError('internal', 'The message was sent but could not be read back.', { details: { messageId: result.messageId } });
  return message;
}

function textOf(output: ToolOutput): string {
  return output.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n').trim();
}

function resultOf(output: ToolOutput): { messageId?: unknown } | undefined {
  if (output.structured && typeof output.structured === 'object') return output.structured as { messageId?: unknown };
  try {
    const value = JSON.parse(textOf(output)) as unknown;
    return value && typeof value === 'object' ? value as { messageId?: unknown } : undefined;
  } catch {
    return undefined;
  }
}
