// Events the runtime pushes to subscribed clients (and that runtime modules publish on the
// in-process bus). Owns: event names → payload types and which topic carries them.
// Never: sends full state snapshots for small changes – events are deltas. B-075: a run's streaming answer has no
// event of its own – its row is written (body and meta.live, throttled) and goes out as message.updated.

import type { Agent, Space } from '../model/org.ts';
import type { ConversationSummary, Message } from '../model/chat.ts';
import type { Schedule, TaskView } from '../model/tasks.ts';
import type { Account, ModelInfo, UsageSummary } from '../model/providers.ts';
import type { Device, PwaState } from '../model/devices.ts';
import type { AgentActivity, Run, RunItem } from '../model/runs.ts';
import type { FeedbackReport, Settings, UpdateState } from '../model/system.ts';
import type { KnowledgeItem } from '../model/knowledge.ts';
import type { MediaInfo } from '../model/media.ts';
import type { Bridge } from '../model/bridges.ts';
import type { ComputerActivityState } from '../model/computer.ts';
import type { WorkStopState } from '../model/work-stop.ts';
import type { BrowserFrame, BrowserViewState } from '../model/browser.ts';
import type { PointerState } from '../model/pointers.ts'; // B-055
import type { CalendarEvent } from '../model/calendar.ts';
import type { Topic } from './protocol.ts';

export interface EventMap {
  // chats / messages
  'conversation.upserted': ConversationSummary;
  'conversation.removed': { id: string };
  'message.created': Message;
  'message.updated': Message;
  'message.removed': { id: string; conversationId: string };
  // tasks
  'task.upserted': TaskView;
  'task.removed': { id: string; conversationId?: string }; // no conversationId: a chat-free task (B-054)
  'schedule.upserted': Schedule;
  'schedule.removed': { id: string };
  /** B-041 My day (shared/model/calendar.ts): a calendar row of a member was created or changed (topic 'tasks', 'todo' devices). */
  'calendar.upserted': CalendarEvent;
  /** B-041: a calendar row went (ids only; topic 'tasks', 'todo' devices). */
  'calendar.removed': { id: string; ownerId: string; taskId?: string };
  /** B-041: a member's morning briefing of `date` was written – read it with day.briefing (topic 'tasks', 'todo' devices). */
  'day.briefing': { ownerId: string; date: string };
  /** B-041: a member's connected calendars changed – read them with calendar.sources (topic 'system', owner only). */
  'calendar.sources': { ownerId: string };
  /** A connector was added, changed (status, tools) or removed – read them with apps.list
   *  (topic 'system', owner only; `id` the connector that changed). */
  'apps.changed': { id: string };
  /** A skill was saved or deleted (skills are plain SKILL.md folders); topic 'system' (owner). */
  'skills.changed': { name?: string };
  // org
  'agent.upserted': Agent;
  'agent.removed': { id: string };
  'agent.activity': { active: AgentActivity[] };
  'space.upserted': Space;
  'run.upserted': Run;
  'run.item': RunItem;
  // providers
  'account.upserted': Account;
  'account.removed': { id: string };
  'usage.updated': UsageSummary[];
  'models.updated': ModelInfo[];
  // system
  'settings.updated': Settings;
  /** B-044: the quiet notice of <data>/settings.json – a section was not used (text), or it went (no text); topic system, owner only. */
  'settings.notice': { text?: string };
  'device.upserted': Device;
  'device.removed': { id: string };
  'pwa.updated': PwaState;
  'update.state': UpdateState; // forwarded from main (updater lives in main)
  'feedback.upserted': FeedbackReport;
  'knowledge.upserted': KnowledgeItem;
  /** CTX5: items forgotten permanently – every version of the forgotten item's correction chain (topic: system). */
  'knowledge.removed': { ids: string[] };
  /** CTX8: a user mode was saved or deleted – cached modes.list copies are stale (topic: system, 'chat' devices). */
  'modes.changed': { key: string };
  // added by R4 contracts
  /** A media row was created or changed (topic: its chat, or 'chats' when not linked to one). */
  'media.upserted': MediaInfo;
  /** A chat bridge was created or changed status (disconnect = status 'stopped'). */
  'bridge.upserted': Bridge;
  /** Something that deserves the human's attention (UI decides toast vs OS notification).
   *  `toast` (C3): the runtime's decision for the in-window toast (the chat's notification level); absent from older runtimes. */
  'notify': { kind: 'todo' | 'blocker' | 'important' | 'done' | 'reply' | 'info'; title: string; body: string; conversationId?: string; taskId?: string; toast?: boolean };
  /** MP7: agents' computer use on this PC (at most one per second) and the person's Stop/Resume (topic: system). */
  'computer.activity': ComputerActivityState;
  /** 21.10. 17:09: the person's emergency stop of all agent work on this PC and its Resume (topic: system). */
  'work.state': WorkStopState;
  /** MP8: live view of an agent's browser – its state, and frames (at most 2 per second, only while watched; topic browser:<agentId>, owner). */
  'browser.view': BrowserViewState;
  'browser.frame': BrowserFrame;
  /** MP8: which agents have a browser open on this PC changed (topic: system, owner). */
  'browser.sessions': { open: string[] };
  /** B-055: the named pointers of one surface changed (shared/model/pointers.ts; at most one per surface every 100 ms; topic: system, owner). */
  'pointers.changed': PointerState;
  /** C8: a message @mentions an external agent of the chat (topic chat:<id>: that agent's socket, the owner) – no engine turn. */
  'external.mention': { conversationId: string; memberId: string; messageId: string; seq: number };
  /** C8: an external agent's access ended (removed from its chat, or the chat was deleted); its socket closes (topic: system, owner). */
  'external.revoked': { memberId?: string; conversationId: string };
}

export type EventName = keyof EventMap;

/** Which topic carries an event (with optional id suffix). */
export function topicOf(event: EventName, data: unknown): Topic {
  const value = data as { conversationId?: string; agentId?: string; id?: string };
  switch (event) {
    case 'message.created':
    case 'message.updated':
    case 'message.removed':
    case 'external.mention': // C8
    case 'notes.updated': // wave 3: a new version of the chat's shared notes (shared/model/notes.ts)
      return `chat:${value.conversationId ?? ''}`;
    case 'conversation.upserted':
    case 'conversation.removed':
    case 'bridge.upserted':
      return 'chats';
    case 'media.upserted':
      return value.conversationId ? `chat:${value.conversationId}` : 'chats';
    case 'task.upserted':
    case 'task.removed':
    case 'schedule.upserted':
    case 'schedule.removed':
    case 'calendar.upserted': // B-041 My day: calendar rows and the briefing (calendar.list / day.briefing are 'todo')
    case 'calendar.removed':
    case 'day.briefing':
      return 'tasks';
    case 'agent.upserted':
    case 'agent.removed':
    case 'agent.activity':
    case 'space.upserted':
    case 'person.upserted': // F-52: people of the organisation (shared/model/people.ts)
      return 'org';
    case 'run.upserted':
    case 'split.upserted': // B-057: a split group of that agent (shared/model/splits.ts)
      return `runs:${(data as { agentId?: string }).agentId ?? ''}`;
    case 'browser.view':
    case 'browser.frame':
      return `browser:${value.agentId ?? ''}`;
    case 'run.item':
      return 'org'; // run items are also delivered on runs:<agentId> by the server (it knows the run)
    case 'account.upserted':
    case 'account.removed':
    case 'usage.updated':
    case 'models.updated':
      return 'providers';
    case 'calendar.sources': // B-041: connected calendars – owner only (rpc/scopes.ts lets no device hear it)
    case 'apps.changed': // connectors – owner only (rpc/scopes.ts lets no device hear it)
      return 'system';
    default:
      return 'system';
  }
}
