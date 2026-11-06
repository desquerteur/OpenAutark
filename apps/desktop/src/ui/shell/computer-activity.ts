// Computer use on this PC as the window sees it (MP7): one shared signal fed by
// `computer.activity` events (system topic, at most one per second) and loaded again after every
// (re)connect – no polling –, plus the person's Stop / Resume (Workspace › Screen).
// Owns: that signal, the actions and the texts. Never: decides anything (the runtime's
// latch does) or calls the methods without the capability (session.can).

import { signal } from '@preact/signals';
import type { ComputerActivityState } from '../../shared/model/computer.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';

/** null until the runtime answered (or when this connection may not see it). */
export const computerActivity = signal<ComputerActivityState | null>(null);

let watching = false;

function take(state: ComputerActivityState): void {
  const current = computerActivity.peek();
  if (current && state.at < current.at) return; // an older answer after a newer event
  computerActivity.value = state;
}

/** After a (re)connect the runtime's answer counts as is (a restarted runtime starts its clock anew). */
function load(): void {
  if (!can('computer.activity')) return;
  rpc.call('computer.activity').then((state) => { computerActivity.value = state; }, () => undefined);
}

/** Starts following computer use once (idempotent; the status line (computer-notice.ts) and Workspace › Screen call it). */
export function watchComputerActivity(): void {
  if (watching) return;
  watching = true;
  rpc.on('computer.activity', take);
  rpc.onOpen(load);
  load();
}

export async function stopComputerUse(): Promise<void> {
  try { take(await rpc.call('computer.stop')); } catch (error) { toastError(error, 'Computer use was not stopped'); }
}

export async function resumeComputerUse(): Promise<void> {
  try { take(await rpc.call('computer.resume')); } catch (error) { toastError(error, 'Computer use was not resumed'); }
}
