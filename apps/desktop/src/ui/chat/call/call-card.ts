// AF-015: the call card in the chat (CallTranscript.tsx) as plain data – what a call row (CallRecord, the same on every
// device) says at a glance: who the call was with, when, how long it ran (or that it still runs) and how many lines its
// transcript holds. The transcript itself stays behind the card's disclosure.
// Owns: the card's words. Never: renders, or reads a store.

import { callLength, type CallRecord } from '../../../shared/model/call.ts';

export interface CallCardView {
  /** "Call with Ava" (the agents heard in it, else the chat's name), else "Call". */
  title: string;
  /** "4:42", or "Running" while the call goes on. */
  length: string;
  running: boolean;
  /** "3 lines", "1 line", "Nothing said". */
  lines: string;
  /** The transcript's line count. */
  count: number;
}

/** The names of the agents heard in the call, in the order they first spoke ("Ava", "Ava and Mira", "Ava, Mira +1"). */
export function callPartners(call: Pick<CallRecord, 'lines'>): string {
  const names: string[] = [];
  for (const line of call.lines) if (line.from.startsWith('agent:') && line.name && !names.includes(line.name)) names.push(line.name);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** The card of `call`; `chatName`: the chat's name when no agent spoke yet. */
export function callCardView(call: Pick<CallRecord, 'startedAt' | 'endedAt' | 'lines'>, chatName?: string): CallCardView {
  const partners = callPartners(call) || chatName?.trim() || '';
  const running = call.endedAt === undefined;
  const count = call.lines.length;
  return {
    title: partners ? `Call with ${partners}` : 'Call',
    length: running ? 'Running' : callLength(call.endedAt! - call.startedAt),
    running,
    lines: count === 0 ? 'Nothing said' : `${count} ${count === 1 ? 'line' : 'lines'}`,
    count,
  };
}
