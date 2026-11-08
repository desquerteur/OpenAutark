// The message list's rows (split from MessageList.tsx): consecutive status lines form one burst,
// which StatusGroup (MessageItem.tsx) renders as one expandable line under the id of its newest
// line the person sees – agents' edit and delete notices are hidden there (C6). D5: a run's
// streaming answer is live work, not a row – WorkingMessage.tsx's PendingWork shows every live run
// of the chat after all rows, ordered by start (liveWork), so whatever the run posts appears above
// it; and one message per finished run carries its "Worked … · N steps" line (runLineIds).
// B-075: live work is the chat's rows in state 'streaming' – each carries its run's live values (meta.live) – never
// this PC's activity, so every device shows the same blocks. A call is one bubble at its row (meta.call with its lines,
// runtime/calls/call-log.ts): the rows its lines name fold into it, wherever they stand, and show there in full
// (callEntries); every other row – an answer that came after the call ended too – stays a row, so nothing is hidden.
// Owns: the grouping, which rendered line a message is found under, the live work list, the run line's message and a call
// bubble's entries. Never: renders, scrolls or reads the DOM (MessageList.tsx looks the line up).

import { callRecord, type CallLine } from '../../shared/model/call.ts';
import type { Message } from '../../shared/model/chat.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';

/** AF-017: the status line of a hire by an agent ("New agent" card, AgentHiredCard.tsx). */
export function isHireLine(message: Message): boolean {
  return message.kind === 'status' && message.meta.status?.type === 'agent_hired';
}

/** A run's own answer message (its reply with meta.model, or its failed/stopped end) – not a chat.send post of the run. */
function isAnswer(message: Message): boolean {
  return message.authorKind === 'agent' && Boolean(message.runId) && message.kind !== 'status' && message.kind !== 'task'
    && (typeof message.meta.model === 'string' || message.state === 'failed' || message.state === 'stopped');
}

/** A run's answer still being written: shown in the live block at the bottom, not at its seq. */
export function isLiveWork(message: Message): boolean {
  return message.authorKind === 'agent' && message.state === 'streaming' && Boolean(message.runId);
}

/** When a run's row says it started (B-075 meta.live.startedAt), else when the row was made. */
export function liveStart(message: Message): number {
  return message.meta.live?.startedAt ?? message.createdAt;
}

/**
 * Every live run of a chat for the block at its bottom: its rows in state 'streaming' (B-075: each with its run's live
 * values), one per run, ordered by start, so a later run is below an earlier one and nothing reorders. A run whose
 * answer already arrived is that answer, never a second block. B-057: a split's run has no row – its group has one
 * block (splits/split-text.ts chatGroups, WorkingMessage.tsx PendingWork).
 */
export function liveWork(messages: readonly Message[]): Message[] {
  const shown = new Set(messages.filter((message) => isAnswer(message) && message.state !== 'streaming').map((message) => message.runId!));
  const out: Message[] = [];
  for (const message of messages) {
    if (!isLiveWork(message) || shown.has(message.runId!)) continue;
    shown.add(message.runId!);
    out.push(message);
  }
  return out.sort((a, b) => liveStart(a) - liveStart(b));
}

/** B-075: the runs of these rows still at work (their rows stream). */
export function liveRunIds(messages: readonly Message[]): Set<string> {
  return new Set(messages.filter((message) => message.state === 'streaming' && message.runId).map((message) => message.runId!));
}

/**
 * The messages that carry their run's "Worked … · N steps" line (D5): per run, its answer – the
 * agent's own reply (meta.model) or the run's failed/stopped placeholder, the latest one – else,
 * once the run no longer runs, the run's last post (an answer kept internal, D4: chat.send posts
 * carry their run's id). A run still live has its steps in the live block instead.
 */
export function runLineIds(list: readonly Message[], live: ReadonlySet<string>): Set<string> {
  const answers = new Map<string, Message>();
  const posts = new Map<string, Message>();
  for (const message of list) {
    if (message.authorKind !== 'agent' || !message.runId || message.kind === 'status' || message.kind === 'task' || isLiveWork(message)) continue;
    const map = isAnswer(message) ? answers : posts;
    const before = map.get(message.runId);
    if (!before || message.seq > before.seq) map.set(message.runId, message);
  }
  const ids = new Set<string>();
  for (const [runId, post] of posts) if (!answers.has(runId) && !live.has(runId)) ids.add(post.id);
  for (const answer of answers.values()) ids.add(answer.id);
  return ids;
}

export type Row = { kind: 'message'; message: Message } | { kind: 'status'; messages: Message[] } | { kind: 'call'; callId: string; messages: Message[] };

type CallRow = Extract<Row, { kind: 'call' }>;

/** Rows in order; a call's row first in its bubble's messages, then the rows its lines name. */
export function groupRows(list: readonly Message[]): Row[] {
  const rows: Row[] = [];
  const calls = new Map<string, CallRow>(); // call row id → its bubble
  const folded = new Map<string, CallRow>(); // a line's message id → the bubble it folds into
  for (const message of list) {
    const call = callRecord(message);
    if (!call) continue;
    const row: CallRow = { kind: 'call', callId: call.id, messages: [message] };
    calls.set(message.id, row);
    for (const line of call.lines) if (line.messageId) folded.set(line.messageId, row);
  }
  for (const message of list) {
    if (isLiveWork(message)) continue; // D5: the live block at the bottom shows it (liveWork)
    const call = calls.get(message.id);
    if (call) { rows.push(call); continue; }
    const into = folded.get(message.id);
    if (into) { into.messages.push(message); continue; }
    const last = rows[rows.length - 1];
    if (message.kind === 'status') {
      // AF-017: a hire is its own row (the "New agent" card), never folded into a burst
      if (isHireLine(message) || (last?.kind === 'status' && last.messages.some(isHireLine))) rows.push({ kind: 'status', messages: [message] });
      else if (last?.kind === 'status') last.messages.push(message);
      else rows.push({ kind: 'status', messages: [message] });
    } else rows.push({ kind: 'message', message });
  }
  return rows;
}

/**
 * A call bubble's transcript (CallTranscript.tsx): each of its lines with its row when this device has it loaded – shown
 * as the message itself, in full, with files and markdown – else only the line's stored words (a row not loaded here).
 */
export function callEntries(messages: readonly Message[]): Array<{ line: CallLine; message?: Message }> {
  const call = messages[0] ? callRecord(messages[0]) : undefined;
  const rows = new Map(messages.slice(1).map((message) => [message.id, message]));
  return (call?.lines ?? []).map((line) => {
    const message = line.messageId ? rows.get(line.messageId) : undefined;
    return message ? { line, message } : { line };
  });
}

export function rowHas(row: Row, messageId: string): boolean {
  return row.kind === 'message' ? row.message.id === messageId : row.messages.some((message) => message.id === messageId);
}

/**
 * The line a message of a collapsed status burst is found under: the burst's newest line the
 * person sees (C4 jumps). Undefined when no burst holds the message or the burst shows nothing
 * (only agents' notices).
 */
export function burstLineFor(rows: readonly Row[], messageId: string): string | undefined {
  const call = rows.find(row => row.kind === 'call' && rowHas(row, messageId));
  if (call?.kind === 'call') return call.messages[0]?.id;
  const burst = rows.find((row) => row.kind === 'status' && rowHas(row, messageId));
  if (burst?.kind !== 'status') return undefined;
  const shown = burst.messages.filter((message) => !isAgentNotice(message));
  return shown[shown.length - 1]?.id;
}
