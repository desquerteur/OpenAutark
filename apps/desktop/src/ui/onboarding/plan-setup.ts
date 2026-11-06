// The model setup's two plan buttons (plan-actions.tsx) each add an account and start its official sign-in.
// Install a missing CLI first, then accounts.add creates a separate sign-in profile. Existing accounts stay as
// they are. Wait for this account's sign-in through events and a re-check on window focus (one 5-minute timer,
// no polling), then report that it signed in. No model turn is sent, even when another account already works.
// A newer flow cancels the running one: it stops at its next step and shows nothing.
// Owns: this flow, its steps and texts. Never: renders, writes settings, reads or logs a token or the sign-in address.

import type { Account, DetectionReport } from '../../shared/model/providers.ts';

export type PlanProvider = 'codex' | 'claude';

/** The two buttons, in this order. */
export const PLAN_PROVIDERS: readonly PlanProvider[] = ['claude', 'codex'];
export const PLAN_LABELS: Record<PlanProvider, string> = { claude: 'Claude plan', codex: 'Codex plan' };
/** The program that is installed. */
const CLI: Record<PlanProvider, string> = { codex: 'Codex', claude: 'Claude Code' };

/** How long step 3 waits for the browser sign-in. */
export const SIGN_IN_WAIT_MS = 5 * 60_000;
export const SIGN_IN_TEXT = 'Finish signing in in your browser…';
export const SIGN_IN_GAVE_UP = 'Sign-in did not finish – try again.';

export type PlanStep = 'install' | 'sign-in' | 'done';

/** What the card shows now: the status line (with its tone) and the link cell's address. */
export interface PlanView { provider: PlanProvider; step: PlanStep; text: string; tone?: 'ok' | 'error'; url?: string }

export type PlanResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'install' | 'sign-in' | 'cancelled'; message: string };

/** The runtime calls the flow makes (plan-actions.tsx wires them to rpc.call). */
export interface PlanRpc {
  install(provider: PlanProvider): Promise<unknown>;
  add(provider: PlanProvider): Promise<Account & { signInUrl?: string }>;
  /** accounts.detect: the runtime checks the open sign-ins again (events bring the change). */
  recheck(): Promise<unknown>;
}

export interface PlanEnv {
  rpc: PlanRpc;
  /** The accounts as the runtime's events keep them (lib/store.ts accounts). */
  accounts: { peek(): readonly Account[]; subscribe(fn: (value: readonly Account[]) => void): () => void };
  /** The latest PC scan (null: none yet – step 1 is left to the runtime's add). */
  report: () => DetectionReport | null;
  /** One timer: calls `fire` after `ms`; returns its cancel. */
  timer: (ms: number, fire: () => void) => () => void;
  /** Calls `fire` whenever the window gets focus again; returns the stop. */
  focus: (fire: () => void) => () => void;
  /** Every step as it starts, and the end (never after a cancel). */
  show: (view: PlanView) => void;
}

export interface PlanFlow { done: Promise<PlanResult>; cancel(): void }

const WORKS: ReadonlySet<Account['state']> = new Set(['ok', 'cooling']);
const CANCELLED: PlanResult = { ok: false, reason: 'cancelled', message: '' };

/** Authentication finished, including Claude Free (signed in even though its plan cannot run agents). */
const settled = (account: Account) => WORKS.has(account.state) || (account.state === 'error' && account.plan?.trim().toLowerCase() === 'free');

/** The scan lists this CLI and found no program: it is missing (no entry: not known – demo, an old report). */
export function cliMissing(report: DetectionReport | null, provider: PlanProvider): boolean {
  const cli = report?.clis.find((entry) => entry.provider === provider);
  return cli !== undefined && !cli.path;
}

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Starts the flow for `provider`; `cancel()` stops it at its next step (the card starts another or closes). */
export function startPlanSetup(provider: PlanProvider, env: PlanEnv): PlanFlow {
  let cancelled = false;
  let abortWait: (() => void) | undefined;
  const show = (view: Omit<PlanView, 'provider'>) => { if (!cancelled) env.show({ provider, ...view }); };
  const fail = (step: PlanStep, reason: Exclude<PlanResult, { ok: true }>['reason'], message: string, url?: string): PlanResult => {
    show({ step, text: message, tone: 'error', url });
    return { ok: false, reason, message };
  };

  /** Step 3: resolves with the account once it is settled (works, or the Free plan), 'gone' when it was removed, else 'timeout' / 'cancelled'. */
  const waitSignedIn = (id: string) => new Promise<Account | 'timeout' | 'gone' | 'cancelled'>((resolve) => {
    let done = false;
    let seen = false;
    const stops: Array<() => void> = [];
    const finish = (value: Account | 'timeout' | 'gone' | 'cancelled') => {
      if (done) return;
      done = true;
      abortWait = undefined;
      for (const stop of stops.splice(0)) stop();
      resolve(value);
    };
    abortWait = () => finish('cancelled');
    stops.push(env.timer(SIGN_IN_WAIT_MS, () => finish('timeout')));
    stops.push(env.focus(() => { void env.rpc.recheck().catch(() => undefined); }));
    const off = env.accounts.subscribe((list) => {
      const account = list.find((entry) => entry.id === id);
      if (!account) { if (seen) finish('gone'); return; }
      seen = true;
      if (settled(account)) finish(account);
    });
    if (done) off(); else stops.push(off);
  });

  /** Add an account and wait only for its sign-in, regardless of any existing accounts. */
  const signIn = async (): Promise<Account | PlanResult> => {
    let account: Account;
    let url: string | undefined;
    show({ step: 'sign-in', text: SIGN_IN_TEXT });
    try {
      const { signInUrl, ...rest } = await env.rpc.add(provider);
      account = rest;
      url = signInUrl;
    } catch (error) { return cancelled ? CANCELLED : fail('sign-in', 'sign-in', messageOf(error, 'Could not start the sign-in – try again.')); }
    if (cancelled) return CANCELLED;
    // the account as the signal holds it now (an event may have brought its sign-in already)
    const fresh = env.accounts.peek().find((entry) => entry.id === account.id) ?? account;
    if (settled(fresh)) return fresh;
    show({ step: 'sign-in', text: SIGN_IN_TEXT, url });
    // 3. the browser
    const waited = await waitSignedIn(fresh.id);
    if (waited === 'cancelled' || cancelled) return CANCELLED;
    if (waited === 'timeout') return fail('sign-in', 'sign-in', SIGN_IN_GAVE_UP);
    if (waited === 'gone') return fail('sign-in', 'sign-in', 'The sign-in was removed – try again.');
    return waited;
  };

  const isEnd = (value: Account | PlanResult): value is PlanResult => 'ok' in value;

  const run = async (): Promise<PlanResult> => {
    // 1. the program
    if (cliMissing(env.report(), provider)) {
      show({ step: 'install', text: `Installing ${CLI[provider]} – this takes about a minute…` });
      try { await env.rpc.install(provider); } catch (error) { return cancelled ? CANCELLED : fail('install', 'install', messageOf(error, `Could not install ${CLI[provider]}.`)); }
      if (cancelled) return CANCELLED;
    }
    const account = await signIn();
    if (cancelled) return CANCELLED;
    if (isEnd(account)) return account;
    show({ step: 'done', text: `${provider === 'codex' ? 'Codex' : 'Claude'} account signed in`, tone: 'ok' });
    return { ok: true, accountId: account.id };
  };

  return {
    done: run(),
    cancel() { cancelled = true; abortWait?.(); },
  };
}
