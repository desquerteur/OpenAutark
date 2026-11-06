// Reply modes per agent per group chat: how an agent answers messages (of the person, an external member or a
// colleague) that @mention nobody – 'auto' (absent: the lead or the responder decision picks), 'mentions' (only when
// @mentioned), 'all' (every such message wakes it). An agent's un-addressed line in a group is split the same way
// (chat/delivery-route.ts). A 1:1 chat ignores modes: its one agent always answers. Stored in
// ConversationSettings.replyModes (agent id → mode, 'auto' removes the entry); the person or the agent itself sets it.
// Owns: reading/writing the modes and splitting a group's agents for chat/delivery.ts. Never: wakes anyone.

import { WorkforceError } from '../../shared/errors.ts';
import type { ConversationSummary, ReplyMode } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';

/** The agent's mode in a chat ('auto' when none is set; a stored 'events' reads as 'mentions'). */
export function replyModeOf(chats: Pick<RuntimeServices['chats'], 'get'>, conversationId: string, agentId: string): ReplyMode {
  const mode = chats.get(conversationId)?.settings.replyModes?.[agentId] as string | undefined;
  return mode === 'events' ? 'mentions' : (mode as ReplyMode | undefined) ?? 'auto';
}

/**
 * For an un-addressed message in a group: the agents that always hear it ('all') and the ones the
 * usual pick may choose ('auto'). Undefined when the chat sets no modes (the usual rules apply).
 */
export function replyModeSplit(chats: Pick<RuntimeServices['chats'], 'get'>, conversationId: string, agents: readonly string[]): { always: string[]; pickable: string[] } | undefined {
  if (agents.length < 2) return undefined;
  const modes = chats.get(conversationId)?.settings.replyModes;
  if (!modes || !agents.some((id) => modes[id] && modes[id] !== 'auto')) return undefined;
  return {
    always: agents.filter((id) => modes[id] === 'all'),
    pickable: agents.filter((id) => !modes[id] || modes[id] === 'auto'),
  };
}

/** Sets (or with 'auto' clears) an agent member's mode; returns the chat's summary. */
export function setReplyMode(s: Pick<RuntimeServices, 'chats'>, conversationId: string, agentId: string, mode: ReplyMode, by: string): ConversationSummary {
  const chat = s.chats.get(conversationId);
  if (!chat) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId } });
  if (!s.chats.members(conversationId).some((member) => member.memberId === agentId && member.kind === 'agent' && !member.leftAt)) {
    throw new WorkforceError('bad_request', 'Only an agent member of this chat has a reply mode here.', { details: { agentId } });
  }
  const modes = { ...(chat.settings.replyModes ?? {}) };
  if (mode === 'auto') delete modes[agentId]; else modes[agentId] = mode;
  s.chats.update(conversationId, { settings: { replyModes: Object.keys(modes).length ? modes : undefined } }, by);
  return s.chats.summary(conversationId);
}
