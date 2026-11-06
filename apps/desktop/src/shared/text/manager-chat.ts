// Which agent is "the Manager" and which chat is a manager's own chat with the person – one rule
// for the window (the first-run layer and Home's setup line, ui/onboarding) and the runtime (the
// start text, runtime/onboarding/service.ts; where a manager's bundled report of finished work goes,
// runtime/org/reports.ts). B-050 K1: the owner's default 1:1 with the Manager (settings.direct with
// that pair, runtime/chat/direct.ts – also after the Manager's reports joined it) is that chat when it exists.
// Owns: the two pure selection rules. Never: reads signals, RPC or any store.

import { HUMAN_ID } from '../ids.ts';
import { directPair, type ConversationSummary } from '../model/chat.ts';
import type { Agent } from '../model/org.ts';
import { chatSection } from './chat-sections.ts';

/** What the chat rule looks at (a ConversationSummary has it). */
export type ManagerChatInput = Pick<ConversationSummary, 'settings' | 'members' | 'createdAt' | 'archivedAt'>;

/**
 * The first Manager – the person's personal manager: the seed agent (manager template first, B-078: a department head
 * in mode manager beside it is never taken for it; else mode manager), top of the org, oldest first.
 */
export function managerAgent(list: readonly Agent[]): Agent | undefined {
  return list
    .filter((agent) => !agent.archivedAt && (agent.template === 'manager' || agent.mode === 'manager'))
    .sort((a, b) => Number(a.template !== 'manager') - Number(b.template !== 'manager')
      || Number(Boolean(a.managerId)) - Number(Boolean(b.managerId)) || a.createdAt - b.createdAt)[0];
}

/**
 * The Manager's chat with the person: the owner's default 1:1 with the Manager (also when others joined
 * it), else the oldest visible chat whose only current agent member is the Manager.
 */
export function managerFirstChat<C extends ManagerChatInput>(chats: readonly C[], managerId: string): C | undefined {
  const visible = chats.filter((chat) => !chat.archivedAt && chatSection(chat) === 'main');
  const ownersDefault = (chat: C) => {
    const pair = directPair(chat.settings, chat.members.filter((member) => !member.leftAt));
    return pair !== undefined && pair.includes(HUMAN_ID) && pair.includes(managerId);
  };
  const own = visible
    .filter((chat) => {
      const members = chat.members.filter((member) => member.kind === 'agent' && !member.leftAt);
      return members.length === 1 && members[0].memberId === managerId;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
  return visible.find(ownersDefault) ?? own[0];
}
