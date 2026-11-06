// accounts.sign_in (B-047 D10): an agent starts the official sign-in of a signed-out model account itself –
// AccountService.login (accounts/sign-in.ts: the provider's own CLI login under the account's home, which opens
// the sign-in page in this PC's default browser, or a terminal window for CLIs that sign in there). The account
// is checked when the sign-in process ends; accounts/relogin.ts closes the sign-in task once it works.
// Category 'account'. Offered where the mode's tools
// allow it (the '*' modes: manager, general, secretary) and with computer.act (tools/registry.ts COMPANION_TOOLS:
// the computer-mode agent relogin.ts falls back to when there is no Manager).
// Owns: choosing the account (by id, or the one that needs a sign-in) and the answer text.
// Never: reads or returns tokens, CLI homes or e-mails, types a password, or signs out.

import type { Account } from '../../../shared/model/providers.ts';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { defineTool } from './util.ts';
import { cleanLabel } from '../../context/setup-facts.ts';

type SignInArgs = { accountId?: string };

const label = (account: Account) => cleanLabel(account.label, account.email);
const needsSignIn = (account: Account) => account.enabled !== false && account.state === 'needs_login';

/** The account the call means: the named one, else the only one that needs a sign-in; a string is the problem. */
export function pickAccount(accounts: readonly Account[], accountId?: string): Account | string {
  if (accountId) {
    const found = accounts.find((account) => account.id === accountId);
    if (!found) return `No account "${accountId}". Accounts needing a sign-in: ${list(accounts) || 'none'}.`;
    if (found.enabled === false) return `${label(found)} is switched off; the person switches it on in Settings › Models.`;
    return found;
  }
  const waiting = accounts.filter(needsSignIn);
  if (!waiting.length) return 'No account needs a sign-in right now.';
  if (waiting.length > 1) return `Several accounts need a sign-in – name one with accountId: ${list(accounts)}.`;
  return waiting[0];
}

function list(accounts: readonly Account[]): string {
  return accounts.filter(needsSignIn).map((account) => `${account.id} (${label(account)}, ${account.provider})`).join('; ');
}

function chosen(ctx: ToolContext, args: SignInArgs): Account | undefined {
  try { const pick = pickAccount(ctx.services.accounts.list(), args.accountId); return typeof pick === 'string' ? undefined : pick; } catch { return undefined; }
}

const signIn = defineTool<SignInArgs>({
  name: 'accounts.sign_in',
  description: 'Start the official sign-in of a signed-out model account (e.g. a Codex or Claude Code plan) on this PC. It opens the provider\'s sign-in page in this PC\'s default browser (some CLIs open a terminal window); finish it there with screen tools. I type no password: a password or 2FA code becomes a short to-do for the person. Without accountId: the one account that needs a sign-in.',
  inputSchema: {
    type: 'object',
    properties: { accountId: { type: 'string', minLength: 1, maxLength: 80, description: 'the account id (the "Accounts needing sign-in" line, app.status)' } },
    additionalProperties: false,
  },
  category: 'account',
  describe: (args, ctx) => {
    const account = chosen(ctx, args);
    return { summary: account ? `Start the sign-in to ${label(account)}` : 'Start an account sign-in', resource: account?.provider ?? 'accounts', reversible: true, external: false };
  },
  async run(args, ctx) {
    const pick = pickAccount(ctx.services.accounts.list(), args.accountId);
    if (typeof pick === 'string') return failure(pick);
    if (pick.state !== 'needs_login' && pick.state !== 'error') return text(`${label(pick)} is signed in already (state ${pick.state}); nothing to do.`);
    let started: { started: boolean; url?: string };
    try {
      started = await ctx.services.accounts.login(pick.id);
    } catch (error) {
      return failure(`The sign-in of ${label(pick)} could not start: ${(error as Error).message.slice(0, 200)}`);
    }
    if (!started.started) {
      return failure(`${label(pick)} (${pick.provider}) has no sign-in this app can start. The person signs in in Settings › Models – I prepare that as a short to-do (human.ask, humanReason credential).`);
    }
    return text([
      `Started the official ${pick.provider} sign-in for ${label(pick)} on this PC.`,
      started.url ? `Sign-in page: ${started.url}` : 'It opens the sign-in page in this PC\'s default browser (or a terminal window for CLIs that sign in there).',
      'I finish it there with my screen tools or a colleague in browser or computer mode; I type no password – a password or 2FA code becomes a prepared to-do for the person.',
      'The account is checked automatically when the sign-in ends (within 5 minutes); its sign-in task closes itself once it works.',
    ].join('\n'));
  },
});

export const accountTools: ToolDef[] = [signIn];
