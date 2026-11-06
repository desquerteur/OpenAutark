// A person's perspective (F-52): what a person's device receives, with ids projected so the shared
// UI (built around 'human' = the one using it) works unchanged – in a person's session 'human' is
// the caller and the CEO appears as OWNER_ALIAS ('owner'); other people and agents keep their ids.
// Incoming ids are mapped back (realId) before anything is checked or stored. Projections also drop
// what a person never sees: the owner's drafts, a message's secret handles, chat settings beyond the shared ones, agents'
// instructions and policies, other people's devices and scopes, the owner's
// settings and this PC's data folder.
// Owns: the id mapping and the per-type projections. Never: decides access (people/access.ts).

import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSettings, ConversationSummary, Member, Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { DEFAULT_PERSON_SCOPES, OWNER_ALIAS, type Person } from '../../shared/model/people.ts';
import type { Settings, SystemInfo } from '../../shared/model/system.ts';
import type { Task, TaskView } from '../../shared/model/tasks.ts';
import { defaultSettings } from '../settings/defaults.ts';
import { chatTitleFor } from '../chat/titles.ts';

/** Stored id → the person's view of it. */
export function viewId(self: string, id: string): string;
export function viewId(self: string, id: string | undefined): string | undefined;
export function viewId(self: string, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (id === self) return HUMAN_ID;
  if (id === HUMAN_ID) return OWNER_ALIAS;
  return id;
}

/** An id the person sent → the stored id. */
export function realId(self: string, id: string): string;
export function realId(self: string, id: string | undefined): string | undefined;
export function realId(self: string, id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (id === HUMAN_ID) return self;
  if (id === OWNER_ALIAS) return HUMAN_ID;
  return id;
}

/**
 * Chat settings a person sees: the shared look and history rule, (B-050 K1/K2) the default-1:1 mark with its pair in
 * their view and (B-078) where a sub-chat or thread sits (parentId, anchorId – chat and message ids), nothing of the
 * owner's choices.
 */
function sharedSettings(self: string, settings: ConversationSettings): ConversationSettings {
  const out: ConversationSettings = {};
  if (settings.image) out.image = settings.image;
  if (settings.history) out.history = settings.history;
  if (settings.mode) out.mode = settings.mode;
  if (settings.hiddenFromList) out.hiddenFromList = true;
  if (settings.parentId) out.parentId = settings.parentId;
  if (settings.anchorId) out.anchorId = settings.anchorId;
  if (settings.direct) {
    out.direct = true;
    if (settings.directPair?.length === 2) {
      const [a, b] = settings.directPair.map((id) => viewId(self, id)).sort();
      out.directPair = [a, b];
    }
  }
  return out;
}

export function viewMember(self: string, member: Member): Member {
  return { ...member, memberId: viewId(self, member.memberId) };
}

/**
 * A message as the person sees it. Member lines name "you" from the owner's side ("Added You" = the
 * owner); with `nameOf` they are re-worded for the person ("Added Mara", "Added you").
 */
export function viewMessage(self: string, message: Message, nameOf?: (id: string) => string | undefined): Message {
  const meta = { ...message.meta };
  delete meta.secrets; // secret handles belong to the owner's vault
  const view = { ...message, authorId: viewId(self, message.authorId), mentions: message.mentions.map((id) => viewId(self, id)), meta };
  const status = message.kind === 'status' ? message.meta.status : undefined;
  const memberId = typeof status?.details?.memberId === 'string' ? status.details.memberId : undefined;
  if (nameOf && memberId && (status!.type === 'member_added' || status!.type === 'member_removed')) {
    const who = memberId === self ? 'you' : nameOf(memberId) ?? 'a former member';
    view.body = `${status!.type === 'member_added' ? 'Added' : 'Removed'} ${who}`;
    meta.status = { ...status!, text: view.body, details: { ...status!.details, memberId: viewId(self, memberId) } };
  }
  return view;
}

/** A list row as the person sees it; `unread`, `important` (B-050 K4: the red badge) and the preview follow the person's cursor and visible time. */
export function viewSummary(self: string, summary: ConversationSummary, own: { unread: number; important?: number; from: number }): ConversationSummary {
  const { draft: _draft, importantUnread: _important, ...rest } = summary; // the owner's counts are not the person's
  const view: ConversationSummary = {
    ...rest,
    createdBy: viewId(self, summary.createdBy),
    pinned: false,
    settings: sharedSettings(self, summary.settings),
    members: summary.members.map((member) => viewMember(self, member)),
    unread: own.unread,
  };
  if ((own.important ?? 0) > 0) view.importantUnread = own.important;
  if (summary.lastPreview && summary.lastPreview.at >= own.from) view.lastPreview = { ...summary.lastPreview, authorId: viewId(self, summary.lastPreview.authorId) };
  else delete view.lastPreview;
  if (summary.replies?.authorId) view.replies = { ...summary.replies, authorId: viewId(self, summary.replies.authorId) };
  return view;
}

function viewTaskRow<T extends Task>(self: string, task: T): T {
  const view = { ...task, createdBy: viewId(self, task.createdBy) } as T;
  if (task.assignedBy !== undefined) view.assignedBy = viewId(self, task.assignedBy);
  if (task.assigneeKind === 'human') {
    // The caller's own work reads as "mine"; the owner's as the CEO's.
    if (task.assigneeId === self) delete view.assigneeId;
    else view.assigneeId = task.assigneeId === undefined || task.assigneeId === HUMAN_ID ? OWNER_ALIAS : task.assigneeId;
  }
  if (task.waitingOn?.id !== undefined) view.waitingOn = { ...task.waitingOn, id: viewId(self, task.waitingOn.id) };
  return view;
}

/** `conversationTitle`: the chat as the person sees it (viewTaskFor) – TaskView's own is the owner's view. */
export function viewTask(self: string, task: TaskView, conversationTitle?: string): TaskView {
  const view = { ...viewTaskRow(self, task), steps: task.steps.map((step) => viewTaskRow(self, step)) };
  if (conversationTitle !== undefined) view.conversationTitle = conversationTitle;
  return view;
}

/** B-050 K2: viewTask with the task's chat named as the person sees it (chat/titles.ts) – never after themselves. */
export function viewTaskFor(s: Parameters<typeof chatTitleFor>[0], self: string, task: TaskView): TaskView {
  return viewTask(self, task, task.conversationId ? chatTitleFor(s, task.conversationId, self) : '');
}

/** An agent as a colleague sees it: identity, place in the org and live status – no setup. */
export function viewAgent(self: string, agent: Agent): Agent {
  return {
    id: agent.id, name: agent.name, role: agent.role, avatar: agent.avatar, spaceId: agent.spaceId, managerId: viewId(self, agent.managerId),
    team: agent.team, instructions: '', mode: agent.mode, skills: [], modelPolicy: {} as Agent['modelPolicy'],
    status: agent.status, statusNote: agent.statusNote, createdBy: viewId(self, agent.createdBy),
    createdAt: agent.createdAt, updatedAt: agent.updatedAt, ...(agent.archivedAt !== undefined ? { archivedAt: agent.archivedAt } : {}),
  };
}

/** The directory entry of a person: no devices, invites or other people's scopes. */
export function viewPerson(self: string, person: Person): Person {
  const { devices: _devices, inviteOpenUntil: _invite, revokedAt: _revoked, ...rest } = person;
  return { ...rest, id: viewId(self, person.id), managerId: viewId(self, person.managerId), scopes: person.id === self ? person.scopes : DEFAULT_PERSON_SCOPES };
}

/** Settings a person's app reads: defaults with the person's name; nothing of the owner's setup. */
export function personSettings(owner: Settings, person: Person): Settings {
  const base = defaultSettings({ locale: owner.profile.language, timezone: owner.profile.timezone });
  return {
    ...base,
    profile: { ...base.profile, name: person.name, language: owner.profile.language, timezone: owner.profile.timezone },
    onboarding: { completed: true, step: 'done' },
  };
}

/** System facts for a person's app: version and platform, never this PC's data folder. */
export function personSystemInfo(info: SystemInfo): SystemInfo {
  return { version: info.version, platform: info.platform, arch: info.arch, dataDir: '', deviceId: info.deviceId, deviceName: info.deviceName, packaged: info.packaged, startedAt: info.startedAt };
}
