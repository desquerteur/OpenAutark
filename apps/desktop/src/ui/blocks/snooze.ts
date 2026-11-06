// Where an ask widget offers Snooze (F03): only where a to-do stands behind it – snoozing is a
// to-do's wait (todos.snooze), so a widget without one would always fail with "To-do not found".
// B-078 D9: a chat block has a to-do only when it is important, says "todo": true or is a timer (catalog.ts becomesTodo).
// Owns: that rule (unit-tested in test/unit/ui/snooze-offer.test.ts). Never: imports rpc or the DOM.

import { becomesTodo, type UiBlock } from '../../shared/blocks/catalog.ts';
import type { AskTarget } from './ask.ts';

/** A to-do target; a chat block only when it became a to-do. */
export function canSnooze(block: Partial<Pick<UiBlock, 'type' | 'todo' | 'important' | 'priority'>>, target: AskTarget): boolean {
  return target.kind !== 'block' || becomesTodo(block);
}
