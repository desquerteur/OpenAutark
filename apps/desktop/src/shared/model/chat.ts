// Chat model: conversations (WhatsApp-like channels), members and the canonical message log.
// Owns: shapes for chats/messages/attachments, message levels (B-050), sub-chats and threads (B-078) and a run's live values in its row (B-075: meta.live,
// meta.ms, meta.lines – a run's status is a value in the chat, synced and rendered like a message). A chat is NOT an agent; agents are members.
// Never: duplicates message text anywhere else (tasks reference messages by id) – except a call row's transcript lines
// (shared/model/call.ts), kept in step by runtime/calls/call-log.ts.

import type { StepKind } from '../text/step-label.ts';

export type MemberKind = 'human' | 'agent' | 'external';

export interface Member {
  conversationId: string;
  memberId: string; // 'human', an agent id, or 'ext:<bridge>:<id>'
  kind: MemberKind;
  role: 'owner' | 'lead' | 'member' | 'observer'; // lead = answers un-addressed group messages
  readSeq: number; // human: read cursor; agent: last seq delivered into its context
  joinedAt: number;
  leftAt?: number;
}

export type NotificationLevel = 'default' | 'all' | 'mentions' | 'off';

export interface ConversationSettings {
  notifications?: NotificationLevel;
  sound?: boolean;
  /** Sticky model choice per member agent (agentId → model id or 'auto'). */
  models?: Record<string, string>;
  efforts?: Record<string, string>;
  mode?: string; // active mode for this chat (status line on change)
  image?: string; // file id or emoji for groups
  hiddenFromList?: boolean; // agent-only work groups ("Team activity")
  /**
   * App-owned chat (C1): the Customize chat, or the inert pre-B-054 To-do / Inbox chat. Such a chat is in no chat
   * list (shared/text/chat-sections.ts). Set by the runtime only – clients can never set it.
   */
  system?: SystemChat;
}

/** Kinds of app-owned chats (ConversationSettings.system). */
export type SystemChat = 'todo' | 'customize' | 'inbox'; // all inert: the old anchor chats (B-054) and the old overlay's Customize chat – kept for stored rows

export interface Conversation {
  id: string;
  title: string;
  titleNamed: boolean; // true once a human/agent explicitly named it
  spaceId?: string;
  createdBy: string;
  pinned: boolean;
  settings: ConversationSettings;
  lastMessageAt?: number;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** List row projection: what the chat list needs without loading messages. */
export interface ConversationSummary extends Conversation {
  members: Member[];
  unread: number;
  /** B-041: how many of the unread messages are marked important (priority 'important'); left out when none. */
  importantUnread?: number;
  lastPreview?: { authorId: string; text: string; at: number };
  /** B-078, threads only (settings.anchorId): its real replies – finished, non-silent lines that are no status line – and who wrote the last one. */
  replies?: { count: number; authorId?: string };
  working: string[]; // agent ids running in this chat (B-075: the authors of its rows in state 'streaming')
  openTasks: number;
  draft?: string;
}

export type MessageKind =
  | 'text' // normal message (markdown + fenced blocks)
  | 'task' // anchors a task (tasks.message_id)
  | 'status' // quiet system line: model switch, member joined, task done …
  | 'answer'; // a human's answer to an ask block / widget (rendered as a receipt)

export type MessageState = 'streaming' | 'final' | 'failed' | 'stopped';

export interface Attachment {
  fileId: string; // sha256 of content
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  authorId: string; // 'human', agent id, 'system'
  authorKind: 'human' | 'agent' | 'system' | 'external';
  kind: MessageKind;
  body: string; // markdown with ```mermaid/```ui/```app fences
  attachments: Attachment[];
  mentions: string[]; // agent ids addressed with @
  priority: 'normal' | 'important';
  replyTo?: string;
  runId?: string; // the agent run that produced it
  taskId?: string; // for kind 'task' and status lines about a task
  state: MessageState;
  silent: boolean; // quiet line: never unread/pushed
  meta: MessageMeta;
  createdAt: number;
  editedAt?: number;
}

export interface MessageMeta {
  /** References only; values are stored by the vault before attachment. */
  secrets?: string[];
  model?: string; // which model produced an agent message (shown small, never as identity)
  effort?: string;
  via?: 'voice' | 'schedule' | 'bridge' | 'mini-app' | 'phone';
  scheduleId?: string;
  error?: string; // short safe failure text for failed/stopped messages
  status?: StatusLine; // for kind 'status'
  answer?: { blockKey: string; taskId?: string; summary: string; question?: string }; // for kind 'answer'; question: what the block asked (B-076)
  [key: string]: unknown;
}

/** Structured payload of a quiet status line. */
export interface StatusLine {
  type:
    | 'model_switched' | 'mode_switched' | 'member_added' | 'member_removed' | 'renamed'
    | 'task_created' | 'task_claimed' | 'task_done' | 'task_blocked' | 'schedule_created'
    | 'handoff' | 'approval' | 'guardian' | 'note'
    | 'unarchived' | 'lead_changed'; // C2
  text: string; // one short English line
  details?: Record<string, unknown>;
}

/** Input to send a message (human or agent). */
export interface SendMessageInput {
  conversationId: string;
  secrets?: string[];
  body: string;
  attachments?: Attachment[];
  mentions?: string[];
  priority?: 'normal' | 'important';
  replyTo?: string;
  /** Suggested model for the addressed agent (a hint stored on the message as meta.modelHint and as the chat's model hint); 'auto' clears; pin: true pins it. */
  model?: string;
  effort?: string;
  clientId?: string; // idempotency key from the client (double-send guard)
}

// ------------------------------------------------------------------ spoken messages

/** A dictated or spoken message (meta.speech, with meta.via 'voice'); `source` 'windows' only on older rows. */
export interface SpeechMeta {
  source: 'windows' | 'endpoint';
}

export interface SendMessageInput {
  /** The message was dictated or spoken. */
  speech?: SpeechMeta;
}

export interface MessageMeta {
  speech?: SpeechMeta;
}

// ------------------------------------------------------------------ added by C2 (archive, agent membership tools)

export interface ConversationSettings {
  /**
   * Who last renamed the chat ('human' or an agent id) – set by the runtime on a rename, never by
   * a client. Absent: a title given at creation was given by `createdBy`. Agents never rename a
   * chat the person named (tools/builtin/chat-members.ts).
   */
  namedBy?: string;
  /** Reply mode per agent member in a group (absent = 'auto'; runtime/chat/reply-modes.ts). */
  replyModes?: Record<string, ReplyMode>;
}

/**
 * How an agent answers un-addressed messages in one group chat: 'auto' (the lead or the responder decision picks),
 * 'mentions' (only when @mentioned), 'all' (every message of the person or an external member). A stored 'events'
 * (from the removed task subscriptions) reads as 'mentions'.
 */
export type ReplyMode = 'auto' | 'mentions' | 'all';
export const REPLY_MODES: readonly ReplyMode[] = ['auto', 'mentions', 'all'];

declare module '../api/methods.ts' {
  interface Methods {
    /** C2 ('chat'): the chat comes back into the list (archiving only hides it; its agents keep working). */
    'chats.unarchive': { params: { id: string }; result: { ok: true } };
    /** B-078 ('chat'): the thread on a message – found, or opened now with its chat's members (runtime/chat/children.ts). */
    'chats.thread': { params: { messageId: string }; result: Conversation };
  }
}

// ------------------------------------------------------------------ added by B-047 D4 (publishing)

/**
 * Where an agent's final text went (the run item 'Answer' carries it as data.visibility): kept in
 * its run journal only, posted quietly (no unread, no notification) or posted with a notification.
 */
export type AnswerVisibility = 'internal' | 'silent' | 'notify';

export interface MessageMeta {
  /**
   * The run during which the runtime created this process row – a task anchor or approval to-do
   * the run caused, a status line of the turn, the agent's chat.send status update. The UI may fold
   * it into that run's steps. Message.runId stays the run's own output (its answer, its posts).
   */
  fromRun?: string;
  /** Posted by the agent with chat.send during a run (Message.runId names it): a publication of that run, not its final answer. */
  sentDuringRun?: boolean;
  /** B-059 #74: on a run's answer – how many tool calls the run made (or `thought`: it only reasoned); the chat shows its line from the first frame. */
  steps?: number;
  thought?: boolean;
}

// ------------------------------------------------------------------ added by B-050 (equal chats, three levels, model tag)

/** How loud a message is (K4), both ways; stored as `priority` + `silent`, read through messageLevel() (quiet wins over important). */
export type MessageLevel = 'normal' | 'important' | 'silent';

export function messageLevel(m: Pick<Message, 'priority' | 'silent'>): MessageLevel {
  return m.silent ? 'silent' : m.priority === 'important' ? 'important' : 'normal';
}

export function levelFields(level: MessageLevel): { priority: 'normal' | 'important'; silent: boolean } {
  return { priority: level === 'important' ? 'important' : 'normal', silent: level === 'silent' };
}

export interface ConversationSettings {
  direct?: boolean; // K1: the default 1:1 of a pair (runtime/chat/direct.ts); runtime-only (clients never set it); held while both of the pair are active members
  directPair?: [string, string]; // K1: that pair, sorted ids (a mark without it: its two active members)
}

/** K1: the two members whose default 1:1 this is – the stored pair, else (an older mark) its two active members; undefined when unmarked. */
export function directPair(settings: ConversationSettings, active: ReadonlyArray<{ memberId: string }>): readonly string[] | undefined {
  if (settings.direct !== true) return undefined;
  if (settings.directPair?.length === 2) return settings.directPair;
  return active.length === 2 ? active.map((member) => member.memberId).sort() : undefined;
}

export interface SendMessageInput {
  silent?: boolean; // quiet: lands in the history, wakes only @mentioned members, never unread or pushed
  pin?: boolean; // with `model`: pin it for the addressed agent instead of a hint (K6)
}

/** K6: a model someone asked for – a recommendation for whoever takes the work; `pinned`: pinned for the addressed agent. */
export interface ModelTag { modelId: string; effort?: string; pinned?: boolean }
export interface MessageMeta {
  modelHint?: ModelTag; // the model asked for with this message – a recommendation for whoever takes the work, shown small under it; absent = Auto
}

// ------------------------------------------------------------------ added by B-075 (live status as values in the chat)

/**
 * A run step as a value in its chat row: a step label (shared/text/step-label.ts) – never a tool's input or output.
 * `thought`: a reasoning summary's headline ("Thought · <target>"); `running`: the call still runs (or the thought is
 * still written); `failed`: the call failed.
 */
export interface LiveStep { kind: StepKind; verb: string; active: string; target: string; running?: true; failed?: true; thought?: true }

/** Steps a run's row shows while it works (meta.live.steps); earlier ones are only counted (`more`). */
export const LIVE_STEPS = 6;
/** Steps a finished answer keeps (meta.lines, the newest). */
export const LINES_MAX = 60;

/**
 * B-075: what a run's row (state 'streaming') says while the run works – written by the runtime (runtime/chat/live-row.ts),
 * synced with the row like any message, rendered by every device; a channel like WhatsApp leaves it out (final rows only).
 */
export interface LiveMeta {
  /** What the agent does or waits for right now (the run's live note, also waiting and approval notes). */
  note?: string;
  /** The newest steps, oldest first (at most LIVE_STEPS). */
  steps: LiveStep[];
  /** How many earlier steps are not in `steps`. */
  more: number;
  /** What the run runs on now (display name) · effort – after a failover too. */
  model?: string;
  effort?: string;
  taskId?: string;
  startedAt: number;
}

export interface MessageMeta {
  /** B-075: only while the row streams (removed when it is finished). */
  live?: LiveMeta;
  /** B-075: on a run's finished row – how long the run worked (ms) and its steps (the newest LINES_MAX). */
  ms?: number;
  lines?: LiveStep[];
}

/** B-075: one run working in a chat, from its row (ConversationSummary.live). */
export interface LiveRun { runId: string; agentId: string; messageId: string; note?: string; model?: string; effort?: string; taskId?: string; startedAt: number }

export interface ConversationSummary {
  /** B-075: the chat's runs at work – its rows in state 'streaming' (absent when none); `working` names their agents. */
  live?: LiveRun[];
}

// ------------------------------------------------------------------ added by B-078 (sub-chats and threads)

export interface ConversationSettings {
  /**
   * A sub-chat: the chat it sits under in the list (one level – the parent is never a sub-chat itself; checked by
   * runtime/chat/children.ts). Set by the person (chats.update) or an agent (chat.set_parent, chat.thread).
   */
  parentId?: string;
  /** A thread: the message of the parent chat it answers (always with parentId). A thread is never in the chat list. */
  anchorId?: string;
}
