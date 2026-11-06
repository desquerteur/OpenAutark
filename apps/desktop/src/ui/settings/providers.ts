// Display facts about providers for the model setup: names, groups, state chip texts,
// how each official sign-in runs (Codex, Claude Code and Gemini CLI in the browser; Copilot CLI and Kimi Code in a
// terminal window) and what a plan row says and offers for a CLI the PC scan looked for (cliRowView).
// What a connection is added with (Provider list, addresses, key pages) is shared/model/providers-connect.ts.
// Owns: labels and these display rules. Never: model lists or account state (the runtime).

import { isAcpPlan, type Account, type DetectionReport, type ProviderId } from '../../shared/model/providers.ts';

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  codex: 'Codex', claude: 'Claude Code', openai: 'OpenAI API', anthropic: 'Anthropic API',
  openrouter: 'OpenRouter', google: 'Gemini API', xai: 'xAI API', deepseek: 'DeepSeek API', ollama: 'Ollama',
  lmstudio: 'LM Studio', llamacpp: 'llama.cpp', vllm: 'vLLM', compatible: 'OpenAI-compatible',
  'gemini-cli': 'Gemini CLI', copilot: 'Copilot CLI',
  'kimi-cli': 'Kimi Code', groq: 'Groq API', elevenlabs: 'ElevenLabs', fal: 'fal.ai', // B-058
  'decision-api': 'Decision API',
};

export type ProviderGroup = 'plans' | 'api' | 'local';

export function providerGroup(provider: ProviderId): ProviderGroup {
  if (provider === 'codex' || provider === 'claude' || isAcpPlan(provider)) return 'plans';
  if (provider === 'ollama' || provider === 'lmstudio' || provider === 'llamacpp' || provider === 'vllm') return 'local';
  return 'api';
}

/** 'unknown': not checked yet – the runtime checks a new or switched-on account at once (accounts/service.ts), so it reads as under way. */
export const STATE_LABELS: Record<Account['state'], string> = {
  ok: 'Connected', needs_login: 'Sign-in needed', cooling: 'Limit reached', error: 'Error', disabled: 'Off', unknown: 'Checking…',
};

/** A cooling without a used-up limit window is the short pause after an overloaded or unanswered provider. */
export const SHORT_PAUSE_LABEL = 'Paused briefly';

/** B-051 L5: the chip and the PC row of a Claude Code login on the Free plan, which runs no agents. */
export const FREE_PLAN_LABEL = 'Needs Pro or Max';
export const FREE_PLAN_ROW = 'Free plan – needs Pro or Max';

/** A Claude Code login the runtime refused for its plan (accounts: state 'error', plan 'free'). */
export function claudeFreePlan(account: Account | undefined): boolean {
  return account?.provider === 'claude' && account.state === 'error' && account.plan?.trim().toLowerCase() === 'free';
}

/** State chip text: 'Limit reached' only when a limit window is used up (its reset still ahead). */
export function stateLabel(account: Account, now = Date.now()): string {
  if (claudeFreePlan(account)) return FREE_PLAN_LABEL;
  if (account.state !== 'cooling') return STATE_LABELS[account.state];
  const usedUp = account.limits?.windows.some((window) => window.usedPercent >= 100 && (window.resetsAt === undefined || window.resetsAt > now));
  return usedUp ? STATE_LABELS.cooling : SHORT_PAUSE_LABEL;
}

/** Groups accounts by provider, keeping priority order inside each provider. */
export function groupAccounts(list: Account[]): Array<{ provider: ProviderId; accounts: Account[] }> {
  const map = new Map<ProviderId, Account[]>();
  for (const account of [...list].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)) {
    const entry = map.get(account.provider) ?? [];
    entry.push(account);
    map.set(account.provider, entry);
  }
  return [...map.entries()].map(([provider, accounts]) => ({ provider, accounts }));
}

// ------------------------------------------------------------------ sign-in and found CLIs

/** Where an official sign-in runs: the browser, or a terminal window that may stay open after it finished. */
export type SignInKind = 'browser' | 'terminal';

/** Providers whose official sign-in Workforce starts (accounts.login). */
export const SIGN_IN: Partial<Record<ProviderId, SignInKind>> = {
  codex: 'browser', claude: 'browser', 'gemini-cli': 'browser', copilot: 'terminal', 'kimi-cli': 'terminal',
};

/** Providers whose sign-out Workforce starts (accounts.logout); the ACP plan CLIs have none. */
export const SIGN_OUT: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex', 'claude']);

/** CLIs Workforce can install (accounts.install). */
export const INSTALLABLE: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex', 'claude']);

/**
 * Whether the account's official sign-in is what fixes its state: 'Sign-in needed', and for an ACP
 * plan that signs in in a terminal (Copilot CLI) also 'Error' – it may answer a missing sign-in with
 * another error, so adding it opens its window then too (runtime accounts/acp-plans.ts).
 */
export function needsSignIn(account: Pick<Account, 'provider' | 'auth' | 'state'>): boolean {
  const kind = account.auth === 'cli' ? SIGN_IN[account.provider] : undefined;
  return kind !== undefined && (account.state === 'needs_login' || (account.state === 'error' && kind === 'terminal' && isAcpPlan(account.provider)));
}

/** The toast text once a sign-in started. */
export function signInHint(provider: ProviderId | undefined): string {
  if (provider === 'copilot') return 'In the terminal window that opened, type /login and follow the steps, then come back here.';
  return provider && SIGN_IN[provider] === 'terminal' ? 'Finish sign-in in the terminal window that opened, then come back here.' : 'Finish it in the window that opened.';
}

/** The plan CLIs the PC scan looks for, in the order the model setup lists them. */
export const PC_CLIS: ReadonlyArray<DetectionReport['clis'][number]['provider']> = ['claude', 'codex', 'kimi-cli', 'gemini-cli', 'copilot'];

export interface CliRowView {
  name: string;
  hint: string;
  /** 'add': accounts.add, which checks the account first and starts its sign-in only when it needs one; 'check': scan again. */
  action?: 'install' | 'sign-in' | 'add' | 'add-again' | 'check';
  /** The account of the CLI's default home, when there is one. */
  account?: Account;
}

/**
 * One "On this PC" row for a CLI the scan looked for: its name, what it says and the one action it
 * offers. The account of the CLI's default home (detected, or an ACP plan added here) wins over the
 * scan's sign-in state (a sign-in finished since the last scan). A missing CLI says 'Not installed'
 * (Install only where Workforce can install it – B-044: every CLI keeps its row, so a rescan never
 * inserts one). An installed ACP plan CLI whose sign-in the scan could not tell (a
 * slow first start, an unexpected answer) offers 'add': this row is its only way in (Add account
 * has no form for it). An installed Codex or Claude Code whose status command did not answer
 * (runtime detect.ts loginUnknown) says so and offers 'check' (a new scan).
 */
export function cliRowView(cli: DetectionReport['clis'][number], accounts: readonly Account[]): CliRowView {
  const provider = cli.provider as ProviderId;
  const name = PROVIDER_NAMES[provider] ?? cli.provider;
  const installed = Boolean(cli.path);
  const account = accounts.find((entry) => entry.provider === provider && entry.auth === 'cli' && entry.home === undefined);
  const loggedIn = account?.state === 'needs_login' ? false : account?.state === 'ok' || account?.state === 'cooling' ? true : cli.loggedIn;
  const signIn = SIGN_IN[provider] !== undefined;
  const dismissed = cli.dismissed === true && !account && loggedIn === true && signIn; // removed by the person
  const unknown = installed && loggedIn === undefined && (provider === 'codex' || provider === 'claude');
  const state = !installed ? 'Not installed' : claudeFreePlan(account) ? FREE_PLAN_ROW
    : loggedIn ? `Signed in${cli.method ? ` · ${cli.method}` : ''}${dismissed ? ' · not used by Autark' : ''}`
      : loggedIn === false ? 'Not signed in' : unknown ? 'Installed · sign-in unknown' : 'Installed';
  const action = !installed ? (INSTALLABLE.has(provider) ? 'install' : undefined) : loggedIn === false && signIn ? 'sign-in' : dismissed ? 'add-again'
    : loggedIn === undefined && !account && isAcpPlan(provider) ? 'add' : unknown ? 'check' : undefined;
  return { name, hint: [state, cli.version].filter(Boolean).join(' · '), action, account };
}
