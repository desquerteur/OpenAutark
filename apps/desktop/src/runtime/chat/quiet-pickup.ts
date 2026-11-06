// Quiet pickup (B-050 K4): a person's quiet (silent) line wakes no agent it does not @mention
// (chat/delivery.ts) – the agent it is meant for picks it up when it is done. When an agent's turn ended
// and nothing else is due for it (agents/dispatcher.ts idle moment), pickUpQuiet looks for the
// chats it is an active member of with final quiet text or answer lines of a person – the owner, a
// person of the organisation, a bridged contact; never an external agent's, an agent's only as below, never a
// live-call line (a realtime session or the talker answers those, calls/) – above its read
// cursor and younger than QUIET_WINDOW_MS (the newest QUIET_SCAN of them). It takes only the lines a
// normal line would address to it, so a quiet line never costs more turns than the same line sent normally:
//  * a line that @mentions anyone: never – a mentioned agent was woken at once (delivery), the others
//    are not addressed (K3: a line to people only is theirs);
//  * a reply to an agent's line (an answer receipt to its ask, too): only that agent;
//  * otherwise the chat's one agent; in a group the reply-mode 'all' agents and the one the usual pick
//    falls back to (the lead, else the first 'auto' agent – no decision model); 'mentions'/'events' never.
// Each such chat (newest first, at most MAX_QUIET_CHATS per call) gets ONE 'review' wake under
// `quiet:<chat>` with QUIET_NOTE; a 'review' group runs after every other kind of work
// (dispatch-groups.ts REASON_RANK, which drops the note when the wake merges with other work).
// Round 3 (live run 2 passed only because a normal turn followed): an agent that has nothing to do when the
// line arrives – or after a start, or when it is un-paused – picks it up too, QUIET_DELAY_MS later (`delayMs`;
// agents/dispatcher.ts quietArrived, start, un-pause; quietPickupLine says which arriving lines count): the
// wakes of a burst of quiet lines merge under the key (the earliest due time wins), so the burst is one review
// turn – a pure pickup whose lines another turn read is settled without a turn (dispatch-groups.ts). A delayed wake still
// waiting when the agent's turn ends is due at once (the idle moment pulls it forward), and one whose lines the
// agent has read meanwhile (another turn in that chat) is withdrawn with its mark.
// Round 3 re-check (live run A: a colleague's [[silent]] vote to the manager's open question stranded the work
// group – chat.send had told the manager to end its turn, the reply would come as a new turn): in a room of exactly
// two agents, a quiet text of the one agent that answers a normal line of the other (the line right before it,
// K3: a normal line there wants something from the other one) is picked up by that other agent too, like a
// person's quiet line (quietAnswerPeer; delivery counts it in the loop guard). A quiet line after a quiet one,
// in a larger room or to a person never is: [[silent]] still closes, the asker just learns the answer when free.
// Round 5 (live F, three agents: in a room with colleagues a colleague's final text is quiet by default, and Mira's answer
// to the manager's "@Mira" named nobody – only Jonas's "@Manager" brought the manager back): in a room of three or more
// a quiet text of an agent is the asker's to pick up when the newest line asking it – a normal line of another agent
// that @mentions it – came after its own last text line. A line after its answer, an answer to a quiet @question, one
// that mentions anyone, or to a person still is nobody's: [[silent]] still closes. Without an @mention no line asks.
// Round 4 (live run A3: 2 of the work group's 2:34 min were this wait): a colleague's quiet answer waits for the asker
// only, not for a burst – a delayed pickup of a chat with such an answer not yet picked up is due QUIET_ANSWER_DELAY_MS
// after it (still a one-shot wake, merged under the key; the idle moment still makes it due at once); a person's quiet
// lines keep QUIET_DELAY_MS.
// No repeats: per agent the newest quiet seq already picked up per chat is kept (kv ns 'chat.quiet',
// one row per agent, pruned to the chats that still have unseen quiet lines for it), so a review turn
// that failed (its cursor stays) is not woken again until a newer quiet line arrives.
// Owns: that selection, the picked-up marks and which arriving line counts. Never: wakes for other agent lines,
// notifies, reads or renders message text (the turn's context delta does), or runs a turn.

import { isExternalAgent } from '../../shared/model/external-agents.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { replyModeSplit } from './reply-modes.ts';

/** Older quiet lines are not picked up any more: a pickup, not an archive sweep. */
export const QUIET_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** Chats woken per idle moment; the rest follow at the next one. */
export const MAX_QUIET_CHATS = 3;
/** Unseen quiet lines looked at per idle moment (the newest). */
export const QUIET_SCAN = 500;
/** An agent with nothing to do picks a quiet line up this much later – a burst of them is one review turn. */
export const QUIET_DELAY_MS = 2 * 60_000;
/** Round 4: a colleague's quiet answer to the agent's question is picked up this soon once the agent is free (QUIET_DELAY_MS is a person's bundling time). */
export const QUIET_ANSWER_DELAY_MS = 5_000;
export const QUIET_NOTE = 'Quiet messages arrived here for when I am free. They were sent quietly – nobody expects an answer. '
  + 'I read them and act when something is clearly worth doing; otherwise I end with [[internal]].';

/** Coalesce key of the pickup wake of a chat. */
export const quietWakeKey = (conversationId: string) => `quiet:${conversationId}`;

const NS = 'chat.quiet';

/**
 * The agent's unseen quiet lines of people – and of agents answering it: `after_ask` its normal line is the text right
 * before (a room of two), `asked` its normal @question to the author is the newest line asking it after the author's
 * own last text (round 5, a larger room) – newest first, with what they address: mentions and the replied line's author.
 */
const UNSEEN_QUIET = `
  SELECT * FROM (SELECT x.conversation_id AS id, x.seq AS seq, x.author_id AS author, x.author_kind AS kind, x.mentions AS mentions,
    r.author_id AS replied, x.created_at AS created_at,
    CASE WHEN x.author_kind = 'agent' THEN (SELECT p.author_id = m.member_id AND p.silent = 0 FROM messages p WHERE p.conversation_id = x.conversation_id
      AND p.seq < x.seq AND p.kind = 'text' AND p.state = 'final' ORDER BY p.seq DESC LIMIT 1) END AS after_ask,
    CASE WHEN x.author_kind = 'agent' THEN (SELECT p.author_id = m.member_id FROM messages p WHERE p.conversation_id = x.conversation_id AND p.seq < x.seq
      AND p.kind = 'text' AND p.state = 'final' AND (p.author_id = x.author_id OR (p.silent = 0 AND p.author_kind = 'agent'
        AND EXISTS (SELECT 1 FROM json_each(p.mentions) WHERE json_each.value = x.author_id)))
      ORDER BY p.seq DESC LIMIT 1) END AS asked
  FROM members m JOIN messages x ON x.conversation_id = m.conversation_id AND x.seq > m.read_seq
  LEFT JOIN messages r ON r.id = x.reply_to
  WHERE m.member_id = ? AND m.left_at IS NULL
    AND x.silent = 1 AND x.state = 'final' AND x.kind IN ('text', 'answer') AND x.created_at >= ?
    AND (x.author_kind IN ('human', 'external') OR (x.author_kind = 'agent' AND x.kind = 'text' AND x.author_id <> m.member_id))
    AND json_extract(x.meta, '$.call') IS NULL)
  WHERE kind IN ('human', 'external') OR after_ask = 1 OR asked = 1
  ORDER BY created_at DESC, id, seq DESC
  LIMIT ?`;

interface QuietRow { id: string; seq: number; author: string; kind: string; mentions: string; replied: string | null; after_ask: number | null; asked: number | null }

export type QuietPickupDeps = Pick<RuntimeServices, 'db' | 'wakes' | 'clock' | 'chats'>;

/** Whether an arriving message is a person's quiet line a pickup may take (the query's filter): final text or answer, no call line, no @mention. */
export function quietPickupLine(message: Pick<Message, 'silent' | 'state' | 'kind' | 'authorKind' | 'authorId' | 'mentions' | 'meta'>): boolean {
  return message.silent && message.state === 'final' && (message.kind === 'text' || message.kind === 'answer')
    && (message.authorKind === 'human' || (message.authorKind === 'external' && !isExternalAgent(message.authorId)))
    && message.meta.call == null && !message.mentions.some((id) => id !== message.authorId);
}

/**
 * An arriving agent's quiet text that mentions nobody (a mention woke at once) and answers another agent: in a room of
 * exactly two agents the other one's normal line right before it; round 5, in a room of three or more, the newest
 * normal line of an agent that @mentions the author, when no text of the author came after it. That asker picks it up
 * when free; else undefined.
 */
export function quietAnswerPeer(chats: Pick<RuntimeServices['chats'], 'members' | 'messages'>, message: Pick<Message, 'conversationId' | 'seq' | 'silent' | 'state' | 'kind' | 'authorKind' | 'authorId' | 'mentions' | 'meta'>): string | undefined {
  if (!message.silent || message.state !== 'final' || message.kind !== 'text' || message.authorKind !== 'agent' || message.meta.call != null) return undefined;
  if (message.mentions.some((id) => id !== message.authorId)) return undefined;
  const members = chats.members(message.conversationId);
  if (!members.some((member) => member.memberId === message.authorId)) return undefined;
  const lines = chats.messages(message.conversationId, { beforeSeq: message.seq, limit: 50 }).filter((line) => line.kind === 'text' && line.state === 'final');
  if (members.length === 2) {
    if (members.some((member) => member.kind !== 'agent')) return undefined;
    const before = lines.at(-1);
    return before && before.authorId !== message.authorId && !before.silent ? before.authorId : undefined;
  }
  const active = members.filter((member) => !member.leftAt);
  if (active.length < 3) return undefined;
  const ask = lines.filter((line) => line.authorId === message.authorId || (!line.silent && line.authorKind === 'agent' && line.mentions.includes(message.authorId))).at(-1);
  if (!ask || ask.authorId === message.authorId) return undefined;
  return active.some((member) => member.memberId === ask.authorId && member.kind === 'agent') ? ask.authorId : undefined;
}

/**
 * Gives each chat with quiet lines meant for the agent (a person's, a colleague's answer; not seen, nor picked up) one review wake, due
 * `delayMs` from now – at most QUIET_ANSWER_DELAY_MS where a colleague's answer is new; returns the chats woken. At the idle moment
 * (no delay) a delayed wake still waiting is due now.
 */
export function pickUpQuiet(s: QuietPickupDeps, agentId: string, delayMs = 0): string[] {
  const now = s.clock.now();
  const rows = s.db.all<QuietRow>(UNSEEN_QUIET, [agentId, now - QUIET_WINDOW_MS, QUIET_SCAN]);
  const kv = new KvRepo(s.db);
  const picked = kv.get<Record<string, number>>(NS, agentId) ?? {};
  const rooms = new Map<string, Room>();
  const newest = new Map<string, number>(); // chat → newest seq of a line meant for the agent (insertion: newest chat first)
  const answered = new Set<string>(); // chats with a colleague's quiet answer not picked up yet (round 4: due sooner)
  for (const row of rows) {
    if (isExternalAgent(row.author)) continue;
    let room = rooms.get(row.id);
    if (!room) rooms.set(row.id, room = roomOf(s.chats, row.id));
    if (!meantFor(row, room, agentId)) continue;
    if (!newest.has(row.id)) newest.set(row.id, Number(row.seq));
    if (row.kind === 'agent' && Number(row.seq) > (picked[row.id] ?? 0)) answered.add(row.id);
  }
  const keep: Record<string, number> = {};
  const woken: string[] = [];
  // Same key: a second wake merges into one still waiting, the earliest due time wins.
  const due = (id: string) => now + (answered.has(id) ? Math.min(delayMs, QUIET_ANSWER_DELAY_MS) : delayMs);
  const wake = (id: string) => s.wakes.wake({ agentId, reason: 'review', conversationId: id, note: QUIET_NOTE, coalesceKey: quietWakeKey(id), ...(delayMs > 0 ? { dueAt: due(id) } : {}) });
  let later: Set<string> | undefined;
  for (const [id, seq] of newest) {
    if ((picked[id] ?? 0) >= seq) {
      keep[id] = picked[id];
      // The agent is done now: a delayed pickup of these lines that still waits is due now.
      if (!delayMs && woken.length < MAX_QUIET_CHATS && (later ??= waitingPickups(s, agentId, now)).has(id)) { wake(id); woken.push(id); }
      continue;
    }
    if (woken.length >= MAX_QUIET_CHATS) continue;
    wake(id);
    keep[id] = seq;
    woken.push(id);
  }
  // Lines read meanwhile (another turn in that chat): a pickup still waiting for them has nothing left to do.
  for (const id of Object.keys(picked)) if (!(id in keep)) s.wakes.cancelKey?.(agentId, quietWakeKey(id));
  const same = Object.keys(keep).length === Object.keys(picked).length && Object.entries(keep).every(([id, seq]) => picked[id] === seq);
  if (same) return woken;
  if (Object.keys(keep).length) kv.set(NS, agentId, keep, now);
  else kv.delete(NS, agentId);
  return woken;
}

/** The chats whose quiet pickup of this agent still waits for its due time (unclaimed). */
function waitingPickups(s: QuietPickupDeps, agentId: string, now: number): Set<string> {
  const waiting = s.wakes.list(agentId).filter((wake) => wake.claimedAt === undefined && wake.dueAt > now && wake.reason === 'review' && wake.note === QUIET_NOTE);
  return new Set(waiting.flatMap((wake) => (wake.conversationId ? [wake.conversationId] : [])));
}

/** A chat's agent members, the ones an un-addressed line of a person reaches (as chat/delivery.ts routes a normal one), whether it is a room of exactly two agents, and of three or more active members. */
interface Room { agents: string[]; unaddressed: string[]; agentPair: boolean; group: boolean }

function roomOf(chats: QuietPickupDeps['chats'], conversationId: string): Room {
  const members = chats.members(conversationId);
  const agents = members.filter((member) => member.kind === 'agent').map((member) => member.memberId);
  const agentPair = members.length === 2 && agents.length === 2;
  const group = members.filter((member) => !member.leftAt).length >= 3;
  if (agents.length < 2) return { agents, unaddressed: agents, agentPair, group };
  const split = replyModeSplit(chats, conversationId, agents);
  const pickable = split?.pickable ?? agents;
  const lead = chats.lead(conversationId);
  const fallback = pickable.length ? [lead && pickable.includes(lead) ? lead : pickable[0]] : [];
  return { agents, unaddressed: [...(split?.always ?? []), ...fallback], agentPair, group };
}

/** Whether the quiet line is the agent's to pick up (see the header). */
function meantFor(row: QuietRow, room: Room, agentId: string): boolean {
  if (mentionsOf(row).some((id) => id !== row.author)) return false;
  if (row.kind === 'agent') return room.agentPair ? row.after_ask === 1 : room.group && row.asked === 1; // an answer to this agent (the query's flags)
  if (row.replied && room.agents.includes(row.replied)) return row.replied === agentId;
  return room.unaddressed.includes(agentId);
}

function mentionsOf(row: QuietRow): string[] {
  try {
    const value: unknown = JSON.parse(row.mentions);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
