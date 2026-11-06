// "Set up team again" (O7, B-044): the one flow behind Team's Add menu ("Start setup again") and
// the command palette ("Set up team again") – a confirm, then onboarding.reset (first-run.ts
// setUpTeamAgain): the first-run cards from the first one, on Home. Only for the owner while a
// Manager exists to run the setup. Agents, chats and settings stay as they are.
// Owns: the gate, the confirm and the error toast. Never: resets anything itself (the runtime's
// onboarding.reset does) or renders.

import { confirm } from '../lib/dialog.tsx';
import { can } from '../lib/session.ts';
import { agents } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { managerAgent, setUpTeamAgain } from './first-run.ts';

/** This connection may start the setup again (owner, a Manager to run it). */
export function setupAgainAllowed(): boolean {
  return can('onboarding.reset') && Boolean(managerAgent(agents.value));
}

/** Asks once, then opens the first-run cards on Home again. */
export async function startSetupAgain(): Promise<void> {
  const ok = await confirm({ title: 'Start setup again?', body: 'The setup cards open on Home again. Your agents and chats stay.', confirmLabel: 'Start setup' });
  if (!ok) return;
  await setUpTeamAgain().catch((error) => toastError(error, 'Could not start the setup'));
}
