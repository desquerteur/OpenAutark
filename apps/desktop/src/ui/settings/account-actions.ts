// What the account rows and the model setup share: starting an official sign-in and following a terminal sign-in or
// sign-out until it shows (re-checked whenever this window gets focus again, at most 30 min, then a toast), and what
// fixes or removes an account. A Codex or Claude Code sign-in opens the browser itself.
// Owns: these flows and texts. Never: reads or shows tokens, or decides account state (the runtime does).

import type { Account, ProviderId } from '../../shared/model/providers.ts';
import { openExternal } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { accounts } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { act } from './controls.tsx';
import { SIGN_IN, signInHint } from './providers.ts';

const RECHECK_FOR_MS = 30 * 60_000;

/** Sign-ins and -outs in a terminal window, which may stay open after they finished. */
export const inTerminal = (provider: ProviderId | undefined) => provider !== undefined && SIGN_IN[provider] === 'terminal';

/** What fixes a 'Sign-in needed' account that has no official sign-in (API key, environment key, server). */
export function repairText(account: Account): string {
  if (account.auth === 'env') return `The key in ${account.envVar} is missing or was rejected – set a valid key and restart Autark, or remove this connection`;
  return account.auth === 'local' ? 'The server rejected this connection – fix its access settings, then remove it and add it again'
    : 'The key is missing or was rejected – remove this connection and add it again with a valid key';
}

/** What removing an account does (the confirm text). */
export function removeText(account: Account): string {
  if (account.home) return 'Autark stops using this account and deletes its separate sign-in profile on this PC.';
  if (account.auth === 'env') return `Autark stops using the key in ${account.envVar}; the variable itself stays as it is.`;
  if (account.secretId?.startsWith('secret://')) return 'Autark stops using this connection; its key stays in Settings › Secrets.';
  if (account.auth === 'api_key') return 'Autark deletes the stored key and stops using this connection.';
  const kept = account.auth === 'cli' ? 'The sign-in stays with the official client' : 'The server keeps running';
  return account.detected ? `${kept}; Autark stops using it until you add it again under Settings › Models.` : `${kept}; Autark stops using this account.`;
}

const findAccount = (id: string) => accounts.value.find((account) => account.id === id);
const watching = new Map<string, () => void>();

/**
 * After a terminal sign-in or sign-out: whenever this window gets focus again, detection re-checks
 * the account (the runtime checks its open terminal sign-ins first) until the change shows – then a
 * toast – or 30 min passed.
 */
export function recheckOnFocus(id: string, goal: 'in' | 'out'): void {
  watching.get(id)?.();
  const since = Date.now();
  let checking = false;
  const reached = (account: Account) => (goal === 'in' ? account.state === 'ok' || account.state === 'cooling' : account.state === 'needs_login');
  const stop = () => { window.removeEventListener('focus', onFocus); if (watching.get(id) === stop) watching.delete(id); };
  const onFocus = () => void (async () => {
    const before = findAccount(id);
    if (checking) return;
    if (!before || before.state === 'disabled' || Date.now() - since > RECHECK_FOR_MS) return stop();
    checking = true;
    try { if (!reached(before)) await rpc.call('accounts.detect'); } catch { /* the next focus tries again */ } finally { checking = false; }
    const after = findAccount(id);
    if (after && reached(after)) { stop(); pushToast({ title: `${after.label} ${goal === 'in' ? 'signed in' : 'signed out'}` }); }
  })();
  watching.set(id, stop);
  window.addEventListener('focus', onFocus);
}

/** The toast after a sign-in started and, for a terminal sign-in, the re-check on focus. */
export function signInStarted(id: string, provider: ProviderId | undefined): void {
  pushToast({ title: 'Sign-in started', body: signInHint(provider) });
  if (inTerminal(provider)) recheckOnFocus(id, 'in');
}

/** B-051 L4: CLIs whose headless sign-in opens the browser itself (runtime accounts/sign-in.ts) – the page they printed is a link to offer, never a second tab. */
const OPENS_OWN_BROWSER: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex', 'claude']);

/** Starts the official sign-in for an existing account; opens a returned URL the CLI does not open itself, and returns the result. */
export async function startLogin(id: string, provider = findAccount(id)?.provider): Promise<{ started: boolean; url?: string } | undefined> {
  const result = await act(() => rpc.call('accounts.login', { id }), 'Could not start sign-in');
  if (result?.url && !(provider && OPENS_OWN_BROWSER.has(provider))) openExternal(result.url);
  if (result?.started) signInStarted(id, provider);
  return result;
}
