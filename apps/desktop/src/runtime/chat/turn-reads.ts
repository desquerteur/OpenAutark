// B-050 group cost (live test round 4, a work group of three): what a turn saw of its own chat through chat.read.
// Live, the manager read Mira's and Jonas's answers with chat.read during its turn and answered them – and was woken
// for those same lines once more right after, for a turn that only said "already done": the turn's end advanced its
// cursor only to the turn's input (turn.lastSeq), so the dispatcher's stale check (agents/dispatch-groups.ts
// isStaleMessageGroup) still counted them as new. chat.read notes how far it showed the turn's own chat completely;
// the turn's end (agents/turn-finish.ts) moves the cursor that far too – only for a turn that ended done, like its input.
// A line still being written does not end the mark when a finished line follows it: it moves behind that line when it
// is done (publish-message.ts finishAgentMessage), so it stays new for the reader; one with nothing finished after it
// might keep its seq, so the mark ends at the last finished line.
// Owns: that mark (memory, per services object, per run, bounded) and the coverage rule. Never: moves a cursor itself,
// counts a read of another chat, a page back or a single message, a page that leaves lines after the cursor out, or a
// line still being written.

import type { Message } from '../../shared/model/chat.ts';

/** Marks kept at most (runs that never finished – a crash – drop out oldest first). */
const MARKS = 200;
const marks = new WeakMap<object, Map<string, { conversationId: string; seq: number }>>();

/**
 * How far `shown` – one chat.read page, oldest first: the newest `limit` lines, or the first `limit` after `afterSeq` –
 * shows the chat completely after `cursor`: up to its last finished line (see the header). 0 when the page leaves a
 * line after the cursor out (a full page starting later) or holds no finished line.
 */
export function readThrough(shown: ReadonlyArray<Pick<Message, 'seq' | 'state'>>, input: { cursor: number; limit: number; afterSeq?: number }): number {
  const first = shown[0];
  if (!first) return 0;
  const from = input.afterSeq ?? (shown.length < input.limit ? 0 : first.seq - 1); // the page holds every line after this seq
  if (from > input.cursor) return 0;
  return shown.filter((message) => message.state !== 'streaming').at(-1)?.seq ?? 0;
}

/** The run `runId` read its own chat `conversationId` completely up to `seq` (the highest mark of the run counts). */
export function noteTurnRead(services: object, runId: string, conversationId: string, seq: number): void {
  if (seq <= 0) return;
  const known = marks.get(services) ?? new Map<string, { conversationId: string; seq: number }>();
  marks.set(services, known);
  const before = known.get(runId);
  if (before?.conversationId === conversationId && before.seq >= seq) return;
  known.delete(runId);
  if (known.size >= MARKS) known.delete(known.keys().next().value!);
  known.set(runId, { conversationId, seq });
}

/** How far the run read its chat `conversationId` (0: not at all); forgets the run's mark. */
export function takeTurnRead(services: object, runId: string, conversationId: string | undefined): number {
  const known = marks.get(services);
  const mark = known?.get(runId);
  known?.delete(runId);
  return mark && mark.conversationId === conversationId ? mark.seq : 0;
}
