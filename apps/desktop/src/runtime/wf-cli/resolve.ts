// Turns what a person types into ids for the wf terminal client (C7): a chat by id or name
// (exact, then prefix, then part of the name – chats of the main list first), an agent by id or
// name, and `wf events` topics (chat:<chat>, runs:<agent>, browser:<agent>).
// Owns: the matching rules and their "not found"/"several match" errors. Never: guesses between
// several matches – the person gets the candidates and picks an id.

import type { Topic } from '../../shared/api/protocol.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { foldText } from '../../shared/text/normalize.ts';
import { chatSection } from '../../shared/text/chat-sections.ts';
import type { Rpc } from './client.ts';
import { CliError } from './errors.ts';
import { chatTitle, namesOf, type NameOf } from './format.ts';

const FIXED_TOPICS: readonly string[] = ['chats', 'tasks', 'org', 'providers', 'system'];
const MAX_LISTED = 5;

type Tier = (name: string, wanted: string) => boolean;
const TIERS: readonly Tier[] = [
  (name, wanted) => name === wanted,
  (name, wanted) => name.startsWith(wanted),
  (name, wanted) => name.includes(wanted),
];

/** The one item whose name matches best; groups are tried in order within each tier. */
function pick<T extends { id: string }>(groups: readonly (readonly T[])[], ref: string, nameOf: (item: T) => string, what: string, listCommand: string): T {
  const all = groups.flat();
  const byId = all.find((item) => item.id === ref);
  if (byId) return byId;
  const wanted = foldText(ref.trim());
  if (wanted) {
    for (const tier of TIERS) {
      for (const group of groups) {
        const matches = group.filter((item) => tier(foldText(nameOf(item)), wanted));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
          const listed = matches.slice(0, MAX_LISTED).map((item) => `${nameOf(item)} (${item.id})`).join(', ');
          const more = matches.length > MAX_LISTED ? ` and ${matches.length - MAX_LISTED} more` : '';
          throw new CliError('bad_request', `"${ref}" matches several ${what}s: ${listed}${more}. Use the id.`);
        }
      }
    }
  }
  throw new CliError('not_found', `No ${what} matches "${ref}". Run 'wf ${listCommand}' to see them.`, { ref });
}

export function pickChat(chats: readonly ConversationSummary[], ref: string, name: NameOf): ConversationSummary {
  const main = chats.filter((chat) => chatSection(chat) === 'main');
  const rest = chats.filter((chat) => chatSection(chat) !== 'main');
  return pick([main, rest], ref, (chat) => chatTitle(chat, name), 'chat', 'chats --all');
}

export function pickAgent(agents: readonly Agent[], ref: string): Agent {
  const active = agents.filter((agent) => !agent.archivedAt);
  const archived = agents.filter((agent) => agent.archivedAt);
  return pick([active, archived], ref, (agent) => agent.name, 'agent', 'agents --all');
}

/** All agents (archived too, so old authors keep their names). */
export async function loadAgents(rpc: Rpc): Promise<Agent[]> {
  return await rpc.call('agents.list', { includeArchived: true }) as Agent[];
}

export async function resolveChat(rpc: Rpc, ref: string, agents?: Agent[]): Promise<{ chat: ConversationSummary; name: NameOf; agents: Agent[] }> {
  const [chats, known] = await Promise.all([rpc.call('chats.list', { includeHidden: true }) as Promise<ConversationSummary[]>, agents ?? loadAgents(rpc)]);
  const name = namesOf(known);
  return { chat: pickChat(chats, ref, name), name, agents: known };
}

/** `wf events` arguments as runtime topics; chat and agent parts may be names. */
export async function resolveTopics(rpc: Rpc, refs: readonly string[], agents: Agent[]): Promise<Topic[]> {
  const topics: Topic[] = [];
  let chats: ConversationSummary[] | undefined;
  for (const ref of refs) {
    if (FIXED_TOPICS.includes(ref)) { topics.push(ref as Topic); continue; }
    const match = /^(chat|runs|browser):(.+)$/.exec(ref);
    if (!match) throw new CliError('bad_request', `Unknown topic "${ref}". Topics: ${FIXED_TOPICS.join(', ')}, chat:<chat>, runs:<agent>, browser:<agent>.`);
    const [, kind, part] = match;
    if (kind === 'chat') {
      chats ??= await rpc.call('chats.list', { includeHidden: true }) as ConversationSummary[];
      topics.push(`chat:${pickChat(chats, part, namesOf(agents)).id}`);
    } else {
      topics.push(`${kind as 'runs' | 'browser'}:${pickAgent(agents, part).id}`);
    }
  }
  return [...new Set(topics)];
}
