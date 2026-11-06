// A call as one bubble in the chat log (its row's meta.call, runtime/calls/call-log.ts – the same on every device):
// "Call · 21:24 · 4:42", or "running" while it goes on; a click opens the whole transcript, both sides (open from the
// start while the call runs). The rows its lines name are folded into it (message-rows.ts) and show here as themselves –
// in full, with files and their run line – in the lines' order; a line whose row this device has not loaded shows the
// words the call row keeps (callEntries).
// Owns: the disclosure and the transcript's order. Never: loads or copies a second log; renders a message itself (MessageItem).

import { useState } from 'preact/hooks';
import { callLength, callRecord } from '../../../shared/model/call.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { Icon } from '../../lib/ui.tsx';
import { time } from '../../lib/format.ts';
import { MessageItem } from '../MessageItem.tsx';
import { callEntries } from '../message-rows.ts';

/** "Call · 21:24 · 4:42" or "Call · 21:24 · running". */
function callTitle(call: { startedAt: number; endedAt?: number }): string {
  return `Call · ${time(call.startedAt)} · ${call.endedAt === undefined ? 'running' : callLength(call.endedAt - call.startedAt)}`;
}

/**
 * `messages`: the call's row first, then the rows folded into it. `runLines`: the messages that carry their run's line
 * (MessageList, message-rows.ts runLineIds).
 */
export function CallTranscript(props: { messages: Message[]; runLines?: ReadonlySet<string> }) {
  const row = props.messages[0];
  const call = row ? callRecord(row) : undefined;
  const [open, setOpen] = useState(call?.endedAt === undefined);
  if (!row || !call) return null;
  const entries = callEntries(props.messages);
  return (
    <section class="call-transcript" data-message-id={row.id} aria-label="Call transcript">
      <button type="button" class="call-transcript-toggle" aria-expanded={open} title={call.name} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={11} />{/* its words say "Call": the text starts where every event line's does */}
        <span class="tabular">{callTitle(call)}</span>
      </button>
      {open && <div class="call-transcript-body">
        {!entries.length && <p class="muted">Nothing said yet.</p>}
        {entries.map(({ line, message }, index) => (message
          ? <MessageItem key={message.id} message={message} runLine={props.runLines?.has(message.id)} />
          : <p key={line.messageId ?? index} class="call-line" data-from={line.from.startsWith('agent:') ? 'agent' : 'person'}>
            <strong>{line.name}</strong> <time class="muted tabular">{time(line.at)}</time><br />{line.text}
          </p>))}
      </div>}
    </section>
  );
}
