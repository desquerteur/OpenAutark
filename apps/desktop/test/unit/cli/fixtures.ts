// Shared test data for the wf terminal client tests (C7): minimal chats, messages, tasks and
// agents shaped like the runtime's RPC results.
// Owns: these factories only. Never: talks to a runtime.

import type { ConversationSummary, Message } from '../../../src/shared/model/chat.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';

export const AT = new Date(2026, 9, 20, 14, 2, 0).getTime(); // local 20.10.2026 14:02

export function chat(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    title: '', titleNamed: false, createdBy: 'human', pinned: false, settings: {}, lastSeq: 0, createdAt: AT, updatedAt: AT,
    members: [humanMember(over.id)],
    unread: 0, working: [], openTasks: 0,
    ...over,
  } as ConversationSummary;
}

export function humanMember(conversationId: string): ConversationSummary['members'][number] {
  return { conversationId, memberId: 'human', kind: 'human', role: 'owner', readSeq: 0, joinedAt: AT } as ConversationSummary['members'][number];
}

export function agentMember(conversationId: string, memberId: string): ConversationSummary['members'][number] {
  return { conversationId, memberId, kind: 'agent', role: 'lead', readSeq: 0, joinedAt: AT } as ConversationSummary['members'][number];
}

export function message(over: Partial<Message> & { id: string; seq: number }): Message {
  return {
    conversationId: 'ch_1', authorId: 'human', authorKind: 'human', kind: 'text', body: '', attachments: [], mentions: [],
    priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: AT,
    ...over,
  } as Message;
}

export function agent(over: Partial<Agent> & { id: string; name: string }): Agent {
  return { role: '', mode: 'general', skills: [], status: 'idle', createdBy: 'human', createdAt: AT, updatedAt: AT, ...over } as Agent;
}

export function task(over: Partial<TaskView> & { id: string; title: string }): TaskView {
  return {
    conversationId: 'ch_1', notes: '', status: 'open', assigneeKind: 'team', createdBy: 'human', priority: 0,
    steps: [], progress: { done: 0, total: 0 }, conversationTitle: 'Launch', running: false,
    ...over,
  } as TaskView;
}
