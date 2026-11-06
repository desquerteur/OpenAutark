// Human priority for computer use (ComputerService.guardHuman): is the person using this PC right
// now? The helper's 'presence' answer – the idle time of the person's input (Windows
// GetLastInputInfo; Linux X11 XScreenSaver, linux_guard.py) and how long ago the helper injected
// its own input – decides with millisecond ticks: input newer than our own (150 ms slack) is the
// person's. Review fix 23.10.2026: a helper without an idle source (Linux without XScreenSaver:
// idleUnknown) is judged with the host's idle time instead, which counts whole seconds, so input
// counts as the person's only when it is clearly (1 s) newer than our own; a PC without any idle
// source (a headless worker) cannot tell the person from itself, so its mouse and keyboard are
// not used ('unavailable').
// Its refusals are marked (isPresenceRefusal): computer.act then runs a click as the element's own
// pattern action instead, where one exists (quiet-actions.ts).
// Owns: this judgement and its errors. Never: calls the helper or the host itself, or retries.

import { WorkforceError } from '../../shared/errors.ts';

/** Human input within this many seconds pauses agents. */
export const HUMAN_IDLE_SECONDS = 2;

/** The helper's 'presence' answer. */
export interface Presence { idleMs?: number; injectedAgoMs?: number | null; idleUnknown?: boolean }

/** The errors below: mouse and keyboard are off limits right now (not a failure of the step). */
const refusals = new WeakSet<WorkforceError>();
function refusal(error: WorkforceError): WorkforceError { refusals.add(error); return error; }

/** This error says the person is using the PC, or that it cannot be told – not that the step failed. */
export function isPresenceRefusal(error: unknown): boolean {
  return error instanceof WorkforceError && refusals.has(error);
}

export function humanActive(): WorkforceError {
  return refusal(new WorkforceError('conflict', 'The person is using the computer – retrying later. I wait a few seconds, re-observe, and continue when my target is still valid.', { retryAfterMs: 5000 }));
}

/** Throws when the person is using the PC (or that cannot be told); `hostIdleMs`: the host's idle time, when it has one. */
export function judgePresence(presence: Presence | undefined, hostIdleMs?: number): void {
  const injectedAgo = typeof presence?.injectedAgoMs === 'number' ? presence.injectedAgoMs : undefined;
  let idleMs = typeof presence?.idleMs === 'number' ? presence.idleMs : undefined;
  let slackMs = 150;
  if (idleMs === undefined && presence?.idleUnknown) {
    if (hostIdleMs === undefined) {
      throw refusal(new WorkforceError('unavailable', 'This PC cannot tell whether the person is using it (its desktop gives no idle time), so agents do not use its mouse or keyboard. Element actions (computer.act) still work.'));
    }
    idleMs = hostIdleMs;
    slackMs = 1000; // the host counts whole seconds
  }
  idleMs ??= Number.POSITIVE_INFINITY;
  if (idleMs < HUMAN_IDLE_SECONDS * 1000 && (injectedAgo === undefined || idleMs + slackMs < injectedAgo)) throw humanActive();
}
