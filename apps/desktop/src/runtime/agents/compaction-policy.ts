// Compaction policy (CTX7): when an agent's view of a long chat is condensed, so the active
// context stays small and cheap on every engine. A native session is renewed (turn-prepare.ts
// renewSession: compaction + dropped binding + full projection) once its context passes
// renewalLimit – 60 % of the model's window, never more than WORKING_SET_TOKENS (also on 1M
// windows); this holds for every engine with sessions. A session-less engine
// (HTTP APIs, local models) gets the full projection – observation + ~30 earlier lines + new
// lines – every turn, so after its done turn the chat is compacted once more than KEEP_RECENT + 40
// seen messages lie past the agent's own observation: low priority, fire-and-forget; the next
// projection carries the summary. A session renewed only because its turn runs in another folder
// (a Codex thread keeps its cwd: chat turns in the workspace, task turns in a worktree) compacts by
// the same session-less rule (statelessDue), not every time. A compaction that moved the
// observation is journaled as the run note {compacted: reason, coveredSeq}.
// This renewal is the hard backstop: an agent nearing it (nearLimit) wakes the subconscious first (subconscious/wake.ts), which
// keeps the context lean all along by item ids (context/ledger, agents/rebuild.ts).
// Owns: the working-set constant, the renewal limit, what counts as near it, the session-less trigger and the note.
// Never: compacts itself (ContextService.compact, one at a time per agent and chat), lets a
// session-less compaction delay or fail a turn, or deletes chat messages.

import type { RuntimeServices } from '../contracts.ts';
import { KEEP_RECENT } from '../context/compact.ts';
import { ownCoveredSeq } from '../context/observations.ts';

/**
 * The most context tokens a native session carries before it is renewed (ARCHITECTURE §13). 64k: the fixed part
 * (system prompt, tool specs, the agent's files) takes roughly 15–25k, so about 40k of chat and tool output stay
 * for the work – several turns of a busy task between renewals, while every turn stays fast and cheap and well
 * below the length where models start to lose details in the middle (the owner disliked waiting for 60 % of a
 * 200k–1M window). A renewal keeps the compaction state and the recent lines, so lower would mostly add renewals.
 */
export const WORKING_SET_TOKENS = 64_000;
const RENEW_RATIO = 0.6;
/** From this share of the renewal limit on an agent's context counts as near its limit. */
const NEAR_RATIO = 0.8;
/** Seen messages past the observation, beyond the kept recent ones, before a session-less chat compacts. */
const STATELESS_SLACK = 40;

export type CompactionReason = 'context' | 'overflow' | 'mode' | 'prompt' | 'stateless' | 'folder';

/** Context tokens above which a native session is renewed: 60 % of the window, at most the working set. */
export function renewalLimit(contextWindow: number | undefined): number {
  return contextWindow && contextWindow > 0 ? Math.min(RENEW_RATIO * contextWindow, WORKING_SET_TOKENS) : WORKING_SET_TOKENS;
}

export function needsRenewal(contextTokens: number | undefined, contextWindow: number | undefined): boolean {
  return (contextTokens ?? 0) > renewalLimit(contextWindow);
}

/** The context is close to its renewal: the subconscious gets a run first. */
export function nearLimit(contextTokens: number | undefined, contextWindow: number | undefined): boolean {
  return (contextTokens ?? 0) >= NEAR_RATIO * renewalLimit(contextWindow);
}

/**
 * Compacts the agent's chat (before a session renewal); the run note when the observation moved.
 * A 'folder' renewal compacts only when statelessDue – the same rule as a session-less engine's turns.
 */
export async function compactNoted(services: RuntimeServices, input: { agentId: string; conversationId: string; runId: string; reason: CompactionReason }): Promise<void> {
  if (input.reason === 'folder' && !statelessDue(services, input.agentId, input.conversationId)) return;
  const before = ownCoveredSeq(services, input.conversationId, input.agentId);
  await services.context.compact({ agentId: input.agentId, conversationId: input.conversationId });
  const after = ownCoveredSeq(services, input.conversationId, input.agentId);
  if (after > before) services.runs.item(input.runId, { kind: 'note', data: { compacted: input.reason, coveredSeq: after }, effectStatus: 'none' });
}

/** More than KEEP_RECENT + 40 messages the agent has seen lie past its own observation. */
export function statelessDue(services: RuntimeServices, agentId: string, conversationId: string): boolean {
  const member = services.chats.members(conversationId).find((item) => item.memberId === agentId && !item.leftAt);
  if (!member) return false;
  const limit = KEEP_RECENT + STATELESS_SLACK;
  const past = services.chats.messages(conversationId, { afterSeq: ownCoveredSeq(services, conversationId, agentId), limit: limit + 1 });
  return past.filter((message) => message.seq <= member.readSeq).length > limit;
}

/**
 * After a done turn on a session-less engine: compacts at low priority when statelessDue. The
 * note is written as the compaction starts (inside the run's time span, so the answer's "Worked …"
 * line stays true) and gets its coveredSeq when the compaction is done.
 */
export function compactAfterTurn(services: RuntimeServices, input: { agentId: string; conversationId: string; runId: string }): void {
  setImmediate(() => {
    const { agentId, conversationId, runId } = input;
    let noteId: string | undefined;
    try {
      if (!statelessDue(services, agentId, conversationId)) return;
      noteId = services.runs.item(runId, { kind: 'note', data: { compacted: 'stateless' }, effectStatus: 'none' })?.id;
    } catch (error) {
      services.log.warn('checking the chat for compaction failed', { agentId, conversationId, error: String(error) });
      return;
    }
    const settle = (data: Record<string, unknown>) => { if (noteId) services.runs.updateItem(noteId, { data }); };
    Promise.resolve()
      .then(() => services.context.compact({ agentId, conversationId }))
      .then(() => settle({ coveredSeq: ownCoveredSeq(services, conversationId, agentId) }))
      .catch((error) => {
        services.log.warn('compaction after the turn failed', { agentId, conversationId, error: String(error) });
        try { settle({ failed: true }); } catch { /* the warning above is the record */ }
      });
  });
}
