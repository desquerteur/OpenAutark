// Which pushed events a client may see. Method access is decided by the handler table
// (table.ts `allowedScope`); this file decides the event side for subscriptions.
//   owner   – every topic.
//   device  – a paired phone/browser of the owner (B5: every device token carries FULL_ACCESS, one tier):
//             'org'; 'chats' and 'chat:<id>' with the 'chat' capability; 'tasks' with 'todo' or 'tasks' (there
//             My day's calendar.upserted / calendar.removed / day.briefing only with 'todo', like calendar.list and
//             day.briefing); 'providers' with 'chat', but only usage.updated / models.updated – B-078: account.upserted /
//             account.removed too for 'settings' on a secure transport (the phone app's tunnel, as accounts.* itself);
//             'runs:<agentId>' with 'manage' (run.upserted, run.item, split.upserted); from 'system'
//             update.state and theme.updated (theme.get is open to every device) and notify (without 'chat' only the
//             My-day kinds 'todo' / 'blocker'); feedback.upserted, knowledge.upserted, knowledge.removed and
//             modes.changed with 'chat'; settings.updated with 'settings' or 'permissions'. computer.activity and
//             work.state (the stops of computer use and agent work) reach every device with 'todo';
//             browser.sessions (agent ids only) devices with 'todo' on a secure transport. tabs.changed and
//             tabs.position (B-076: the PC's side pane, which the phone shows too) devices with 'manage'. pwa.updated,
//             calendar.sources and 'browser:<agentId>' (the live view – devices pull frames with browser.pull)
//             stay with the owner.
//   external – C8: only 'chat:<its chat>', and there message.created/updated/removed and the
//             external.mention of itself or of one of its sub-identities (members 'ext:api:<its key>:…',
//             bridges/external-rpc.ts) – no run's row while it streams (B-075: its live values), no media, task or list events; messages as
//             `externalMessage` (no run id, no meta besides a status line's type and text and the model tag).
//   person  – an employee's device: runtime/people/events.ts decides (rpc/server.ts), not this file.
//   peer / agent – nothing (they never use the client RPC surface).
// The same rules serve every transport: /ws, POST /rpc and GET /events (http/rpc.ts, http/sse.ts).
// Bus-only events reach no client at all, whatever the scope (BUS_ONLY): 'task.changed' (ids, states and who
// changed it – runtime listeners only; task.upserted carries every change to the lists), and phone use's own
// 'phoneUse.reply' / 'phoneUse.attached'. B-078: 'phoneUse.request' (on 'system') reaches exactly the device it names –
// not even the owner's window (it can carry text to type) – the phone's topic phoneUse:<deviceId> in effect.
// Owns: topic syntax, the per-scope topic/event filter and per-scope event payloads (also the
// external agent's chat view, `externalChat`).
// Never: method permissions.

import type { EventName } from '../../shared/api/events.ts';
import type { ClientScope, Topic } from '../../shared/api/protocol.ts';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import { isIdLike } from './params.ts';
import { scopeHas } from './table.ts';

const FIXED: ReadonlySet<string> = new Set(['chats', 'tasks', 'org', 'providers', 'system']);
/** Events from the 'system' topic every phone/browser may receive ('notify' is filtered by kind). */
const DEVICE_SYSTEM_EVENTS: ReadonlySet<string> = new Set(['update.state', 'theme.updated']);
/** Events from the 'system' topic for chat-capable devices (feedback/knowledge lists and modes.list are 'chat'). */
const CHAT_SYSTEM_EVENTS: ReadonlySet<string> = new Set(['feedback.upserted', 'knowledge.upserted', 'knowledge.removed', 'modes.changed']);
/** Notification kinds a device without 'chat' may receive (the My-day list's own kinds). */
const FOR_YOU_NOTIFY: ReadonlySet<string> = new Set(['todo', 'blocker']);
/** Events from the 'providers' topic a chat-capable phone/browser may receive (never account.*). */
const DEVICE_PROVIDER_EVENTS: ReadonlySet<string> = new Set(['usage.updated', 'models.updated']);
/** The stops from the phone – every device holding 'todo' sees computer use and agent work (it may stop each). */
const BRAKE_EVENTS: ReadonlySet<string> = new Set(['computer.activity', 'work.state']);
/** B-041: My day's calendar rows and briefing on the 'tasks' topic – for devices holding 'todo' (calendar.list, day.briefing). */
const DAY_EVENTS: ReadonlySet<string> = new Set(['calendar.upserted', 'calendar.removed', 'day.briefing']);
/** B-076: the PC's side pane and its tabs' view positions – for devices holding 'manage' (tabs.get, tabs.positions). */
const PANE_EVENTS: ReadonlySet<string> = new Set(['tabs.changed', 'tabs.position']);
/** Events for runtime listeners only: never sent to any client (see the header). */
const BUS_ONLY: ReadonlySet<string> = new Set(['task.changed', 'phoneUse.reply', 'phoneUse.attached']);
/** B-078: accounts on the phone (accounts.* is 'settings' on a secure transport, rpc/handlers/providers.ts). */
const ACCOUNT_EVENTS: ReadonlySet<string> = new Set(['account.upserted', 'account.removed']);

/** True for a syntactically valid topic ('chats' … or 'chat:<id>' / 'runs:<agentId>' / 'browser:<agentId>'). */
export function isTopic(value: unknown): value is Topic {
  if (typeof value !== 'string') return false;
  if (FIXED.has(value)) return true;
  const match = /^(chat|runs|browser):(.+)$/.exec(value);
  return Boolean(match && isIdLike(match[2]));
}

type DeviceScope = Extract<ClientScope, { kind: 'device' }>;

function deviceTopic(scope: DeviceScope, topic: Topic): boolean {
  if (topic === 'org' || topic === 'system') return true;
  if (topic === 'chats' || topic.startsWith('chat:') || topic === 'providers') return scope.capabilities.includes('chat');
  if (topic === 'tasks') return scope.capabilities.includes('todo') || scope.capabilities.includes('tasks');
  if (topic.startsWith('runs:')) return scope.capabilities.includes('manage');
  return false;
}

function deviceEvent(scope: DeviceScope, topic: Topic, event: EventName, data: unknown): boolean {
  if (topic === 'providers') return DEVICE_PROVIDER_EVENTS.has(event) || (ACCOUNT_EVENTS.has(event) && scope.secure === true && scope.capabilities.includes('settings'));
  if (topic === 'tasks' && DAY_EVENTS.has(event)) return scope.capabilities.includes('todo');
  if (topic !== 'system') return true;
  if (event === 'notify') return scope.capabilities.includes('chat') || FOR_YOU_NOTIFY.has(String((data as { kind?: unknown } | undefined)?.kind));
  if (DEVICE_SYSTEM_EVENTS.has(event)) return true;
  if (CHAT_SYSTEM_EVENTS.has(event)) return scope.capabilities.includes('chat');
  if (BRAKE_EVENTS.has(event)) return scope.capabilities.includes('todo');
  if (PANE_EVENTS.has(event)) return scope.capabilities.includes('manage');
  if (event === 'browser.sessions') return scope.capabilities.includes('todo') && scope.secure === true; // X02: agent ids only
  return event === 'settings.updated' && (scope.capabilities.includes('settings') || scopeHas(scope, 'permissions'));
}

type ExternalScope = Extract<ClientScope, { kind: 'external' }>;
/** C8: what an external agent hears on its chat's topic. */
const EXTERNAL_EVENTS: ReadonlySet<string> = new Set(['message.created', 'message.updated', 'message.removed', 'external.mention']);

function externalEvent(scope: ExternalScope, topic: Topic, event: EventName, data: unknown): boolean {
  if (topic !== `chat:${scope.conversationId}` || !EXTERNAL_EVENTS.has(event)) return false;
  if (event === 'message.created' || event === 'message.updated') return (data as Message | undefined)?.state !== 'streaming'; // B-075
  if (event !== 'external.mention') return true;
  const mentioned = (data as { memberId?: unknown } | undefined)?.memberId;
  return mentioned === scope.memberId || (typeof mentioned === 'string' && mentioned.startsWith(`${scope.memberId.split(':').slice(0, 3).join(':')}:`));
}

/** May this scope hold a subscription to `topic` at all? (Subscriptions it can never use are dropped.) */
export function maySubscribe(scope: ClientScope, topic: Topic): boolean {
  if (scope.kind === 'owner') return true;
  if (scope.kind === 'external') return topic === `chat:${scope.conversationId}`;
  if (scope.kind !== 'device') return false;
  return deviceTopic(scope, topic);
}

/** May this scope receive `event` (payload `data`) that travels on `topic`? */
export function mayReceive(scope: ClientScope, topic: Topic, event: EventName, data?: unknown): boolean {
  if (BUS_ONLY.has(event)) return false;
  if (event === 'phoneUse.request') return scope.kind === 'device' && scope.deviceId === (data as { deviceId?: unknown } | undefined)?.deviceId;
  if (scope.kind === 'owner') return true;
  if (scope.kind === 'external') return externalEvent(scope, topic, event, data);
  if (scope.kind !== 'device') return false;
  return deviceTopic(scope, topic) && deviceEvent(scope, topic, event, data);
}

/** C8: a message as an external agent sees it – no run id, no meta besides a status line's type and text and the model tag (B-050 K6). */
export function externalMessage(message: Message): Message {
  const { runId: _run, meta, ...rest } = message;
  return {
    ...rest,
    meta: {
      ...(meta?.status ? { status: { type: meta.status.type, text: meta.status.text } } : {}),
      ...(meta?.modelHint ? { modelHint: meta.modelHint } : {}),
    },
  };
}

/** C8: its chat as an external agent sees it – no chat settings, space, draft, read cursors or runs at work (B-075). */
export function externalChat(chat: ConversationSummary): ConversationSummary {
  const { settings: _settings, spaceId: _space, draft: _draft, importantUnread: _important, live: _live, ...rest } = chat;
  return {
    ...rest, settings: {}, pinned: false, unread: 0,
    members: chat.members.filter((member) => member.leftAt === undefined).map((member) => ({ ...member, readSeq: 0 })),
  };
}

/** The payload `scope` receives for an event it may see (messages for an external agent). */
export function visibleData(scope: ClientScope, event: EventName, data: unknown): unknown {
  return scope.kind === 'external' && (event === 'message.created' || event === 'message.updated') ? externalMessage(data as Message) : data;
}
