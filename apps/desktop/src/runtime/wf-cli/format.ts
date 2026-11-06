// Human-readable output of the wf terminal client (C7): chats, messages, to-dos, tasks, agents and
// pushed events as short plain-text lines (no colours, so pipes and logs stay clean); a message
// list leaves out agents' notices about the person's edits and deletes (C6). `--json` output
// bypasses the layouts and prints the runtime's own data (`wf read --json` with those notices).
// Owns: line layouts, local times, author/assignee names, chat display names, and terminal-safe
// text (terminalText/terminalJson – run.ts passes every printed line through them).
// Never: talks to the runtime, decides exit codes or prints (callers write the lines).

import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { isLater, isSnoozed, snoozedUntil, timerAt } from '../../shared/model/todo-later.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { chatName, excerpt, previewText } from '../../shared/text/chat-names.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';

/** C0 controls except \t and \n, DEL and C1 (ESC, CSI, OSC, BEL, backspace …). */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Untrusted text (agent and external messages, titles, notes, event summaries) made safe for a
 * terminal: it cannot move the cursor, erase or overwrite lines, set the window title or write the
 * clipboard (OSC 52). A CR (lone or before LF) becomes a line break; every other control character
 * becomes a visible U+FFFD.
 */
export function terminalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROLS, '�');
}

/** JSON text for a terminal: JSON.stringify escapes C0 already; DEL and C1 get \u escapes too (lossless). */
export function terminalJson(json: string): string {
  return json.replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Display name of an agent id (falls back to the id itself). */
export type NameOf = (id: string) => string;

export function namesOf(agents: readonly Pick<Agent, 'id' | 'name'>[]): NameOf {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  return (id) => (id === HUMAN_ID ? 'You' : id === SYSTEM_ID ? 'System' : names.get(id) ?? id);
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Local time: "14:02" today, "2026-10-19 14:02" on other days. */
export function clock(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) return time;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
}

/** "14:02:07" – the receive time of a pushed event. */
export function stamp(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function chatTitle(chat: Pick<ConversationSummary, 'id' | 'title' | 'titleNamed' | 'members'>, name: NameOf): string {
  const agents = chat.members.filter((member) => member.kind === 'agent' && !member.leftAt).map((member) => name(member.memberId));
  return chatName(chat.title, chat.titleNamed, agents) || chat.id;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Two lines per chat: name with counters, then id and the last message. */
export function formatChats(chats: readonly ConversationSummary[], name: NameOf, now: number): string[] {
  if (!chats.length) return ['No chats.'];
  const lines: string[] = [];
  for (const chat of chats) {
    const section = chatSection(chat);
    const parts = [chatTitle(chat, name)];
    if (section !== 'main') parts.push(section === 'team' ? 'team room' : 'app chat');
    if (chat.pinned) parts.push('pinned');
    if (chat.unread) parts.push(`${chat.unread} unread`);
    if (chat.working.length) parts.push(`${chat.working.map(name).join(', ')} working`);
    if (chat.openTasks) parts.push(plural(chat.openTasks, 'open task'));
    lines.push(parts.join(' · '));
    const last = chat.lastPreview ? `${name(chat.lastPreview.authorId)}: ${excerpt(chat.lastPreview.text, 80)} (${clock(chat.lastPreview.at, now)})` : 'no messages yet';
    lines.push(`  ${chat.id} · ${last}`);
  }
  return lines;
}

function messageFlags(message: Message): string {
  const flags: string[] = [];
  if (message.priority === 'important') flags.push('important');
  if (message.state === 'streaming') flags.push('typing');
  if (message.state === 'failed') flags.push('failed');
  if (message.state === 'stopped') flags.push('stopped');
  if (message.editedAt) flags.push('edited');
  return flags.length ? ` (${flags.join(', ')})` : '';
}

/** One message: "14:02  Manager: first line", further lines indented; status lines start with "·". */
export function formatMessage(message: Message, name: NameOf, now: number): string[] {
  const time = clock(message.createdAt, now);
  const indent = ' '.repeat(time.length + 2);
  if (message.kind === 'status') {
    const text = message.meta.status?.text || previewText(message.body, message.attachments, 200);
    return [`${time}  · ${text}`];
  }
  let body = message.body.trim();
  // B-076: an answer is the person's line as they picked it; an older row kept its pick only in the summary.
  if (message.kind === 'answer' && message.meta.answer?.summary && (!body || body.startsWith('```'))) body = message.meta.answer.summary;
  if ((message.state === 'failed' || message.state === 'stopped') && message.meta.error) body = body ? `${body}\n${message.meta.error}` : message.meta.error;
  const lines = (body || '(no text)').split(/\r\n?|\n/);
  const out = [`${time}  ${name(message.authorId)}${messageFlags(message)}: ${lines[0]}`];
  for (const line of lines.slice(1)) out.push(line ? indent + line : '');
  for (const file of message.attachments) out.push(`${indent}[file] ${file.name} (${file.mime}, ${file.size} bytes)`);
  return out;
}

export function formatMessages(messages: readonly Message[], name: NameOf, now: number): string[] {
  const shown = messages.filter((message) => !isAgentNotice(message)); // C6: agents' edit notices are not for the person
  return shown.length ? shown.flatMap((message) => formatMessage(message, name, now)) : ['No messages.'];
}

function assignee(task: TaskView, name: NameOf): string {
  if (task.assigneeKind === 'human') return 'You';
  if (task.assigneeKind === 'agent' && task.assigneeId) return name(task.assigneeId);
  return 'Team';
}

/**
 * The person's to-dos (My day): what is due now – title, widget, chat, due time, id – then the
 * "Later" ones (F04, shared/model/todo-later.ts) under "Later (n):" with when they ring.
 */
export function formatTodos(todos: readonly TaskView[], now: number): string[] {
  const later = todos.filter((todo) => isLater(todo, now));
  const due = todos.filter((todo) => !isLater(todo, now));
  const lines = due.length ? due.map((todo) => todoLine(todo, undefined, now)) : ['Nothing needs you right now.'];
  if (later.length) lines.push(`Later (${later.length}):`, ...later.map((todo) => todoLine(todo, laterWhen(todo, now), now)));
  return lines;
}

function todoLine(todo: TaskView, when: string | undefined, now: number): string {
  const parts = [`• ${todo.title}`];
  if (todo.widget?.type) parts.push(todo.widget.type);
  if (todo.conversationTitle) parts.push(`in ${todo.conversationTitle}`);
  if (when) parts.push(when);
  else if (todo.dueAt) parts.push(`due ${clock(todo.dueAt, now)}`);
  parts.push(todo.id);
  return parts.join(' · ');
}

/** When a "Later" to-do rings: "snoozed until 14:12" ("snoozed" without a recorded end), "rings 2026-10-23 09:00". */
function laterWhen(todo: TaskView, now: number): string | undefined {
  if (isSnoozed(todo)) {
    const until = snoozedUntil(todo);
    return until === undefined ? 'snoozed' : `snoozed until ${clock(until, now)}`;
  }
  const at = timerAt(todo);
  return at === undefined ? undefined : `rings ${clock(at, now)}`;
}

export function formatTasks(tasks: readonly TaskView[], name: NameOf, now: number): string[] {
  if (!tasks.length) return ['No tasks.'];
  const width = Math.max(...tasks.map((task) => task.status.length));
  return tasks.map((task) => {
    const parts = [`${task.status.padEnd(width)}  ${task.title}`, assignee(task, name)];
    if (task.conversationTitle) parts.push(task.conversationTitle);
    if (task.progress.total) parts.push(`${task.progress.done}/${task.progress.total} steps`);
    if (task.running) parts.push('running');
    if (task.dueAt) parts.push(`due ${clock(task.dueAt, now)}`);
    parts.push(task.id);
    return parts.join(' · ');
  });
}

export function formatAgents(agents: readonly Agent[], name: NameOf): string[] {
  if (!agents.length) return ['No agents.'];
  return agents.map((agent) => {
    const parts = [agent.name];
    if (agent.role && agent.role !== agent.name) parts.push(agent.role);
    parts.push(agent.archivedAt ? 'archived' : agent.status);
    if (agent.statusNote) parts.push(agent.statusNote);
    parts.push(`reports to ${agent.managerId ? name(agent.managerId) : 'You'}`);
    parts.push(agent.id);
    return parts.join(' · ');
  });
}

/** Frames that are streams, not news: skipped in human output (still printed with --json) – browser frames and a run's live row as it updates. */
const STREAMS = new Set(['browser.frame']);
const streaming = (event: string, data: unknown) => event === 'message.updated' && (data as { state?: unknown } | undefined)?.state === 'streaming';

/** One line for a pushed event ("14:02:07  task.upserted  Draft plan · working"); undefined = skip. */
export function formatEvent(event: string, data: unknown, name: NameOf, now: number): string | undefined {
  if (STREAMS.has(event) || streaming(event, data)) return undefined;
  return `${stamp(now)}  ${event}  ${eventSummary(event, data, name)}`;
}

function eventSummary(event: string, data: unknown, name: NameOf): string {
  const value = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  switch (event) {
    case 'message.created':
    case 'message.updated': {
      const message = value as unknown as Message;
      return `${name(message.authorId)}: ${previewText(message.body ?? '', message.attachments ?? [], 100) || '(no text)'} · ${message.state}`;
    }
    case 'conversation.upserted': {
      const chat = value as unknown as ConversationSummary;
      return `${chatTitle({ ...chat, members: chat.members ?? [] }, name)}${chat.unread ? ` · ${chat.unread} unread` : ''}${chat.working?.length ? ` · ${chat.working.map(name).join(', ')} working` : ''}`;
    }
    case 'task.upserted': {
      const task = value as unknown as TaskView;
      return `${task.title} · ${task.status}`;
    }
    case 'agent.upserted': {
      const agent = value as unknown as Agent;
      return `${agent.name} · ${agent.status}${agent.statusNote ? ` · ${agent.statusNote}` : ''}`;
    }
    case 'agent.activity': {
      const active = Array.isArray(value.active) ? value.active as Array<{ agentId: string; note: string }> : [];
      return active.length ? active.map((entry) => `${name(entry.agentId)}: ${entry.note}`).join('; ') : 'nobody working';
    }
    case 'notify':
      return `${String(value.title ?? '')}: ${String(value.body ?? '')}`;
    default:
      return genericSummary(value);
  }
}

/** Id, name/title and status when present, else a short JSON excerpt. */
function genericSummary(value: Record<string, unknown>): string {
  const parts = ['name', 'title', 'status', 'state', 'id'].map((key) => value[key]).filter((part) => typeof part === 'string' && part);
  if (parts.length) return parts.join(' · ');
  let text = '';
  try { text = JSON.stringify(value) ?? ''; } catch { text = ''; }
  return excerpt(text, 200);
}
