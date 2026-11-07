// A call as one card in the chat log (its row's meta.call, runtime/calls/call-log.ts – the same on every device).
// AF-015: the card says at a glance what it was – a phone mark, "Call with Ava", when it started, how long it ran (or
// "Running", with "Open call" while this device's call view runs it) and how many lines were said (call-card.ts) – and
// keeps the transcript behind its disclosure: closed once the call ended, open while it runs. The rows its lines name
// are folded into it (message-rows.ts) and show here as themselves – in full, with files and their run line – in the
// lines' order; a line whose row this device has not loaded shows the words the call row keeps (callEntries).
// Owns: the card, the disclosure and the transcript's order. Never: loads or copies a second log; renders a message itself (MessageItem).

import { useState } from 'preact/hooks';
import { callRecord } from '../../../shared/model/call.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { Icon } from '../../lib/ui.tsx';
import { dayMonth, relativeDay, time } from '../../lib/format.ts';
import { chatTitle } from '../../lib/chat-face.tsx';
import { conversationMap } from '../../lib/store.ts';
import { MessageItem } from '../MessageItem.tsx';
import { callEntries } from '../message-rows.ts';
import { callCardView } from './call-card.ts';
import { callOpenIn, callUi, showCall } from './call-session.ts';

/** "Today, 21:24", "Yesterday, 09:10", else "30 Oct, 21:24". */
function startedText(ms: number, now = Date.now()): string {
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 0 || days === -1 ? relativeDay(ms, now) : dayMonth(ms);
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${time(ms)}`;
}

/**
 * `messages`: the call's row first, then the rows folded into it. `runLines`: the messages that carry their run's line
 * (MessageList, message-rows.ts runLineIds).
 */
export function CallTranscript(props: { messages: Message[]; runLines?: ReadonlySet<string> }) {
  const row = props.messages[0];
  const call = row ? callRecord(row) : undefined;
  const [choice, setChoice] = useState<boolean | null>(null); // the person's toggle; else open exactly while the call runs
  if (!row || !call) return null;
  const entries = callEntries(props.messages);
  const chat = conversationMap.value.get(row.conversationId);
  const card = callCardView(call, chat ? chatTitle(chat) : undefined);
  const open = choice ?? card.running;
  const here = card.running && callOpenIn(row.conversationId) && callUi.value?.view !== 'full';
  const bodyId = `call-${row.id}`;
  return (
    <section class={`call-transcript call-card${card.running ? ' running' : ''}`} data-message-id={row.id} aria-label={card.title}>
      <div class="call-card-head">
        <span class="call-card-mark" aria-hidden="true"><Icon name={card.running ? 'phone' : 'phone-disconnect'} size={18} /></span>
        <div class="call-card-text">
          <span class="call-card-title">{card.title}</span>
          <span class="call-card-meta muted tabular">
            <time dateTime={new Date(call.startedAt).toISOString()}>{startedText(call.startedAt)}</time> · {card.lines}
          </span>
        </div>
        <span class={`call-card-length tabular${card.running ? ' live' : ''}`}>{card.length}</span>
      </div>
      <div class="call-card-actions">
        <button type="button" class="call-transcript-toggle" aria-expanded={open} aria-controls={bodyId} title={call.name} onClick={() => setChoice(!open)}>
          <Icon name={open ? 'caret-down' : 'caret-right'} size={11} />
          <span>{open ? 'Hide transcript' : 'Transcript'}</span>
        </button>
        {here && <button type="button" class="call-card-open" onClick={() => showCall(row.conversationId)}><Icon name="arrows-out-simple" size={14} />Open call</button>}
      </div>
      {open && <div class="call-transcript-body" id={bodyId}>
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
