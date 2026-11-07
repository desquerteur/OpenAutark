// AF-016 – what a chat's prompt queue does when a run in that chat ended (pure, unit-tested). A failed run pauses it
// ('error', the run's error as its note); a finished run that asked the person something pauses it ('ask'); anything else
// lets the top prompt go out once the chat's work is over (an interrupted run hands over to the turn that follows; the
// person's Stop paused the queue before the run ended). Asking the person: human.ask, an ask block or mini-app to-do in
// the answer, a new to-do of the person in the chat, or an answer whose last line outside code ends with a question mark.
// Owns: these decisions and the answer checks. Never: reads the database or sends (service.ts).

import type { RunStatus } from '../../shared/model/runs.ts';
import type { QueuePause } from '../../shared/model/prompt-queue.ts';
import { ASK_TYPES } from '../../shared/blocks/catalog.ts';

export type AfterRun = 'next' | { pause: QueuePause; note?: string };

const NOTE_MAX = 300;

/** The queue's next step after a run of its chat ended with `status` (`asked`: it asked the person something). */
export function afterRun(end: { status: RunStatus; error?: string; asked: boolean }): AfterRun {
  if (end.status === 'failed') return { pause: 'error', note: (end.error ?? 'The agent\'s turn failed.').slice(0, NOTE_MAX) };
  if (end.status === 'done' && end.asked) return { pause: 'ask' };
  return 'next';
}

/** The answer's last line outside code fences ends with a question mark (also behind closing quotes or emphasis). */
export function endsWithQuestion(body: string): boolean {
  const prose = body.replace(/```[\s\S]*?(```|$)/g, '\n');
  const last = prose.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
  return /[?？][\s"'”’»)\]*_~]*$/.test(last);
}

/** An ask block (```ui with an ask type or "todo": true) or a mini-app to-do (```app … todo=true) in the answer. */
export function hasAskBlock(body: string): boolean {
  for (const match of body.matchAll(/```(ui|app)([^\n]*)\n([\s\S]*?)```/g)) {
    if (match[1] === 'app') { if (/\btodo\s*=\s*"?true"?/.test(match[2])) return true; continue; }
    try {
      const block = JSON.parse(match[3]) as { type?: unknown; todo?: unknown };
      if (block.todo === true || (typeof block.type === 'string' && (ASK_TYPES as ReadonlySet<string>).has(block.type))) return true;
    } catch { /* not a block: no question */ }
  }
  return false;
}
