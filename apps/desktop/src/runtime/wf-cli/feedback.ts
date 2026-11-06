// `wf feedback` (B-055 Q3) on the team's PC:
//   wf feedback setup --project <id> --api-key <key> --service-account <file.json> [--rotate]
//       the team key (made unless the vault has one; --rotate: a new one) and the service account into this PC's
//       vault, resources/feedback/receiver.json, then the Firestore rules to paste and the next steps;
//   wf feedback receive   fetch the mailbox now (opened, stored on this PC, deleted in the mailbox);
//   wf feedback status    whether this build sends and whether this PC receives.
// The runtime reads the key file itself (feedback.setup, owner only) – it is passed as an absolute path.
// Owns: what these three call and print. Never: prints a private key or the service account (the runtime never returns them).

import path from 'node:path';
import type { FeedbackInboxFetch, FeedbackInboxItem, FeedbackSetupResult, FeedbackStatus } from '../../shared/model/feedback-delivery.ts';
import { flag, text, type Parsed } from './args.ts';
import type { Command } from './commands.ts';
import { CliError } from './errors.ts';

const SETUP_OPTIONS = ['project', 'api-key', 'service-account'] as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function check(parsed: Parsed): void {
  const sub = parsed.args[0];
  if (sub !== 'setup' && sub !== 'receive' && sub !== 'status') throw new CliError('bad_request', 'Use wf feedback setup, wf feedback receive or wf feedback status.');
  if (sub === 'setup') {
    for (const name of SETUP_OPTIONS) if (!text(parsed, name)?.trim()) throw new CliError('bad_request', `wf feedback setup needs --${name}.`);
    return;
  }
  for (const name of [...SETUP_OPTIONS, 'rotate']) if (parsed.options.has(name)) throw new CliError('bad_request', `--${name} belongs to wf feedback setup.`);
}

function setupLines(result: FeedbackSetupResult, accountFile: string): string[] {
  const lines = [
    result.createdKey ? `New team key made. Public key: ${result.publicKey}` : `Kept the team key from this PC's vault. Public key: ${result.publicKey}`,
    `The private key and the service account are in this PC's vault ("Feedback team key", "Feedback mailbox service account"); no agent can use them.`,
  ];
  if (result.receiverFile) lines.push(`Wrote ${result.receiverFile}`);
  else lines.push('This app runs from a package, so receiver.json was not written. Save this as resources/feedback/receiver.json in the source tree:', JSON.stringify(result.receiver, null, 2));
  lines.push('', 'Next steps:',
    '1. Firebase console › Firestore Database › Rules: replace the rules with these and press Publish:', '',
    result.rules.trim() || '(resources/feedback/firestore.rules was not found)', '',
    '2. Build the app (npm run build, or npm run package for an installer): receiver.json ships with it, and reports from that build are sealed for this key.',
    `3. You may delete ${accountFile} now – the vault keeps a copy.`,
    '4. wf feedback receive fetches new reports; the feedback menu › Inbox does it when it opens.');
  if (!result.createdKey) lines.push('', 'To make a new key pair, run setup again with --rotate (letters sealed for the old key cannot be opened afterwards).');
  return lines;
}

function receiveLine(result: FeedbackInboxFetch): string {
  let line = `Fetched ${plural(result.added, 'new report')}; ${plural(result.total, 'report')} in the inbox on this PC.`;
  if (result.unreadable) line += ` ${plural(result.unreadable, 'letter')} could not be opened with this PC's key.`;
  if (result.more) line += ' More are waiting – run wf feedback receive again.';
  return line;
}

export const feedbackCommand: Command = {
  usage: 'feedback setup --project <id> --api-key <key> --service-account <file.json> [--rotate] | feedback receive | feedback status',
  summary: 'The team\'s feedback mailbox: setup stores the team key and service account on this PC and writes resources/feedback/receiver.json; receive fetches new reports now; status says whether this build sends and this PC receives.',
  options: [...SETUP_OPTIONS, 'rotate'],
  arity: [1, 1],
  check,
  async run(ctx) {
    check(ctx.parsed);
    const sub = ctx.parsed.args[0];
    if (sub === 'setup') {
      const accountFile = path.resolve(text(ctx.parsed, 'service-account')!);
      const result = await ctx.rpc.call('feedback.setup', {
        project: text(ctx.parsed, 'project')!.trim(), apiKey: text(ctx.parsed, 'api-key')!.trim(), serviceAccountPath: accountFile,
        ...(flag(ctx.parsed, 'rotate') ? { rotate: true } : {}),
      }) as FeedbackSetupResult;
      if (ctx.json) ctx.out.json(result);
      else ctx.out.lines(setupLines(result, accountFile));
      return;
    }
    if (sub === 'receive') {
      const result = await ctx.rpc.call('feedback.inboxFetch') as FeedbackInboxFetch;
      if (ctx.json) ctx.out.json(result);
      else ctx.out.line(receiveLine(result));
      return;
    }
    const status = await ctx.rpc.call('feedback.status') as FeedbackStatus;
    const inbox = status.receiving ? (await ctx.rpc.call('feedback.inboxList') as FeedbackInboxItem[]).length : undefined;
    if (ctx.json) { ctx.out.json({ ...status, ...(inbox !== undefined ? { inbox } : {}) }); return; }
    ctx.out.lines([
      status.sending ? 'Sending: set up – reports are sealed for the team and dropped into the mailbox.' : 'Sending: not set up in this build – reports stay on the PC (no resources/feedback/receiver.json).',
      inbox !== undefined ? `Receiving: this PC holds the team key – ${plural(inbox, 'report')} in its inbox.` : 'Receiving: no – this PC has no team key (wf feedback setup).',
    ]);
  },
};
