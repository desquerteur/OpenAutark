// The model setup – the first run's AI card and Settings › Models show the same: the plans on this PC (Claude Code
// and Codex always, Kimi Code / Gemini CLI / Copilot CLI when found) with their state – a connected one as its account
// row (AccountRow.tsx, with its models) –, `children` (Settings: the other connections), the provider key variables set on
// this PC not in use yet (Use), one fixed row of four buttons –
// Claude plan, Codex plan (plan-actions.tsx: add an account and sign in, install if needed), API key and Local server (both open
// the one connection form inline under it, account-forms.tsx) – with the sign-in link cell and one status line for the
// plan flow. Settings shows the use rows under it (ModelUses.tsx).
// Owns: this layout and its PC scan (accounts.detect, again after a plan flow). Never: a flow's steps (plan-setup.ts).

import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { envKeyProvider, type DetectionReport } from '../../shared/model/providers.ts';
import { rpc } from '../lib/rpc.ts';
import { accounts, loadModels } from '../lib/store.ts';
import { pushToast } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { PlanButtons, planFlow, usePlanRescan } from '../onboarding/plan-actions.tsx';
import { PLAN_PROVIDERS } from '../onboarding/plan-setup.ts';
import { SignInLink } from '../onboarding/sign-in-link.tsx';
import { signInStarted } from './account-actions.ts';
import { ConnectionForm } from './account-forms.tsx';
import { AccountRow } from './AccountRow.tsx';
import { ActionButton, Row, useBusy } from './controls.tsx';
import { cliRowView, groupAccounts, needsSignIn, PC_CLIS, PROVIDER_NAMES, stateLabel } from './providers.ts';

type Cli = DetectionReport['clis'][number];

/** The plans with a button; the others are listed only when found. */
const WITH_BUTTON: ReadonlySet<string> = new Set<string>(PLAN_PROVIDERS);

/** A plan CLI without a connected account: its state, and the one action the buttons do not cover. */
function CliRow(props: { cli: Cli; scanned: boolean; onChanged: () => void }) {
  const [busy, run] = useBusy();
  const view = cliRowView(props.cli, accounts.value);
  const provider = props.cli.provider;
  const covered = WITH_BUTTON.has(provider) && (view.action === 'install' || view.action === 'sign-in');
  const action = props.scanned && !covered ? view.action : undefined;
  const add = (detected: boolean) => void run(async () => {
    const added = await rpc.call('accounts.add', { provider, ...(detected ? { detected: true } : {}) });
    if (needsSignIn(added)) signInStarted(added.id, added.provider);
    else pushToast({ title: `${view.name}: ${stateLabel(added)}` });
  });
  return (
    <Row class="cli-row" label={view.name} hint={props.scanned ? view.hint : 'Looking…'} reserve>
      <span class="account-slot">
        {(action === 'sign-in' || action === 'add') && <ActionButton label="Sign in" busy={busy} onClick={() => add(false)} />}
        {action === 'add-again' && <ActionButton label="Add again" busy={busy} onClick={() => add(true)} />}
        {action === 'check' && <ActionButton label="Check again" busy={busy} onClick={props.onChanged} />}
      </span>
    </Row>
  );
}

/** A provider key variable set on this PC (PR5): Use reads it while the app runs; its value never travels or is stored. */
function EnvKeyRow(props: { name: string }) {
  const { name } = props;
  const [busy, run] = useBusy();
  const provider = envKeyProvider(name);
  if (!provider || provider === 'ollama' || accounts.value.some((account) => account.auth === 'env' && account.envVar === name)) return null;
  const typed = accounts.value.some((account) => account.provider === provider && account.auth !== 'env');
  const use = () => void run(async () => {
    await rpc.call('accounts.add', { provider, envVar: name });
    pushToast({ title: `${PROVIDER_NAMES[provider] ?? provider} connected`, body: `Autark reads the key from ${name} while it runs and never stores it.` });
  });
  return (
    <Row label={PROVIDER_NAMES[provider] ?? provider} hint={`Key in ${name}${typed ? ' · already connected with another key' : ''}`} reserve>
      <span class="account-slot"><ActionButton label="Use" busy={busy} onClick={use} /></span>
    </Row>
  );
}

export function ModelSetup(props: { children?: ComponentChildren }) {
  const [report, setReport] = useState<DetectionReport | null>(null);
  const [scanned, setScanned] = useState(false);
  const [form, setForm] = useState<'api' | 'local' | null>(null);
  const scan = async (force = false) => {
    try {
      setReport(await rpc.call('accounts.detect', force ? { force: true } : undefined));
      accounts.value = await rpc.call('accounts.list'); // the logins the scan adopted
      void loadModels(force);
    } catch { /* the rows still show; the buttons say what is missing */ } finally { setScanned(true); }
  };
  useEffect(() => { void scan(); }, []);
  usePlanRescan(() => void scan(true));
  const toggle = (next: 'api' | 'local') => setForm(form === next ? null : next);
  const view = planFlow.value.view;
  const server = report?.localServers.find((found) => !accounts.value.some((account) => account.baseUrl === found.baseUrl));
  return (
    <>
      {PC_CLIS.flatMap((provider) => {
        const list = groupAccounts(accounts.value.filter((account) => account.provider === provider && account.auth === 'cli'))[0]?.accounts ?? [];
        if (list.length) return list.map((account) => <AccountRow key={account.id} account={account} siblings={list} />);
        const cli = report?.clis.find((entry) => entry.provider === provider);
        return WITH_BUTTON.has(provider) || cli?.path ? [<CliRow key={provider} cli={cli ?? { provider }} scanned={scanned} onChanged={() => void scan(true)} />] : [];
      })}
      {props.children}
      {report?.envKeys.map((name) => <EnvKeyRow key={name} name={name} />)}
      <div class="model-setup-buttons">
        <PlanButtons report={() => report} />
        <Button variant="secondary" class="small" aria-pressed={form === 'api'} onClick={() => toggle('api')}>API key</Button>
        <Button variant="secondary" class="small" aria-pressed={form === 'local'} onClick={() => toggle('local')}>Local server</Button>
        <SignInLink url={view?.url} />
      </div>
      <p class={`model-setup-status${view?.tone ? ` ${view.tone}` : ''}`} role="status" title={view?.text}>{view?.text ?? ''}</p>
      {form && <ConnectionForm key={form} kind={form} onDone={() => setForm(null)} {...(form === 'local' && server ? { found: server } : {})} />}
    </>
  );
}
