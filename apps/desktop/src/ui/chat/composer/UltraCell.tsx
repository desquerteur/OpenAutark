// The composer's Ultra switch, directly beside the model chip: a small labelled toggle ("Ultra", accent while on)
// of one fixed width that suggests Ultra for the next message (messages.send ultra → meta.ultra; the agent decides
// whether to split the work). Sending turns it off again (draft.ts). In a chat without an agent an inert box of
// the same width keeps the row as it is.
// Owns: the switch. Never: keeps the state itself (the draft does) or sends.

import type { ConversationSummary } from '../../../shared/model/chat.ts';
import { scheduleModeFor } from './schedule-mode.ts';

export const ULTRA_TITLE = { on: 'Ultra suggested for this message', off: 'Suggest Ultra for this message' } as const;

/** Whether the chat offers the switch: an agent is in it (else nobody could take the suggestion – a hidden one is not sent). */
export function ultraOffered(chat: Pick<ConversationSummary, 'members'>): boolean {
  return chat.members.some((member) => member.kind === 'agent' && !member.leftAt);
}

export function UltraCell(props: { chat: ConversationSummary; on: boolean; onToggle: (on: boolean) => void }) {
  // Editing a scheduled message cannot change its Ultra hint (schedules.update has none): the same inert box
  if (!ultraOffered(props.chat) || scheduleModeFor(props.chat.id).value?.edit) return <span class="ultra-switch placeholder" aria-hidden="true" />;
  return (
    <button type="button" class={`ultra-switch${props.on ? ' on' : ''}`} role="switch" aria-checked={props.on}
      title={props.on ? ULTRA_TITLE.on : ULTRA_TITLE.off} onClick={() => props.onToggle(!props.on)}>
      Ultra
    </button>
  );
}
