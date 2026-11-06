// The "New messages" divider before the first new message, and the "↓ N new" pill at the bottom of the list
// while new messages are below the visible part.
// Owns: the divider and pill markup. Never: decides what is new (catch-up.ts) or scrolls.

import { Chip } from '../lib/ui.tsx';

export function UnreadDivider(props: { count: number }) {
  return (
    <div class="unread-block">
      <div class="unread-divider" role="separator" aria-label={`${props.count} new ${props.count === 1 ? 'message' : 'messages'}`}><span>New messages</span></div>
    </div>
  );
}

/** "↓ N new": new messages below the visible part; a click goes to the newest message. */
export function NewPill(props: { count: number; onClick: () => void }) {
  if (props.count <= 0) return null;
  return (
    <div class="new-pill-dock">
      <Chip icon="arrow-down" class="new-pill" aria-label={`Go to the newest message, ${props.count} new below`} onClick={props.onClick}>
        {props.count} new
      </Chip>
    </div>
  );
}
