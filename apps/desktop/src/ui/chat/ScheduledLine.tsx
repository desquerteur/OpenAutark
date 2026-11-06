// The chat's quiet "Scheduled · <when> · <title>" line (B-044) for a status line of type
// schedule_created – the runtime writes one when the person schedules a post or an agent a post or
// routine (schedules/fire.ts announceCreated). The first run shows in the viewer's own locale
// (details.nextAt); a click opens Chat details and scrolls to Scheduled. Older lines without a
// time keep their own text.
// Owns: that line. Never: loads or changes schedules (Chat details › Scheduled does).

import type { Message } from '../../shared/model/chat.ts';
import { fullDate, time } from '../lib/format.ts';
import { setChatPanel } from '../lib/shell-state.ts';
import { whenText } from './details/Schedules.tsx';

/** The line's words: "Scheduled · Mon 09:00 · Weekly recap" (or the stored text). */
export function scheduledLabel(message: Message, now = Date.now()): string {
  const status = message.meta.status;
  const text = status?.text ?? message.body;
  const nextAt = status?.details?.nextAt;
  if (typeof nextAt !== 'number' || !Number.isFinite(nextAt)) return text;
  const title = text.replace(/^Scheduled\s*[:·]\s*/, '').trim();
  return `Scheduled · ${whenText(nextAt, now)}${title ? ` · ${title}` : ''}`;
}

function showScheduled(conversationId: string): void {
  setChatPanel(conversationId, 'details');
  const scroll = () => document.querySelector('.chat-details section[aria-label="Scheduled"]')?.scrollIntoView({ block: 'start' });
  requestAnimationFrame(() => { scroll(); setTimeout(scroll, 250); }); // the list loads after the panel opens
}

export function ScheduledLine(props: { message: Message }) {
  const { message } = props;
  const nextAt = message.meta.status?.details?.nextAt;
  return (
    <div class="status-line scheduled-line" data-message-id={message.id}>
      <button type="button" class="scheduled-link" title={typeof nextAt === 'number' ? fullDate(nextAt) : undefined}
        onClick={() => showScheduled(message.conversationId)}>{scheduledLabel(message)}</button>
      <time class="tabular">{time(message.createdAt)}</time>
    </div>
  );
}
