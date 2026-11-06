// External agents as chat participants (C8). Chat details › Members › "Connect external agent"
// (chats.connectExternal) adds the member `ext:api:<key>:<label>` – the 'ext:' prefix makes it an
// 'external' member, the last segment is the label every renderer shows – and returns its token
// once. Only the sha256 is stored (tokens table, kind 'external-agent', device_id = the member,
// scope = {"conversationId"}). The token opens `/ws` (http/ws.ts through `externalAgentSockets`)
// as the scope kind 'external', bound to that member and chat: from this PC always, from another
// machine only over a secure transport (the tailnet or the https address – the token travels in
// every Hello). Its
// RPC variants and their limits are bridges/external-rpc.ts.
// Every call checks again that the token is unrevoked and the member still in the chat, joined
// before the token was made (a member added again needs a new token). Removing the member revokes
// its token (chat/delivery.ts sees the 'member_removed' line) and 'external.revoked' closes its
// socket; deleting the chat revokes every token of it (subscribed by chat/delivery.ts at start,
// whether or not an agent is connected) and closes the sockets. @mentions of the member (by id or
// "@<label>") post 'external.mention' on the chat topic (chat/delivery.ts) – no engine, no turn.
// B-050: the same token also opens POST /rpc and GET /events (http/rpc.ts, http/sse.ts), it may post
// for senders behind it (sub-identities 'ext:api:<key>:<sender hash>:<label>', bridges/external-rpc.ts) and,
// made with `trusted: true` (chats.connectExternal), important messages as itself – untrusted is the default.
// Owns: new member ids and their labels (the id rule is shared/model/external-agents.ts), the
// external-agent token rows, the transport rule and the socket hooks for http/ws.ts.
// Never: stores, logs or returns a token after chats.connectExternal; lets an external agent act
// as the person, reach another chat, read files, drafts or chat settings, or change members.

import { createHash, randomBytes } from 'node:crypto';
import type { ClientScope } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, newId } from '../../shared/ids.ts';
import type { Member, Message } from '../../shared/model/chat.ts';
import { EXTERNAL_AGENT_PREFIX, externalAgentName, isExternalAgent, type ExternalAgentToken } from '../../shared/model/external-agents.ts';
import { findMentions } from '../../shared/text/chat-names.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { ExternalSocketAuth } from '../http/ws.ts';
import { id, input, notFound, onlyKeys, optBool, text } from '../rpc/params.ts';

export { EXTERNAL_AGENT_PREFIX, externalAgentName, isExternalAgent };
const TOKEN_KIND = 'external-agent';

type ExternalScope = Extract<ClientScope, { kind: 'external' }>;
type Services = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'chats'>;
interface TokenRow { id: string; device_id: string | null; scope: string; created_at: number; revoked_at: number | null }

/** A member-id-safe label: ASCII letters, digits, '.', '_' and '-' (spaces become '-'), at most 40 characters. */
export function externalLabel(name: string, fallback = 'External-agent'): string {
  const clean = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40).replace(/[-.]+$/, '');
  return clean || fallback;
}

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const COLUMNS = 'id, device_id, scope, created_at, revoked_at';

function chatOf(row: TokenRow): string | undefined {
  try {
    const value = JSON.parse(row.scope) as { conversationId?: unknown };
    return typeof value?.conversationId === 'string' ? value.conversationId : undefined;
  } catch {
    return undefined;
  }
}

/** The member is still in the chat and joined before the token was made. */
function memberLive(s: Pick<Services, 'chats'>, conversationId: string, memberId: string, createdAt: number): boolean {
  const member = s.chats.members(conversationId).find((entry) => entry.memberId === memberId);
  return Boolean(member && member.joinedAt <= createdAt);
}

function rowOf(s: Pick<Services, 'db'>, token: string): TokenRow | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return undefined;
  return s.db.get<TokenRow>(`SELECT ${COLUMNS} FROM tokens WHERE hash = ? AND kind = ?`, [hashToken(token), TOKEN_KIND]);
}

function liveRow(s: Pick<Services, 'chats'>, row: TokenRow | undefined): { row: TokenRow; memberId: string; conversationId: string } | undefined {
  const conversationId = row ? chatOf(row) : undefined;
  if (!row || row.revoked_at !== null || !row.device_id || !conversationId) return undefined;
  return memberLive(s, conversationId, row.device_id, Number(row.created_at)) ? { row, memberId: row.device_id, conversationId } : undefined;
}

/**
 * Adds an external agent to the chat (as the person's change: one 'member_added' line) and
 * returns its member id and its token – the only time the token exists outside the caller.
 */
export function connectExternalAgent(s: Services, params: unknown): ExternalAgentToken {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'name', 'trusted']);
  const conversationId = id(o, 'conversationId');
  const name = text(o, 'name', { max: 60 });
  const trusted = optBool(o, 'trusted') === true;
  const chat = s.chats.get(conversationId) ?? notFound('Chat', { conversationId });
  if (chat.settings.system) throw new WorkforceError('forbidden', 'External agents cannot join this chat.', { details: { conversationId } });
  if (chat.archivedAt !== undefined) throw new WorkforceError('conflict', 'This chat is archived.', { details: { conversationId } });
  const memberId = `${EXTERNAL_AGENT_PREFIX}${randomBytes(5).toString('hex')}:${externalLabel(name)}`;
  const token = `wfx_${randomBytes(32).toString('base64url')}`;
  s.chats.setMembers(conversationId, { add: [memberId] }, HUMAN_ID);
  try {
    const now = s.clock.now();
    s.db.run(
      'INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId('tok', now), memberId, TOKEN_KIND, hashToken(token), JSON.stringify(trusted ? { conversationId, trusted } : { conversationId }), externalAgentName(memberId), now],
    );
  } catch (error) {
    s.chats.setMembers(conversationId, { remove: [memberId] }, HUMAN_ID);
    throw error;
  }
  return { memberId, token };
}

/** Hello token → the external agent's scope (undefined: no live external-agent token). */
export function authenticateExternal(s: Services, token: string): ExternalScope | undefined {
  const live = liveRow(s, rowOf(s, token));
  if (!live) return undefined;
  s.db.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', [s.clock.now(), live.row.id]);
  return { kind: 'external', memberId: live.memberId, conversationId: live.conversationId, tokenId: live.row.id };
}

/** An external-agent token whose agent was removed (or revoked): the socket closes with 4403. */
export function revokedExternal(s: Services, token: string): boolean {
  const row = rowOf(s, token);
  return Boolean(row) && !liveRow(s, row);
}

/** bridges/external-rpc.ts, on every call: the scope's token is unrevoked and its member still in the chat. */
export function liveToken(s: Pick<Services, 'db' | 'chats'>, scope: ExternalScope): boolean {
  const row = s.db.get<TokenRow>(`SELECT ${COLUMNS} FROM tokens WHERE id = ? AND kind = ?`, [scope.tokenId, TOKEN_KIND]);
  const now = liveRow(s, row);
  return Boolean(now && now.memberId === scope.memberId && now.conversationId === scope.conversationId);
}

/** B-050 K8 (e): 'ext:api:<key>:' – the start of the token's member id and of every sender it posts for. */
export function connectorPrefix(memberId: string): string {
  return `${memberId.split(':').slice(0, 3).join(':')}:`;
}

/** B-050 K4: a token the person made with `trusted: true` may post important messages. */
export function tokenTrusted(s: Pick<Services, 'db'>, scope: ExternalScope): boolean {
  const row = s.db.get<{ scope: string }>('SELECT scope FROM tokens WHERE id = ? AND kind = ?', [scope.tokenId, TOKEN_KIND]);
  try { return (JSON.parse(row?.scope ?? '{}') as { trusted?: unknown }).trusted === true; } catch { return false; }
}

/**
 * Where an external agent's Hello is accepted: from this PC always; from another machine over a
 * secure transport (loopback proxy of the https address, or the tailnet) – plain LAN http would
 * carry the token in cleartext. B-078 (D5): no phone switch gates it any more.
 */
export function externalTransportAllowed(loopback: boolean, secure: boolean): boolean {
  return loopback || secure;
}

/** Revokes the tokens of these members (default: every external agent of the chat) and announces each end. */
export function revokeExternalAgents(s: Pick<RuntimeServices, 'db' | 'bus' | 'clock'>, end: { conversationId: string; memberIds?: string[] }): number {
  const rows = s.db.all<TokenRow>(`SELECT ${COLUMNS} FROM tokens WHERE kind = ? AND revoked_at IS NULL`, [TOKEN_KIND])
    .filter((row) => chatOf(row) === end.conversationId && (!end.memberIds || end.memberIds.includes(row.device_id ?? '')));
  const now = s.clock.now();
  for (const row of rows) s.db.run('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, row.id]);
  for (const memberId of new Set(rows.map((row) => row.device_id ?? ''))) s.bus.emit('external.revoked', { memberId, conversationId: end.conversationId });
  return rows.length;
}

/** The socket hooks for http/ws.ts (the HTTP server passes them as ClientSocketDeps.external). */
export function externalAgentSockets(services: () => RuntimeServices): ExternalSocketAuth {
  return {
    authenticate: (token, loopback, secure) => {
      return externalTransportAllowed(loopback, secure) ? authenticateExternal(services(), token) : undefined;
    },
    revoked: (token) => revokedExternal(services(), token),
    watch(ended) {
      const s = services();
      // Closing only: the tokens of a deleted chat are revoked by revokeOnChatRemoval.
      const offs = [
        s.bus.on('external.revoked', (end) => ended(end)),
        s.bus.on('conversation.removed', ({ id: conversationId }) => ended({ conversationId })),
      ];
      return () => { for (const off of offs) off(); };
    },
  };
}

/** External agents of the chat (not the author) that `message` @mentions – by id or as "@<label>". */
export function mentionedExternalAgents(message: Pick<Message, 'authorId' | 'body' | 'mentions'>, members: readonly Member[]): string[] {
  const candidates = members.filter((member) => isExternalAgent(member.memberId) && member.memberId !== message.authorId && member.leftAt === undefined);
  if (!candidates.length) return [];
  const named = findMentions(message.body, candidates.map((member) => ({ id: member.memberId, name: externalAgentName(member.memberId) })));
  return candidates.map((member) => member.memberId).filter((memberId) => message.mentions.includes(memberId) || named.includes(memberId));
}

type Hooks = Pick<RuntimeServices, 'clock'> & Partial<Pick<RuntimeServices, 'db' | 'bus' | 'log'>>;

/** chat/delivery.ts: one 'external.mention' per mentioned external agent (its socket hears it on the chat topic). */
export function announceMentions(s: Hooks, message: Message, memberIds: readonly string[]): void {
  if (!memberIds.length || !s.bus) return;
  try {
    for (const memberId of memberIds) s.bus.emit('external.mention', { conversationId: message.conversationId, memberId, messageId: message.id, seq: message.seq });
  } catch (error) {
    s.log?.warn('external mention failed', { messageId: message.id, error: String(error) });
  }
}

/** chat/delivery.ts, for a status line: an external agent's 'member_removed' revokes its token (and closes its socket). */
export function revokeOnRemoval(s: Hooks, message: Message): void {
  const status = message.meta.status;
  const memberId = status?.type === 'member_removed' ? status.details?.memberId : undefined;
  if (typeof memberId !== 'string' || !isExternalAgent(memberId) || !s.db || !s.bus) return;
  try {
    revokeExternalAgents({ db: s.db, bus: s.bus, clock: s.clock }, { conversationId: message.conversationId, memberIds: [memberId] });
  } catch (error) {
    s.log?.warn('external agent token not revoked', { conversationId: message.conversationId, error: String(error) });
  }
}

/** chat/delivery.ts at construction: deleting a chat revokes its external agents' tokens (connected or not). Returns the unsubscribe. */
export function revokeOnChatRemoval(s: Hooks): () => void {
  const { db, bus } = s;
  if (!db || typeof bus?.on !== 'function') return () => {};
  return bus.on('conversation.removed', ({ id: conversationId }) => {
    try {
      revokeExternalAgents({ db, bus, clock: s.clock }, { conversationId });
    } catch (error) {
      s.log?.warn('external agent tokens not revoked', { conversationId, error: String(error) });
    }
  });
}
