// What Send does and says (feedback panel): one button – "Send" where this build can send (feedback.status: the
// release's receiver), else "Save" (also while that is still unknown: a click never sends more than its label said)
// – and one result line. A report is always saved on the PC first; sending is one feedback.send on top. When that
// send was not confirmed (the report is only saved), the result's one action cell says "Send again" instead of
// Close and sends the same saved report (its text and screenshot stay in it).
// Owns: the can-we-send answer, the button's label and the result line. Never: publishes without a click or
// opens a browser.

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { FeedbackReport } from '../../shared/model/system.ts';
import { bridge } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { session } from '../lib/session.ts';

/** Can this build send feedback? undefined until known; a failed read shows false (Save). */
export const feedbackSending = signal<boolean | undefined>(undefined);
let asking: Promise<void> | undefined;

/** The current answer (undefined while unknown); asked on first use and again when the session changes until it answered. */
export function useFeedbackSending(): boolean | undefined {
  const info = session.value;
  useEffect(() => {
    if (feedbackSending.peek() === true) return;
    asking ??= rpc.call('feedback.status')
      .then((status) => { feedbackSending.value = status.sending === true; })
      .catch(() => { feedbackSending.value = false; })
      .finally(() => { asking = undefined; });
  }, [info]);
  return feedbackSending.value;
}

/** Sends the saved report; the report as the runtime now holds it. */
export function sendReport(id: string): Promise<FeedbackReport> {
  return rpc.call('feedback.send', { id });
}

/** The button: Send where this build can send, else Save – also while that is unknown. */
export function sendLabel(sending: boolean | undefined, busy: boolean): string {
  if (sending === true) return busy ? 'Sending…' : 'Send';
  return busy ? 'Saving…' : 'Save';
}

/** After an unconfirmed send (only saved on the PC) where this build can send: the result's action is "Send again". */
export function canSendAgain(status: FeedbackReport['status'], sending: boolean | undefined): boolean {
  return sending === true && (status === 'local' || status === 'draft' || status === 'queued');
}

export function sendAgainLabel(busy: boolean): string {
  return busy ? 'Sending…' : 'Send again';
}

/** The screenshot row: the checkbox and the one line under it. */
export const SHOT_LABEL = 'Screenshot';
export const SHOT_HINT = 'Paint over anything private.';
export const SHOT_MISSING = 'The window could not be captured.';

/** The result line after Send/Save. `here`: the desktop window (else a phone: "your PC"). */
export function doneText(status: FeedbackReport['status'], sending: boolean, here = Boolean(bridge)): string {
  if (status === 'sent') return 'Sent.';
  if (status === 'received') return 'Received.';
  const saved = here ? 'Saved on this PC' : 'Saved on your PC';
  return sending ? `${saved}.` : `${saved} – sending is not set up.`;
}
