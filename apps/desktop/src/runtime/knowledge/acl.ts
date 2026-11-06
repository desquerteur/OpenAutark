// Which memory folders a query searches (relevance, not a permission: any agent may name any folder). The folders a caller
// names; else by agent: company/ (with the website, app and mode areas), its branch, its own folder, the references and its
// chat's folder. No agentId (the person / UI) reads everything. An agent's own tools (knowledge.recall, knowledge.find) pass no
// agentId: the agent names the folders or searches the whole tree (owner's rule (f), q-r 03.11.2026: code names no place).
// Owns: those folders and the filter a found item passes. Never: ranking or writing.

import type { Db } from '../db/database.ts';
import type { KnowledgeItem, KnowledgeQuery } from '../../shared/model/knowledge.ts';
import { folderOfScope, folderOfWholeScope } from './memory-tree.ts';

/** Space and conversation memberships of an agent (read from the org/chat tables). */
export function agentReach(db: Db, agentId: string): { spaceId?: string; conversations: string[] } {
  const agent = db.get<{ space_id: string | null }>('SELECT space_id FROM agents WHERE id = ?', [agentId]);
  const rows = db.all<{ conversation_id: string }>(
    'SELECT conversation_id FROM members WHERE member_id = ? AND left_at IS NULL ORDER BY conversation_id', [agentId]);
  return { spaceId: agent?.space_id ?? undefined, conversations: rows.map((row) => row.conversation_id) };
}

/** The memory folders (relative to the tree; '' = all of it) a query searches: the ones it names, else by scope or agent. */
export function queryFolders(db: Db, query: Pick<KnowledgeQuery, 'agentId' | 'conversationId' | 'scopes' | 'folders'>): string[] {
  if (query.folders?.length) return [...new Set(query.folders.map((folder) => folder.trim().replace(/\\/g, '/').replace(/^memory(\/|$)/, '').replace(/^\/+|\/+$/g, '')))];
  const reach = query.agentId ? agentReach(db, query.agentId) : undefined;
  const chats = query.conversationId ? [query.conversationId] : reach?.conversations ?? [];
  if (query.scopes?.length) {
    return [...new Set(query.scopes.flatMap((scope) => {
      if (scope === 'agent' && query.agentId) return [folderOfScope('agent', query.agentId)];
      if (scope === 'space' && reach) return reach.spaceId ? [folderOfScope('space', reach.spaceId)] : [];
      if (scope === 'conversation' && (reach || query.conversationId)) return chats.map((chat) => folderOfScope('conversation', chat));
      return [folderOfWholeScope(scope)];
    }))];
  }
  if (!query.agentId) return [''];
  return [
    folderOfScope('global', undefined),
    ...(reach?.spaceId ? [folderOfScope('space', reach.spaceId)] : []),
    folderOfScope('agent', query.agentId),
    'references',
    ...chats.map((chat) => folderOfScope('conversation', chat)),
  ];
}

/** Does a found item pass the query's filters (validity, scopes, kinds, chat, mode area, `before`)? */
export function passes(item: KnowledgeItem, query: Partial<KnowledgeQuery>, now: number): boolean {
  const at = query.at ?? now;
  if (item.validFrom !== undefined && item.validFrom > at) return false;
  if (item.validTo !== undefined && item.validTo <= at) return false;
  if (query.scopes?.length && !query.scopes.includes(item.scope)) return false;
  if (query.kinds?.length && !query.kinds.includes(item.kind)) return false;
  if (query.conversationId && item.scope === 'conversation' && item.scopeId !== query.conversationId) return false;
  if (query.mode !== undefined && item.scope === 'mode' && item.scopeId !== query.mode) return false;
  return query.before === undefined || item.recordedAt < query.before;
}
