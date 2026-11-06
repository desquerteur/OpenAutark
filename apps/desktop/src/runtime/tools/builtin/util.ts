// Shared helpers for the built-in tools: typed definition, time parsing, chat resolution, member names
// (B-050 K3: the owner, people of the organisation (per_…) and agents alike), the check of a member id and the
// title a chat has for the agent (B-050 K2). B-054 (owner 29.10.2026: tasks and to-dos belong to no chat):
// resolveChat is for real chat tools (a chat is required); chatIfAny is for tools whose work needs no chat
// (tasks, to-dos, routines) – it hands the work over in the run's chat only when the agent is in it, else in none;
// never out of a bounded chat (people's) the agent is not in (refused, F-52), never into an inert To-do/Inbox chat.
// Owns: small pure helpers used by several tool files.
// Never: performs side effects of its own (beyond reading services).

import type { ToolContext, ToolDef } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { Conversation, Member } from '../../../shared/model/chat.ts';
import { displayTitle } from '../../../shared/text/chat-names.ts';
import { externalMemberLabel } from '../../../shared/model/external-agents.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { activePerson } from '../../people/repo.ts';
import { memberName } from '../../chat/titles.ts';
import '../../contracts/people.ts';

/**
 * B-057 S15: the chat a call READS in – its own, else (a split's call, which has no chat) its parent's. A split reads what
 * its main self may read there: the F-52 reach, the readers' audience of notes and references, the owner-only calendar.
 * Posting and placing work keep ctx.conversationId (a split has none).
 */
export const readChat = (ctx: Pick<ToolContext, 'conversationId' | 'split'>): string | undefined => ctx.conversationId ?? ctx.split?.parentConversationId;

/** Typed tool definition (args typed per tool, stored as the generic ToolDef). */
export function defineTool<A>(def: ToolDef<A>): ToolDef {
  return def as unknown as ToolDef;
}

/** Reversible internal action (messages in own chats, tasks, memory). */
export const internal = (summary: string, resource?: string) => ({ summary, resource, reversible: true, external: false });

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
const RELATIVE = /^(?:in\s+)?\+?(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?)$/i;

/**
 * Parses a point in time: epoch ms, ISO datetime, ISO duration ("PT2H" = from now) or a
 * short relative form ("+24h", "in 30m", "2d"). Returns epoch ms or undefined.
 */
export function parseWhen(value: unknown, now: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  const duration = DURATION.exec(text);
  if (duration && text.length > 1 && text.toUpperCase() !== 'PT') {
    const [, d, h, m, s] = duration;
    const ms = ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60_000 + Number(s ?? 0) * 1000;
    return ms > 0 ? now + ms : undefined;
  }
  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2][0].toLowerCase();
    const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
    return now + amount * factor;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The chat a tool acts on: explicit id, else the run's chat. Checks the agent is a member. An archived
 *  chat counts like any other (C2: archive only hides it from the person's list). */
export function resolveChat(ctx: ToolContext, chatId: string | undefined, options: { mustBeMember?: boolean; read?: boolean } = {}): string {
  const id = chatId || ctx.conversationId;
  if (!id) throw new WorkforceError('bad_request', NO_CHAT_TEXT);
  const conversation = ctx.services.chats.get(id);
  if (!conversation) throw new WorkforceError('not_found', `Chat ${id} not found.`);
  if (options.mustBeMember !== false && !isMember(ctx, id)) {
    throw new WorkforceError('forbidden', `I am not a member of chat ${id}.`);
  }
  return id;
}

/** resolveChat's error for a run in no chat (B-054): what to do instead – chat tools need a chat, work does not. */
export const NO_CHAT_TEXT = 'This run is in no chat. Pass chatId for a chat tool. To write to someone: chat.send {to}. Tasks and to-dos need no chat.';

/**
 * B-054: the chat a task, to-do or routine is handed over in, if any. An explicit chatId goes through resolveChat
 * (it must exist, the agent must be a member); otherwise the run's chat when the agent is a current member there;
 * otherwise undefined – the work is created chat-free.
 */
export function chatIfAny(ctx: ToolContext, chatId: string | undefined): string | undefined {
  if (chatId) return resolveChat(ctx, chatId);
  const id = ctx.conversationId;
  if (!id) return undefined;
  const chat = ctx.services.chats.get(id);
  // The inert To-do / Inbox chats of older builds (B-054 migration 82) hand nothing over any more.
  const system = chat?.settings?.system;
  if (!chat || (system !== undefined && STAND_INS.has(system))) return undefined;
  if (isMember(ctx, id)) return id;
  return undefined;
}

const STAND_INS: ReadonlySet<string> = new Set(['todo', 'inbox']);

export function isMember(ctx: ToolContext, conversationId: string, memberId: string = ctx.agent.id): boolean {
  return ctx.services.chats.members(conversationId).some((member) => member.memberId === memberId && !member.leftAt);
}

/** Display name for an author id; an 'ext:' member reads "(external agent)" or "(external contact)" (C8), a person by name (F-52). */
export function authorName(ctx: ToolContext, id: string): string {
  if (id === HUMAN_ID) return ctx.services.settings.get().profile.name || 'Human';
  if (id === 'system') return 'System';
  const external = externalMemberLabel(id);
  if (external) return external;
  if (isPersonId(id)) return ctx.services.people?.nameOf(id) ?? id;
  return ctx.services.org.get(id)?.name ?? id;
}

/** The chat's title as this agent sees it (shared/text/chat-names.ts displayTitle with the runtime's member names, chat/titles.ts: a two-member room is named after the other member). */
export function viewTitle(ctx: ToolContext, chat: Pick<Conversation, 'title' | 'titleNamed' | 'settings'>, members: readonly Member[]): string {
  return displayTitle(chat, members.filter((member) => !member.leftAt), ctx.agent.id, (id) => memberName(ctx.services, id));
}

/** The member ids a chat tool names: `members`, plus the older `agentIds` and `includeHuman` (B-050 K3), once each. */
export function memberIds(args: { members?: string[]; agentIds?: string[]; includeHuman?: boolean }): string[] {
  return [...new Set([...(args.members ?? []), ...(args.agentIds ?? []), ...(args.includeHuman ? [HUMAN_ID] : [])].map((id) => id.trim()).filter(Boolean))];
}

/** Why `id` cannot be a chat member an agent adds (B-050 K3: an agent, 'human' or a person of the organisation); undefined when it can. */
export function memberRefusal(ctx: ToolContext, id: string): string | undefined {
  if (id === HUMAN_ID) return undefined;
  if (isPersonId(id)) return activePerson(ctx.services.db, id) ? undefined : `${id} is not a person of the organisation (any more).`;
  return ctx.services.org.get(id) ? undefined : `Unknown agent ${id}.`;
}

export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}
