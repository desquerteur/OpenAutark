// Chat lifecycle around the message log (split from chat/service.ts): archive, unarchive and
// remove a conversation, delete a message, the start-up reconcile of streaming messages, and
// publishing a message – for agent messages after their outputs are stored (```ui blocks that
// name local files, engine files such as Codex images; media/outputs.ts does the storing).
// Archive (C2) works like WhatsApp's: it only takes the chat out of the person's list – its
// agents keep working there. It comes back by itself, with one quiet 'unarchived' line, when
// something needs the person: an agent's important message or @mention of the person in a chat
// of their main list (they are an active member and it is not under Team activity – the rule
// delivery.notifyHuman tells them by), or a new to-do or approval for the person in that chat
// (watchHumanTodos, on 'task.upserted').
// A deleted message takes its open mini-app to-dos with it (cancelled: the app cannot run any
// more), a deleted message or chat its saved mini-app state (kv 'block_state', keyed
// `<messageId>:<block>` by rpc/handlers/blocks.ts – it would hold the files it names for good),
// a deleted chat its mini-app to-dos' registered takes (kv 'app_files', X03 – queued for the clean-up;
// a cancelled or removed to-do releases its own, tasks/lifecycle.ts), and outputs stored for a
// message deleted meanwhile go to the blob clean-up (MM6).
// B-054 (owner 29.10.2026: a chat is only where a task was handed over): a deleted chat lets
// its tasks live on chat-free – they keep the chat's space, lose the anchor, stay searchable (their FTS rows stay)
// and keep their pending wakes and reminders (now chat-free), each re-emitted once ('task.upserted'); an open
// mini-app to-do among them is cancelled (its fence went with the chat).
// B-075: the start-up reconcile ends only this PC's streaming rows (a row synced from another PC's run is that PC's to
// end): a run's row becomes 'stopped' with its steps kept (meta.live → meta.lines), a silent one – it only showed a
// run's work – goes.
// Owns: those writes and their events; the publish order (message event → auto-unarchive →
// chat summary → delivery), which for an agent message with outputs runs once the files are
// stored, so every client, bridge and woken agent sees the final body with fileIds exactly once.
// Never: decides who gets woken (DeliveryService), stores file bytes itself, unarchives for the
// person's own messages or to-dos or for agents' messages in an agent-only or hidden room, rewrites
// a body a person edited meanwhile, or deletes the tasks of an unbounded chat.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';
import { appWidgetOf } from '../../shared/blocks/app-todo.ts';
import { appTodosOf } from '../../shared/blocks/parse.ts';
import type { Attachment, Conversation, Message, StatusLine } from '../../shared/model/chat.ts';
import type { TaskStatus, TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { EngineFile } from '../engines/types.ts';
import { hasOutputRefs, importOutputs, saveOutputNotes, storeEngineFiles } from '../media/outputs.ts';
import { APP_FILES_NS } from '../tasks/app-files.ts';
import type { ConversationRepo } from './conversation-repo.ts';
import type { MessageRepo } from './message-repo.ts';
import { OF_CHAT_MESSAGE, canReclaim, chatAppTakes, queueReclaim } from './reclaim.ts';
import type { StreamingRows } from './streaming.ts';

export type ChatDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock'> & Partial<Pick<RuntimeServices, 'org' | 'delivery' | 'log' | 'files' | 'paths' | 'tasks'>>;

/** What the lifecycle steps need from ChatServiceImpl (its repos, buffers and emit helpers). */
export interface ChatCore {
  s: ChatDeps;
  convs: ConversationRepo;
  msgs: MessageRepo;
  streams: StreamingRows;
  emitConversation(id: string): void;
  deliver(message: Message): void;
  /** A quiet status line from the system. */
  status(conversationId: string, line: StatusLine): void;
  nameOf(memberId: string): string;
}

const OPEN: TaskStatus[] = ['open', 'working', 'waiting', 'needs_you', 'blocked'];
/** Saved mini-app state (rpc/handlers/blocks.ts STATE_NS). */
const BLOCK_STATE = 'block_state';

export function archiveConversation(core: ChatCore, conversation: Conversation): void {
  conversation.archivedAt = core.s.clock.now();
  conversation.updatedAt = conversation.archivedAt;
  core.convs.update(conversation);
  core.emitConversation(conversation.id);
}

/** Back into the person's list; `line` says why when the runtime does it (no line when the person does). */
export function unarchiveConversation(core: ChatCore, conversation: Conversation, line?: StatusLine): void {
  if (conversation.archivedAt === undefined) return;
  delete conversation.archivedAt;
  conversation.updatedAt = core.s.clock.now();
  core.convs.update(conversation);
  if (line) core.status(conversation.id, line); // its publish emits the summary
  else core.emitConversation(conversation.id);
}

/**
 * An agent's important message or @mention of the person brings an archived chat of their main
 * list back; agents' urgent messages to each other in an agent-only or hidden room do not.
 */
function surface(core: ChatCore, message: Message): void {
  if (message.authorKind !== 'agent' || message.kind !== 'text' || message.state !== 'final' || message.silent) return;
  const reason = message.priority === 'important' ? 'important' : message.mentions.includes(HUMAN_ID) ? 'mention' : undefined;
  const conversation = reason ? core.convs.get(message.conversationId) : undefined;
  if (!reason || conversation?.archivedAt === undefined) return;
  if (chatSection({ settings: conversation.settings, members: core.convs.members(conversation.id) }) !== 'main') return;
  const name = core.nameOf(message.authorId);
  const text = reason === 'important' ? `Unarchived: important message from ${name}` : `Unarchived: ${name} mentioned you`;
  unarchiveConversation(core, conversation, { type: 'unarchived', text, details: { reason, messageId: message.id } });
}

/** A new to-do or approval for the person in an archived chat brings it back; returns the unsubscribe. */
export function watchHumanTodos(core: ChatCore): () => void {
  return core.s.bus.on('task.upserted', (task: TaskView) => {
    if (task.assigneeKind !== 'human' || task.createdBy === HUMAN_ID || !OPEN.includes(task.status) || !task.conversationId) return;
    const conversation = core.convs.get(task.conversationId);
    if (conversation?.archivedAt === undefined || task.createdAt < conversation.archivedAt) return;
    const reason = task.humanReason === 'approval' ? 'approval' : 'todo';
    const text = reason === 'approval' ? 'Unarchived: an approval for you' : 'Unarchived: a to-do for you';
    unarchiveConversation(core, conversation, { type: 'unarchived', text, details: { reason, taskId: task.id } });
  });
}

/**
 * Deletes a conversation with its message index rows, mini-app state and mini-app takes before the
 * cascade; the takes go to the clean-up (X03). Its tasks are detached (chat-free, the chat's space,
 * no anchor; rev bumped so a stale copy cannot write the old chat back).
 */
export function removeConversation(core: ChatCore, id: string): void {
  let takes: string[] = [];
  let detached: string[] = [];
  const conversation = core.convs.get(id);
  core.s.db.tx(() => {
    core.msgs.unindexConversation(id);
    detached = core.s.db.all<{ id: string }>('SELECT id FROM tasks WHERE conversation_id = ?', [id]).map((row) => String(row.id));
    core.s.db.run(
      'UPDATE tasks SET space_id = COALESCE(?, space_id), message_id = NULL, conversation_id = NULL, rev = rev + 1, updated_at = ? WHERE conversation_id = ?',
      [conversation?.spaceId ?? null, core.s.clock.now(), id]);
    // Their pending wakes and reminders follow them (chat-free now); without this they would point at the gone chat
    // and be skipped for good. A chat's own wakes (no task) end with it as before.
    const list = JSON.stringify(detached);
    core.s.db.run('UPDATE wakes SET conversation_id = NULL WHERE conversation_id = ? AND task_id IN (SELECT value FROM json_each(?))', [id, list]);
    core.s.db.run(`UPDATE schedules SET conversation_id = NULL WHERE conversation_id = ? AND kind <> 'message' AND task_id IN (SELECT value FROM json_each(?))`, [id, list]);
    if (canReclaim(core.s.files)) takes = chatAppTakes(core.s.db, id);
    for (const ns of [BLOCK_STATE, APP_FILES_NS]) core.s.db.run(`DELETE FROM kv WHERE ns = ? AND ${OF_CHAT_MESSAGE}`, [ns, id]);
    core.convs.delete(id);
  });
  queueReclaim(core.s.files, takes);
  core.s.bus.emit('conversation.removed', { id });
  for (const taskId of detached) {
    try {
      const view = core.s.tasks?.get(taskId);
      if (!view) continue;
      // An open mini-app to-do's fence went with the chat: it cannot run any more (as for a deleted message).
      if (appWidgetOf(view.widget) && OPEN.includes(view.status)) core.s.tasks!.setStatus(taskId, 'cancelled', SYSTEM_ID, 'Its chat was deleted');
      else core.s.bus.emit('task.upserted', view);
    } catch (error) {
      core.s.log?.warn('detached task not re-emitted', { taskId, error: String(error) });
    }
  }
}

export function removeMessage(core: ChatCore, message: Message, by: string): void {
  if (by !== message.authorId && by !== HUMAN_ID && by !== SYSTEM_ID) throw new WorkforceError('forbidden', 'Only the author can delete this message.');
  core.streams.end(message.id);
  core.s.db.tx(() => {
    core.msgs.delete(message.id);
    core.s.db.run('DELETE FROM kv WHERE ns = ? AND substr(key, 1, ?) = ?', [BLOCK_STATE, message.id.length + 1, `${message.id}:`]);
  });
  core.s.bus.emit('message.removed', { id: message.id, conversationId: message.conversationId });
  core.emitConversation(message.conversationId);
  cancelAppTodos(core, message, by);
}

/** F01: an open ```app todo=true to-do whose fence was in the deleted message cannot run any more. */
function cancelAppTodos(core: ChatCore, message: Message, by: string): void {
  const tasks = core.s.tasks;
  if (!tasks || message.kind !== 'text' || !appTodosOf(message.body).length) return;
  try {
    const open = tasks.list({ conversationId: message.conversationId, assigneeKind: 'human', status: OPEN, includeSteps: true, limit: 1000 });
    for (const todo of open) {
      if (appWidgetOf(todo.widget)?.messageId === message.id) tasks.setStatus(todo.id, 'cancelled', by, 'Its message was deleted');
    }
  } catch (error) {
    core.s.log?.warn('mini-app to-dos of a deleted message not cancelled', { messageId: message.id, error: String(error) });
  }
}

/** Startup: this PC's messages left 'streaming' by a crash become 'stopped' (keeps their text and steps); a silent one goes. */
export function reconcileStreaming(core: ChatCore): number {
  const left = core.msgs.streaming();
  for (const message of left) {
    if (message.silent) { removeMessage(core, message, SYSTEM_ID); continue; }
    const { live, ...meta } = message.meta;
    message.state = 'stopped';
    message.meta = { ...meta, ...(live?.steps.length ? { lines: live.steps } : {}), error: meta.error ?? 'Interrupted' };
    core.msgs.update(message);
    core.s.bus.emit('message.updated', message);
  }
  return left.length;
}

type PublishEvent = 'message.created' | 'message.updated';

/**
 * Announces a stored message: the event, the chat summary and (when asked) delivery. An agent
 * message whose ```ui blocks name local files or file ids, or that carries engine files, is
 * announced once those files are stored and the body/attachments are updated.
 */
export function publish(core: ChatCore, message: Message, event: PublishEvent, options: { deliver: boolean; files?: EngineFile[] }): void {
  const { s } = core;
  const files = options.files?.length ? options.files : undefined;
  const refs = message.authorKind === 'agent' && message.kind === 'text' && message.state === 'final' && hasOutputRefs(message.body);
  if (!s.files || !s.paths || (!refs && !files)) { announce(core, message, event, options.deliver); return; }
  void storeOutputs(core, message, refs, files)
    .then((current) => { if (current) announce(core, current, event, options.deliver); })
    .catch((error) => s.log?.error('agent outputs not published', { messageId: message.id, error: String(error) }));
}

function announce(core: ChatCore, message: Message, event: PublishEvent, deliver: boolean): void {
  core.s.bus.emit(event, message);
  if (deliver) surface(core, message); // before delivery: a notification then leads to a listed chat
  core.emitConversation(message.conversationId);
  if (deliver) core.deliver(message);
}

/** Stores the outputs and writes the result; undefined when the message was deleted meanwhile. */
async function storeOutputs(core: ChatCore, message: Message, refs: boolean, files: EngineFile[] | undefined): Promise<Message | undefined> {
  const { s } = core;
  const deps = { db: s.db, files: s.files!, paths: s.paths! };
  let body = message.body;
  const notes: string[] = [];
  const added: Attachment[] = [];
  const stored: string[] = [];
  try {
    if (refs) {
      const imported = await importOutputs(deps, { body, agentId: message.authorId, conversationId: message.conversationId }); // F-52: files its readers may see
      body = imported.body;
      notes.push(...imported.notes);
      stored.push(...imported.files.map((file) => file.id));
    }
    if (files) {
      const result = await storeEngineFiles(deps, files);
      added.push(...result.attachments);
      for (const error of result.errors) s.log?.warn('engine file not stored', { messageId: message.id, error });
    }
  } catch (error) {
    s.log?.warn('agent outputs not imported', { messageId: message.id, error: String(error) });
  }
  const current = core.msgs.get(message.id);
  if (!current) { queueReclaim(s.files, [...stored, ...added.map((file) => file.fileId)]); return undefined; } // MM6: nothing holds them
  const nextBody = current.body === message.body ? body : current.body; // a person's edit wins
  if (nextBody !== body) queueReclaim(s.files, stored); // the edited body does not name them
  const known = new Set(current.attachments.map((file) => file.fileId));
  const attachments = [...current.attachments, ...added.filter((file) => !known.has(file.fileId))];
  if (nextBody !== current.body || attachments.length !== current.attachments.length) {
    current.body = nextBody;
    current.attachments = attachments;
    core.msgs.update(current);
  }
  if (notes.length) saveOutputNotes(s.db, s.clock.now(), message.authorId, message.conversationId, notes);
  return current;
}
