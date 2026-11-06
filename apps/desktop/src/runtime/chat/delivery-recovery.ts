// Startup sweep of chat delivery (C3, F-44): a message is committed in its own transaction before
// delivery writes its wakes, and an un-addressed group message waits for the decision model – a
// crash, quit or failed delivery in between leaves it unanswered. After wakes.reconcile() this
// finds, per chat that has agent members (archived ones too, C2), the newest non-silent text message
// when it is human- or external-authored, younger than RECOVER_WINDOW_MS, above every agent
// member's read cursor (no agent has seen it), no agent member has any wake for that chat and no
// agent member has a run in that chat that started at or after it. That run took the message up:
// a turn the person stopped (its empty bubble is removed and the cursor stays) or that failed
// counts as answered. A run cut off by a crash, quit or urgent message is no exception – its
// wake went back to the queue (wakes.reconcile/release), so the wake check already skips it.
// The window keeps a first start after an update from waking agents for long-forgotten messages.
// Owns: that selection rule. Never: wakes or notifies (DeliveryServiceImpl.recover delivers).

import type { Message } from '../../shared/model/chat.ts';
import type { Run } from '../../shared/model/runs.ts';
import type { RuntimeServices } from '../contracts.ts';

/** Older messages are not delivered again: a crash recovery, not a backlog. */
export const RECOVER_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** Newest messages looked at per chat (status lines and task anchors in between are skipped). */
const SCAN = 50;
/** Newest runs looked at per agent (the journal's maximum page). */
const RUNS = 500;

export type RecoveryDeps = Pick<RuntimeServices, 'chats' | 'wakes' | 'clock'> & Partial<Pick<RuntimeServices, 'runs'>>;

export function unansweredMessages(s: RecoveryDeps): Message[] {
  const now = s.clock.now();
  const wakeChats = new Map<string, Set<string>>(); // agent → chats it has a wake for (claimed or not)
  const hasWake = (agentId: string, conversationId: string): boolean => {
    let chats = wakeChats.get(agentId);
    if (!chats) {
      chats = new Set(s.wakes.list(agentId).flatMap(wake => (wake.conversationId ? [wake.conversationId] : [])));
      wakeChats.set(agentId, chats);
    }
    return chats.has(conversationId);
  };
  const agentRuns = new Map<string, Run[]>(); // agent → its newest runs (newest first)
  const tookUp = (agentId: string, conversationId: string, since: number): boolean => {
    if (!s.runs) return false;
    let runs = agentRuns.get(agentId);
    if (!runs) {
      try { runs = s.runs.list(agentId, RUNS); } catch { runs = []; } // without the journal: deliver again
      agentRuns.set(agentId, runs);
    }
    return runs.some(run => run.conversationId === conversationId && (run.startedAt ?? -1) >= since);
  };
  const found: Message[] = [];
  for (const chat of s.chats.list({ includeHidden: true })) {
    const agents = chat.members.filter(member => member.kind === 'agent' && !member.leftAt);
    if (!agents.length) continue;
    const newest = newestText(s.chats.messages(chat.id, { limit: SCAN }));
    if (!newest || (newest.authorKind !== 'human' && newest.authorKind !== 'external')) continue;
    if (now - newest.createdAt > RECOVER_WINDOW_MS) continue;
    if (agents.some(member => member.readSeq >= newest.seq)) continue;
    if (agents.some(member => hasWake(member.memberId, chat.id))) continue;
    if (agents.some(member => tookUp(member.memberId, chat.id, newest.createdAt))) continue;
    found.push(newest);
  }
  return found;
}

/** The newest visible text message of a page (oldest first); an agent's failed or stopped reply counts. */
function newestText(page: Message[]): Message | undefined {
  for (let i = page.length - 1; i >= 0; i--) {
    const message = page[i];
    if (message.kind === 'text' && !message.silent && message.state !== 'streaming') return message;
  }
  return undefined;
}
