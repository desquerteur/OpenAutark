// Element steps that leave the shared pointer alone while the person uses the PC (23.10.2026,
// concept-native-resilient-computer-use "Zusätzliche sichere Arbeits-/Eingabeebenen").
// The person and agents share one mouse and keyboard; pattern actions (UI Automation Invoke,
// Toggle, SelectionItem – AT-SPI actions on Linux) operate an element without them, so they run
// even while the person works (computer/service.ts gates only pointer steps by presence). When a
// computer.act click is refused because the person is using the PC (or the PC cannot tell), the
// element's own pattern action runs instead – only where it is the same step:
//   button, hyperlink, menu item with Invoke → invoke · checkbox with Toggle → toggle ·
//   radio button, tab, list, tree or data item with SelectionItem → select.
// Not swapped: double and right clicks and focus (no pattern does the same; focus moves the
// keyboard), elements of unknown role or patterns (a name / automation id lookup), list items with
// Invoke (that opens the item, a click selects it), split buttons (the click point decides).
// Each swap is the same or a milder step.
// B-055 Q10: the same swap runs when another agent holds the mouse and keyboard (lease.ts): the
// pattern action leaves the holder's pointer alone, so agents work in parallel.
// Owns: the swap table and its note. Never: judges presence (presence.ts) or the lease, acts, or
// swaps when the PC is free (the agent's own choice of a click stands then).

import type { WorkforceError } from '../../shared/errors.ts';
import { isPresenceRefusal } from './presence.ts';
import { isLeaseRefusal } from './lease.ts';
import type { ElementAction } from './service.ts';

const INVOKE_ROLES = new Set(['button', 'hyperlink', 'menuitem']);
const SELECT_ROLES = new Set(['radiobutton', 'tabitem', 'listitem', 'treeitem', 'dataitem']);

/** What an observed element can do without the pointer (its role and patterns from computer.ui_tree). */
export interface QuietTarget { role: string; patterns?: readonly string[] }

/** The pattern action that is the same step as `action` on `target`, if there is one. */
export function quietEquivalent(action: ElementAction, target: QuietTarget | undefined): ElementAction | undefined {
  if (action !== 'click' || !target?.patterns?.length) return undefined;
  const has = (pattern: string) => target.patterns!.includes(pattern);
  if (INVOKE_ROLES.has(target.role) && has('invoke')) return 'invoke';
  if (target.role === 'checkbox' && has('toggle')) return 'toggle';
  if (SELECT_ROLES.has(target.role) && has('select')) return 'select';
  return undefined;
}

/**
 * Runs the pointer step's presence gate; when it refuses and the element offers the same step as a
 * pattern action, that action is returned with a note for the agent. Any other error is rethrown.
 */
export async function pointerOrQuiet(action: ElementAction, target: QuietTarget | undefined, gate: () => Promise<void>): Promise<{ action: ElementAction; note?: string }> {
  try {
    await gate();
    return { action };
  } catch (error) {
    const leased = isLeaseRefusal(error);
    const quiet = isPresenceRefusal(error) || leased ? quietEquivalent(action, target) : undefined;
    if (!quiet) throw error;
    const holder = leased ? (error as WorkforceError).details?.lease as { holder?: string } | undefined : undefined;
    const why = leased ? `${holder?.holder ?? 'another agent'} is using the mouse and keyboard`
      : (error as WorkforceError).code === 'unavailable' ? 'this PC cannot tell whether the person is using it' : 'the person is using the PC';
    return { action: quiet, note: `Ran ${quiet} instead of ${action}: ${why}, so this step used the element's own ${quiet} action and left the mouse alone.` };
  }
}
