// The person's emergency stop of all agent work on the PC (21.10. 17:09) as the window and the phone
// see it: one shared signal fed by `work.state` events (system topic) and loaded again after every
// (re)connect – no polling –, plus Stop and Resume. The chat itself has no Stop button; this brake is
// reached deliberately: the chat header's live line ("Mira · …" › Stop all agent work), the command
// palette, and while stopped the status line (StatusLine.tsx) offers Resume.
// Owns: that signal and the actions. Never: decides anything (the runtime's latch
// does, agents/work-stop.ts) or calls a method without the capability (session.can).

import { signal } from '@preact/signals';
import type { MethodName } from '../../shared/api/methods.ts';
import type { WorkStopState } from '../../shared/model/work-stop.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';

/** null until the runtime answered (or when this connection may not see it). */
export const workStop = signal<WorkStopState | null>(null);

let watching = false;

function take(state: WorkStopState): void {
  const current = workStop.peek();
  if (current && state.at < current.at) return; // an older answer after a newer event
  workStop.value = state;
}

function load(): void {
  if (!can('work.state')) return;
  rpc.call('work.state').then((state) => { workStop.value = state; }, () => undefined);
}

/** Starts following the stop once (idempotent; the pill, the header and the palette call it). */
export function watchWorkStop(): void {
  if (watching) return;
  watching = true;
  rpc.on('work.state', take);
  rpc.onOpen(load);
  load();
}

/** Stops every agent's work on the PC now (tasks pause; nothing runs until Resume). */
export async function stopAllWork(): Promise<void> {
  try { take(await rpc.call('work.stop')); } catch (error) { toastError(error, 'Agent work was not stopped'); }
}

export async function resumeAllWork(): Promise<void> {
  try { take(await rpc.call('work.resume')); } catch (error) { toastError(error, 'Agent work was not resumed'); }
}

/** The palette's brake entry: Stop while work may run, Resume while stopped (null when this connection may do neither). */
export function workAction(state: WorkStopState | null, may: (method: MethodName) => boolean = can): 'stop' | 'resume' | null {
  if (state?.stopped) return may('work.resume') ? 'resume' : null;
  return may('work.stop') ? 'stop' : null;
}
