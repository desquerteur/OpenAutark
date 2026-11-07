// One connection (plan, API key, local server): its name and state chip, one hint line (provider, plan, e-mail,
// address, key source, when a paused plan is back, how many models it lists), the two limit bars of a Codex or Claude
// Code plan, its models when shown, one fixed action slot (Sign in while it needs it, else Codex "Use reset (N)", else
// empty) and a right-click menu: Rename (B-078), Show models, Sign in / Sign out, Move up / down among accounts of one provider, Add
// another account (a plan with its own sign-in profile), Enable / Disable, Claude Code's Delete histories, Remove.
// B-072: no plan roles or rotation switch here – the order decides, and rotation stays an account field the AI sets on
// request (accounts.update, skill ai-providers).
// AF-009: the account's picture before its name (lib/account-avatar.tsx: the provider's logo, else its avatar, else its
// initials) and its kind in the hint ("Max subscription", "API key", "Local server", lib/account-face.ts kindText).
// Owns: the row. Never: shows tokens or invents limits (unknown = '–').

import '../../shared/api/methods-provider-history.ts'; // privacy.purgeProviderHistory (module augmentation)
import { useState } from 'preact/hooks';
import type { Account, ModelInfo } from '../../shared/model/providers.ts';
import { isPlanProvider } from '../../shared/model/plan-roles.ts';
import { askText, confirm } from '../lib/dialog.tsx';
import { limitSlots, nextCredit, otherWindows, PLAN_SLOTS, resetButtonLabel, resetClock, resetConfirmText, resetCount, resetExpiryText, resetOutcomeText } from '../lib/limits.ts';
import type { MenuItem, MenuSection } from '../lib/popover.tsx';
import { rpc } from '../lib/rpc.ts';
import { models } from '../lib/store.ts';
import { shortModelName } from '../chat/live-text.ts';
import { serviceOfAccount } from '../../shared/model/providers-connect.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { act, ActionButton, Row, useBusy } from './controls.tsx';
import { inTerminal, recheckOnFocus, removeText, repairText, signInStarted, startLogin } from './account-actions.ts';
import { needsSignIn, PROVIDER_NAMES, SIGN_IN, SIGN_OUT, stateLabel } from './providers.ts';
import { AccountAvatar } from '../lib/account-avatar.tsx';
import { kindText } from '../lib/account-face.ts';

/** The plans accounts.add gives another sign-in profile (cli-homes.ts); the login found on this PC is one of them too. Gemini CLI and Copilot CLI have one per PC. */
const OWN_HOMES: ReadonlySet<string> = new Set(['codex', 'claude', 'kimi-cli']);

/** The two fixed bars of a plan (5-hour limit, Weekly); other windows in the tooltip. */
function LimitBars(props: { account: Account }) {
  const now = Date.now();
  const limits = props.account.limits;
  const title = [limits?.stale ? 'Last reading may be outdated' : undefined, ...otherWindows(limits, now)].filter(Boolean).join('\n') || undefined;
  return (
    <div class="account-limits" title={title}>
      {limitSlots(limits, now).map((slot) => (
        <div key={slot.name} class="account-limit" data-window={slot.name}>
          <span class="account-limit-line tabular">{slot.line}</span>
          <span class="usage-bar"><span style={{ width: `${slot.left ?? 0}%` }} /></span>
        </div>
      ))}
    </div>
  );
}

/** Codex: "Use reset (N)" while a reset is banked; the person confirms, the provider answers. */
function ResetButton(props: { account: Account }) {
  const { account } = props;
  const [busy, setBusy] = useState(false);
  const resets = account.limits?.resets;
  const use = async () => {
    const credit = nextCredit(resets, Date.now());
    if (!(await confirm({ title: `Use a reset for ${account.label}?`, body: resetConfirmText(resets, Date.now()), confirmLabel: 'Use reset' }))) return;
    setBusy(true);
    try {
      const result = await act(() => rpc.call('accounts.useReset', { id: account.id, ...(credit ? { creditId: credit.id } : {}) }), 'Could not use the reset');
      if (result) {
        const text = resetOutcomeText(result.outcome);
        pushToast({ title: text.title, body: text.body, ...(text.ok ? {} : { tone: 'error' as const }) });
      }
    } finally { setBusy(false); }
  };
  return (
    <Button variant="secondary" class="small account-reset" busy={busy} disabled={!account.enabled}
      title={resetExpiryText(nextCredit(resets, Date.now()))} onClick={() => void use()}>{resetButtonLabel(resets)}</Button>
  );
}

/** The models a connection lists (the catalog's), by name. */
export function modelsOf(account: Pick<Account, 'id'>, list: readonly ModelInfo[]): ModelInfo[] {
  return list.filter((model) => model.accounts.includes(account.id)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** The hint line: what the account is and why it waits, with its provider's name where the label does not say it. */
function hintOf(account: Account, repair: string | undefined, count: number): string {
  const cli = account.auth === 'cli';
  const plan = cli && isPlanProvider(account.provider);
  const providerName = serviceOfAccount(account)?.name ?? PROVIDER_NAMES[account.provider] ?? account.provider;
  const now = Date.now();
  // a plan whose bars already show the used-up window with its reset time does not say it again
  const barsSayWhen = plan && account.limits?.windows.some((window) => PLAN_SLOTS.includes(window.name) && window.usedPercent >= 100 && (window.resetsAt ?? 0) > now);
  return [
    account.label.toLocaleLowerCase().includes(providerName.toLocaleLowerCase()) ? undefined : providerName,
    repair, kindText(account), account.email, account.baseUrl && !cli ? account.baseUrl : undefined,
    account.auth === 'env' && !repair ? `Key from ${account.envVar}` : undefined, account.detected ? 'found on this PC' : undefined,
    account.state === 'cooling' && account.coolingUntil && !barsSayWhen ? `Available again ${resetClock(account.coolingUntil, now)}` : undefined,
    count ? `${count} model${count === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean).join(' · ');
}

/** `siblings`: the same provider's accounts in priority order (Move up / down). */
export function AccountRow(props: { account: Account; siblings: readonly Account[] }) {
  const { account, siblings } = props;
  const [busy, run] = useBusy();
  const [showModels, setShowModels] = useState(false);
  const listed = modelsOf(account, models.value);
  const update = (patch: { enabled?: boolean }) => void run(() => rpc.call('accounts.update', { id: account.id, ...patch }));
  const index = siblings.indexOf(account);
  // swap priorities with the neighbour so the order is explicit and stable
  const move = (dir: -1 | 1) => {
    const other = siblings[index + dir];
    if (!other) return;
    void run(async () => {
      await rpc.call('accounts.update', { id: account.id, priority: other.priority === account.priority ? other.priority + dir : other.priority });
      await rpc.call('accounts.update', { id: other.id, priority: account.priority });
    });
  };
  const remove = async () => {
    if (await confirm({ title: `Remove ${account.label}?`, body: removeText(account), confirmLabel: 'Remove', danger: true })) await run(() => rpc.call('accounts.remove', { id: account.id }));
  };
  // B-078: the name the rail and this card show; empty gives the provider's name back (the rail then names the plan by its e-mail)
  const rename = async () => {
    const next = await askText({ title: 'Rename', label: 'Name', value: account.label, confirmLabel: 'Rename' });
    if (next === null) return;
    const label = next.trim() || PROVIDER_NAMES[account.provider] || account.provider;
    if (label !== account.label) await run(() => rpc.call('accounts.update', { id: account.id, label }));
  };
  const signOut = () => void run(async () => {
    await rpc.call('accounts.logout', { id: account.id });
    if (!inTerminal(account.provider)) return;
    pushToast({ title: 'Sign-out started', body: 'Finish it in the terminal window that opened, then come back here.' });
    recheckOnFocus(account.id, 'out');
  });
  // one more plan of this provider, with its own sign-in profile; Move up / down sets which runs first
  const addAnother = () => void run(async () => {
    const added = await rpc.call('accounts.add', { provider: account.provider });
    if (needsSignIn(added)) signInStarted(added.id, added.provider);
  });
  const purge = async () => {
    const ok = await confirm({
      title: `Delete Claude Code histories of ${account.label}?`,
      body: 'Claude Code deletes every stored session of this account. Chats on this account start fresh sessions with their recent messages. This cannot be undone.',
      confirmLabel: 'Delete histories', danger: true,
    });
    if (!ok) return;
    const result = await run(() => rpc.call('privacy.purgeProviderHistory', { accountId: account.id, confirm: true }));
    if (result) pushToast({ title: result.purged ? 'Claude Code histories deleted' : (result.message ?? 'Nothing to delete') });
  };
  const cli = account.auth === 'cli';
  const signIn = cli && SIGN_IN[account.provider] !== undefined;
  const plan = cli && isPlanProvider(account.provider);
  const repair = account.state === 'needs_login' && !signIn ? repairText(account) : undefined;
  const hint = hintOf(account, repair, listed.length);
  const menu = (): MenuSection[] => {
    const order: MenuItem[] = [];
    if (siblings.length > 1) order.push({ label: 'Move up', disabled: index <= 0, onSelect: () => move(-1) }, { label: 'Move down', disabled: index >= siblings.length - 1, onSelect: () => move(1) });
    const actions: MenuItem[] = [
      { label: 'Rename', onSelect: () => void rename() },
      { label: showModels ? 'Hide models' : 'Show models', disabled: !listed.length, onSelect: () => setShowModels(!showModels) },
    ];
    if (cli && OWN_HOMES.has(account.provider)) actions.push({ label: 'Add another account', onSelect: addAnother });
    if (signIn) actions.push({ label: 'Sign in', onSelect: () => void startLogin(account.id) });
    if (cli && SIGN_OUT.has(account.provider)) actions.push({ label: 'Sign out', disabled: account.state === 'needs_login', onSelect: signOut });
    actions.push({ label: account.enabled ? 'Disable' : 'Enable', onSelect: () => update({ enabled: !account.enabled }) });
    const danger: MenuItem[] = [];
    if (account.provider === 'claude' && account.home) danger.push({ label: 'Delete histories', danger: true, onSelect: () => void purge() });
    danger.push({ label: 'Remove', danger: true, onSelect: () => void remove() });
    return [{ items: order }, { items: actions }, { items: danger }];
  };
  return (
    <Row
      class={`account-row provider-${account.provider}${plan ? ' plan' : ''}`} menu={menu}
      label={<><AccountAvatar provider={account.provider} name={account.label} service={serviceOfAccount(account)?.id} size={20} /><span>{account.label}</span> <span class={`state-chip ${account.state}`}>{stateLabel(account)}</span></>}
      hint={<>
        <div class="account-hint" title={hint}>{hint}</div>
        {plan && <LimitBars account={account} />}
        {showModels && listed.length > 0 && <div class="account-models">{listed.map((model) => shortModelName(model.name) || model.model).join(' · ')}</div>}
      </>}
    >
      <span class="account-slot">
        {signIn && needsSignIn(account)
          ? <ActionButton class="account-sign-in" label="Sign in" disabled={busy} onClick={() => void startLogin(account.id)} />
          : signIn && account.provider === 'codex' && (resetCount(account.limits?.resets) ?? 0) > 0 ? <ResetButton account={account} /> : null}
      </span>
    </Row>
  );
}
