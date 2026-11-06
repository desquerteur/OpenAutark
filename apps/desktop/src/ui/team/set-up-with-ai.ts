// "Set up with AI" for things that have no screen of their own any more (import an agent team, duplicate an agent,
// change who an agent reports to, connect a calendar): the Manager's 1:1 chat opens with a prepared request in its
// composer – the person adds the missing detail (a file, a name, a link) and sends it. The same hand-off Settings › Models'
// use rows use. "Duplicate <name>" is done by the skill agent-duplicate.
// Owns: the hand-off and the request texts. Never: makes the change (the AI does, with its tools) or sends anything.

import type { Agent } from '../../shared/model/org.ts';
import { managerAgent } from '../../shared/text/manager-chat.ts';
import { draftFor, updateDraft } from '../chat/composer/draft.ts';
import { rpc } from '../lib/rpc.ts';
import { go } from '../lib/router.ts';
import { agents, conversations, upsertById } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';

export const importTeamRequest = (): string => 'Import an agent team from: ';
export const duplicateRequest = (agent: Pick<Agent, 'name'>): string => `Duplicate ${agent.name}`;
export const reportsToRequest = (agent: Pick<Agent, 'name'>): string => `Change who ${agent.name} reports to. New manager: `;
export const connectCalendarRequest = (): string => 'Connect a calendar to My day (Google Calendar or a calendar link): ';

/** The request under whatever the person had already typed there (a draft is never overwritten). */
export function withRequest(existing: string, request: string): string {
  return existing.trim() ? `${existing.trimEnd()}\n${request}` : request;
}

/** Opens the Manager's 1:1 with `request` in its composer. */
export async function setUpWithAi(request: string): Promise<void> {
  const manager = managerAgent(agents.value);
  if (!manager) { pushToast({ title: 'No Manager yet', body: 'Hire a Manager first, then ask it to set this up.' }); return; }
  try {
    const chat = await rpc.call('chats.direct', { memberId: manager.id });
    upsertById(conversations, chat);
    updateDraft(chat.id, { text: withRequest(draftFor(chat.id).peek().text, request) });
    go.chat(chat.id);
  } catch (error) {
    toastError(error, 'Could not open the chat');
  }
}
