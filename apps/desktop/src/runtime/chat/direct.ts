// The default 1:1 of two members (B-050 K1): one chat per pair, marked settings.direct with its pair
// (settings.directPair), for any kinds – the owner ('human'), a person of the organisation (per_…), an
// agent; two agents without a human too (K3). findOrCreateDirect is the one place that finds or makes it:
// the marked chat of the pair (both still active members; archived or not – archiving only hides it;
// older data may hold a third member), else the newest older chat of exactly these two that names no topic –
// untitled, or titled only with a member's name like the first-run chat – (not archived, not app-owned,
// not a hidden work room) – adopted and marked –, else a new one with just these two and no title
// (shared/text/chat-names.ts displayTitle names it after the other member). The mark holds while both of
// the pair are members and ends when one of them leaves (chat/members-change.ts keepDirectPair), so a pair
// never gets a second default 1:1. B-078 D7: a 1:1 stays two – nobody joins it (members-change.ts refuses);
// work someone hands on from a 1:1 goes to the giver's own 1:1 with the receiver (workRoomFor).
// B-050 K1, Nachtrag Runde 4 ("Standardmäßig soll es mit jedem Agent … einen Chat geben"): the owner's default
// 1:1 with every active agent – sub-agents too – exists from the start (keepOwnerDirects: backfilled at start in
// one transaction, a hire or a restored agent gets it right after the org announces it); an empty one posts no line,
// counts nothing unread and wakes nobody. Every other pair – a person and an agent too – gets it when first used.
// Owns: finding, adopting and creating the default 1:1, the owner's with every active agent. Never: adds a
// third member, renames or unarchives a chat, adopts a chat named after a topic, gives an archived agent a
// new one by itself, or knows an agent without the org service.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { isPersonId } from '../../shared/model/people.ts';
import { onlyNames } from '../../shared/text/chat-names.ts';
import type { Logger, OrgService, RuntimeServices } from '../contracts.ts';
import { activePerson } from '../people/repo.ts';
import { memberName } from './titles.ts';
import '../contracts/people.ts';

type DirectDeps = Pick<RuntimeServices, 'db' | 'chats'> & Partial<Pick<RuntimeServices, 'people' | 'clock' | 'settings'>> & { org?: Pick<OrgService, 'get'> };
/** What the owner's default 1:1s with the agents need: the org's agents, the bus that announces a hire, a log for a failure. */
type OwnerDeps = DirectDeps & Pick<RuntimeServices, 'bus'> & { org: Pick<OrgService, 'get' | 'list'>; log?: Pick<Logger, 'warn'> };

const ACTIVE = 'EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.member_id = ? AND m.left_at IS NULL)';
const COUNT = '(SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id AND m.left_at IS NULL)';
/** Both bound ids are active members of a chat that is not app-owned. */
const BOTH = `json_extract(c.settings, '$.system') IS NULL AND ${ACTIVE} AND ${ACTIVE}`;
const NEWEST = 'COALESCE(c.last_message_at, c.created_at) DESC, c.created_at DESC';

export function isDirect(chat: { settings: { direct?: boolean } }): boolean {
  return chat.settings.direct === true;
}

/** The pair as a mark stores it (settings.directPair): the two ids sorted. */
export function pairOf(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The default 1:1 of `a` and `b` (archived too; a visible one first, should there be more); undefined when none. */
export function findDirect(s: Pick<RuntimeServices, 'db'>, a: string, b: string): string | undefined {
  const [low, high] = pairOf(a, b);
  return s.db.get<{ id: string }>(
    `SELECT c.id FROM conversations c WHERE json_extract(c.settings, '$.direct') = 1 AND ${BOTH}
       AND ((json_extract(c.settings, '$.directPair[0]') = ? AND json_extract(c.settings, '$.directPair[1]') = ?)
         OR (json_extract(c.settings, '$.directPair') IS NULL AND ${COUNT} = 2))
     ORDER BY c.archived_at IS NOT NULL, ${NEWEST} LIMIT 1`,
    [a, b, low, high],
  )?.id;
}

/** The newest chat of exactly `a` and `b` that may become their default 1:1 (see the header). */
function findAdoptable(s: DirectDeps, a: string, b: string): string | undefined {
  const rows = s.db.all<{ id: string; title: string; title_named: number }>(
    `SELECT c.id, c.title, c.title_named FROM conversations c WHERE c.archived_at IS NULL AND ${BOTH} AND ${COUNT} = 2
       AND COALESCE(json_extract(c.settings, '$.hiddenFromList'), 0) = 0 ORDER BY ${NEWEST} LIMIT 50`,
    [a, b],
  );
  const names = [a, b].map((id) => memberName(s, id)).filter((name): name is string => Boolean(name));
  return rows.find((row) => !row.title_named || onlyNames(row.title, names))?.id;
}

/** `id` may have a default 1:1: the owner, an active person, or an agent the org knows. */
function checkMember(s: DirectDeps, id: string): void {
  if (id === HUMAN_ID) return;
  if (isPersonId(id)) {
    if (!activePerson(s.db, id)) throw new WorkforceError('not_found', 'This person is not in the organisation.', { details: { personId: id } });
    return;
  }
  if (!s.org?.get(id)) throw new WorkforceError('not_found', 'Agent not found.', { details: { agentId: id } });
}

/**
 * The default 1:1 of `a` and `b` (found, adopted or created – see the header); returns its id.
 * `createdBy` (default `a`): who starts a new one (its 'owner' member when human, its lead when an agent).
 */
export function findOrCreateDirect(s: DirectDeps, a: string, b: string, opts: { createdBy?: string } = {}): string {
  if (a === b) throw new WorkforceError('bad_request', 'Choose someone else.');
  checkMember(s, a);
  checkMember(s, b);
  const by = opts.createdBy ?? a;
  const mark = { direct: true, directPair: pairOf(a, b) };
  return s.db.tx(() => {
    const found = findDirect(s, a, b);
    if (found) return found;
    const adopted = findAdoptable(s, a, b);
    if (adopted) {
      s.chats.update(adopted, { settings: mark }, by);
      return adopted;
    }
    const pair = [a, b];
    return s.chats.create({
      agentIds: pair.filter((id) => id !== HUMAN_ID && !isPersonId(id)),
      humans: pair.includes(HUMAN_ID),
      people: pair.filter((id) => isPersonId(id)),
      createdBy: by,
      settings: mark,
    }).id;
  });
}

/**
 * B-078 D7: the chat where `receiver` works on what `by` hands it from `chatId`: `chatId` itself when the receiver
 * is in it or it is no default 1:1; else the default 1:1 of `by` and the receiver (found or made) – the status line
 * stays in `chatId`. The system or the receiver itself as `by`, or no chat: `chatId` unchanged.
 */
export function workRoomFor(s: DirectDeps, chatId: string | undefined, by: string, receiver: string): string | undefined {
  if (!chatId || by === receiver || by === SYSTEM_ID) return chatId;
  const chat = s.chats.get(chatId);
  if (!chat || !isDirect(chat)) return chatId;
  if (s.chats.members(chatId).some((member) => member.memberId === receiver && member.leftAt === undefined)) return chatId;
  return findOrCreateDirect(s, by, receiver, { createdBy: by });
}

/**
 * The members that have a default 1:1 with the owner – findDirect's rule for every partner at once, in one
 * query over the owner's own memberships (members_member index), so a start stays cheap on a large database.
 */
function ownerPartners(s: Pick<RuntimeServices, 'db'>): Set<string> {
  const rows = s.db.all<{ id: string }>(
    `SELECT DISTINCT m.member_id AS id FROM members h
       JOIN conversations c ON c.id = h.conversation_id
       JOIN members m ON m.conversation_id = c.id AND m.member_id <> h.member_id AND m.left_at IS NULL
     WHERE h.member_id = ? AND h.left_at IS NULL AND json_extract(c.settings, '$.direct') = 1 AND json_extract(c.settings, '$.system') IS NULL
       AND ((json_extract(c.settings, '$.directPair[0]') = min(m.member_id, h.member_id) AND json_extract(c.settings, '$.directPair[1]') = max(m.member_id, h.member_id))
         OR (json_extract(c.settings, '$.directPair') IS NULL AND ${COUNT} = 2))`,
    [HUMAN_ID],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * B-050 K1, Nachtrag Runde 4: every active agent without the owner's default 1:1 gets it now (findOrCreateDirect:
 * an older chat of the two adopted, else a new empty one), all in one transaction; returns those agents' ids.
 * Idempotent: a second call finds them all. Archived agents get none; people keep getting theirs when first used.
 */
export function ensureOwnerDirects(s: Omit<OwnerDeps, 'bus'>): string[] {
  return s.db.tx(() => {
    const have = ownerPartners(s);
    const missing = s.org.list().filter((agent) => !agent.archivedAt && !have.has(agent.id));
    for (const agent of missing) findOrCreateDirect(s, HUMAN_ID, agent.id, { createdBy: HUMAN_ID });
    return missing.map((agent) => agent.id);
  });
}

/**
 * Keeps the owner's default 1:1 with every active agent (main.ts, at start): the backfill (ensureOwnerDirects), then
 * a hire – or an archived agent restored – gets it right after the org announces it (agent.upserted; agents known to
 * have one are skipped without a query, so status changes stay free). Right after, not inside: a microtask, so every
 * listener – the windows too – hears of the agent before its chat, and a hire whose transaction is rolled back (a
 * team proposal) makes none. Never throws: a failure is logged, chats.direct still makes the chat on first open.
 * Returns the unsubscribe.
 */
export function keepOwnerDirects(s: OwnerDeps): () => void {
  const known = new Set<string>();
  const queued = new Set<string>();
  let stopped = false;
  try {
    ensureOwnerDirects(s);
    for (const agent of s.org.list()) if (!agent.archivedAt) known.add(agent.id);
  } catch (error) {
    s.log?.warn('default chats with the agents not backfilled', { error: String(error) });
  }
  const make = (agentId: string): void => {
    queued.delete(agentId);
    const agent = s.org.get(agentId);
    if (stopped || !agent || agent.archivedAt || known.has(agentId)) return;
    try {
      findOrCreateDirect(s, HUMAN_ID, agentId, { createdBy: HUMAN_ID });
      known.add(agentId);
    } catch (error) {
      s.log?.warn('default chat with the agent not made', { agentId, error: String(error) });
    }
  };
  const off = s.bus.on('agent.upserted', (agent) => {
    if (agent.archivedAt || known.has(agent.id) || queued.has(agent.id)) return;
    queued.add(agent.id);
    queueMicrotask(() => make(agent.id));
  });
  return () => { stopped = true; off(); };
}
