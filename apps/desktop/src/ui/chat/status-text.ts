// A quiet status line's words as the chat shows them (MessageItem.tsx StatusGroup). The runtime writes a
// call cut off by a stop or a restart as "Cut off by your stop: bash – Ran a command" (tasks/recover-notes.ts:
// the tool's name stays in the stored line for the agents' history and the logs); the person reads it in the
// run line's words (shared/text/step-label.ts): "Cut off by your stop: Ran a command", a call whose only
// detail is its arguments "Cut off by a restart: Ran git push" (C3 fix: no raw tool name in the chat).
// Owns: that wording. Never: changes the stored line; any other status line shows as written.

import type { Message } from '../../shared/model/chat.ts';
import { stepLabel, stepText } from '../../shared/text/step-label.ts';

const CUT_OFF = /^(Cut off by [^:]+): (\S+)(?: – ([\s\S]+))?$/;

/** The call's arguments when the line's detail is their JSON preview (a call without a summary). */
function argsOf(detail: string): Record<string, unknown> | undefined {
  if (!detail.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(detail);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** The line as shown: a cut-off call in the run line's words, any other line as written. */
export function statusText(message: Pick<Message, 'body' | 'meta'>): string {
  const status = message.meta.status;
  const text = status?.text ?? message.body;
  if (status?.details?.unknownEffect !== true) return text;
  const match = CUT_OFF.exec(text);
  if (!match) return text;
  const [, head, tool, detail = ''] = match;
  const args = argsOf(detail);
  return `${head}: ${args || !detail ? stepText(stepLabel(tool, args ?? {})) : detail}`;
}
