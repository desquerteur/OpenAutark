// B-059 (mail without loops): the two small rules that keep agent mail from ping-ponging with robots.
// (1) automaticMail(): a message that is automatic or bulk – RFC 3834 Auto-Submitted other than "no", X-Autoreply /
//     X-Autorespond, Precedence bulk / list / junk / auto_reply, List-Id / List-Unsubscribe, a null Return-Path "<>",
//     or a sender mailer-daemon@ / postmaster@ / no-reply@ / noreply@ / do-not-reply@. The IDLE watcher (idle.ts)
//     never wakes an agent for it and search / read say so (actions.ts); the mail stays in the mailbox.
// (2) withMailRun(): apps/tools.ts adds AUTO_REPLY_ARG to a mailbox's call in a run a mail started (its origin is
//     'app:<id>' of a mailbox), so what it sends carries "Auto-Submitted: auto-replied" (mime-build.ts) and other
//     auto-responders stay silent. Agents cannot pass the argument themselves (mail schemas allow no extra keys).
// Owns: those rules. Never: refuses a send.

import { appSource } from '../../../shared/model/origin.ts';

/** The header fields automaticMail() reads (the IDLE watcher fetches only these). */
export const AUTOMATIC_HEADERS = ['AUTO-SUBMITTED', 'X-AUTOREPLY', 'X-AUTORESPOND', 'PRECEDENCE', 'LIST-ID', 'LIST-UNSUBSCRIBE', 'RETURN-PATH'];
const NO_REPLY_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)([+._-]|$)/;

/** Why a message counts as automatic or bulk ('auto-reply', 'bulk mail', …), or undefined for a person's mail. */
export function automaticMail(headers: ReadonlyMap<string, string[]>, from: string | undefined): string | undefined {
  const one = (name: string) => headers.get(name)?.[0]?.trim().toLowerCase();
  const submitted = one('auto-submitted');
  if (submitted !== undefined && submitted.split(';')[0].trim() !== 'no') return 'auto-reply';
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return 'auto-reply';
  const precedence = one('precedence');
  if (precedence === 'auto_reply') return 'auto-reply';
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return 'bulk mail';
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return 'newsletter or mailing list';
  if (one('return-path')?.replace(/\s+/g, '') === '<>') return 'delivery report';
  if (NO_REPLY_SENDER.test((from ?? '').trim().toLowerCase().split('@')[0] ?? '')) return 'no-reply sender';
  return undefined;
}

/** The argument that marks a mail call of a run a mail started (set by apps/tools.ts only). */
export const AUTO_REPLY_ARG = 'autoReplied';

/** A mailbox call's arguments: with AUTO_REPLY_ARG when the run's origin is a mailbox's new mail, else unchanged. */
export function withMailRun(
  record: { transport: string }, args: Record<string, unknown>, origin: { source: string } | undefined,
  lookup: (appId: string) => { transport: string } | undefined,
): Record<string, unknown> {
  const prefix = appSource('');
  const source = origin?.source ?? '';
  if (record.transport !== 'mail' || !source.startsWith(prefix)) return args;
  return lookup(source.slice(prefix.length))?.transport === 'mail' ? { ...args, [AUTO_REPLY_ARG]: true } : args;
}
