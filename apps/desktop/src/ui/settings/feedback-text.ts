// The words of Settings › Feedback and of the About page's restore line, pure: what happens to a report here, a report's line,
// whether a report can still be sent, what the last start did with a restore.
// Owns: these texts. Never: RPC or rendering.

import type { RestoreStatus } from '../../shared/model/restore.ts';
import type { FeedbackReport } from '../../shared/model/system.ts';
import { fullDate, listTime } from '../lib/format.ts';

const KIND: Readonly<Record<FeedbackReport['kind'], string>> = { bug: 'Bug', idea: 'Idea', change: 'Change', praise: 'Praise' };
/** Keeps a hint line's height while its text is unknown. */
const HOLD = ' ';

/** What happens to a report here, in one line (undefined: not known yet). */
export function reportsHint(sending: boolean | undefined, where = 'this PC'): string {
  if (sending === undefined) return HOLD;
  return sending ? `Reports are encrypted on ${where}. Only the Teydra team can read them.` : `Sending is not set up in this version. Reports are saved on ${where}.`;
}

/** A report's line: kind, who, how often, state, time. */
export function reportLine(report: Pick<FeedbackReport, 'kind' | 'author' | 'status' | 'sentAt' | 'createdAt' | 'count' | 'deliveryWarning' | 'url'>, who: (id: string) => string, when: (at: number) => string = listTime, where = 'this PC'): string {
  const state = report.status === 'sent' ? (report.url ? 'Published on GitHub' : report.deliveryWarning ? 'Sent to the team without the screenshot' : 'Sent to the team')
    : report.status === 'received' ? 'Received earlier' : report.status === 'local' || report.status === 'draft' ? `Saved on ${where}` : '';
  return [
    KIND[report.kind], report.author === 'human' ? '' : `${who(report.author)} · Unverified`, report.count && report.count > 1 ? `Reported ${report.count} times` : '',
    state, when(report.sentAt ?? report.createdAt),
  ].filter(Boolean).join(' · ');
}

/** Send is offered for a report that was not delivered, where this build can send. */
export const sendable = (report: Pick<FeedbackReport, 'status' | 'receiptId'>, sending: boolean | undefined): boolean => sending === true && (report.status === 'local' || report.status === 'draft') && !report.receiptId;

/** What the last start did with a restore, in one line. */
export function lastRestoreText(last: NonNullable<RestoreStatus['last']>, when: (at: number) => string = fullDate): string {
  if (!last.ok) return `Last restore was not applied (${when(last.at)}): ${last.error ?? 'the data stayed as it was'}`;
  const again = last.reentry ? [
    last.reentry.accounts ? `${last.reentry.accounts} sign-in${last.reentry.accounts === 1 ? '' : 's'}` : '',
    last.reentry.secrets ? `${last.reentry.secrets} secret${last.reentry.secrets === 1 ? '' : 's'}` : '',
    last.reentry.devices ? `${last.reentry.devices} link${last.reentry.devices === 1 ? '' : 's'} to pair` : '',
    last.reentry.homes ? `${last.reentry.homes} home project${last.reentry.homes === 1 ? '' : 's'}` : '',
  ].filter(Boolean) : [];
  return `Restored ${when(last.at)} from ${last.from}${again.length ? ` · to set up again: ${again.join(', ')}` : ''}`;
}
