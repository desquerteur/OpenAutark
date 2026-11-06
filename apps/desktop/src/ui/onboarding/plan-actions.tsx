// The two plan buttons of the model setup (settings/ModelSetup.tsx: the first run and Settings › Models) –
// "Claude plan" and "Codex plan" – each adding an account through plan-setup.ts (install if needed, sign in). The flow
// and its line live in a module signal, not in the component, so a remount (the window crossing the phone layout)
// keeps a sign-in the person is finishing in the browser; a finished flow asks the mounted setup to scan again.
// Owns: wiring the flow to the runtime, the accounts signal, a timer and the window's focus, and the buttons.
// Never: the flow's steps or texts (plan-setup.ts) or settings writes.

import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { DetectionReport } from '../../shared/model/providers.ts';
import { rpc } from '../lib/rpc.ts';
import { accounts } from '../lib/store.ts';
import { Button } from '../lib/ui.tsx';
import { PLAN_LABELS, PLAN_PROVIDERS, startPlanSetup, type PlanEnv, type PlanFlow, type PlanProvider, type PlanView } from './plan-setup.ts';

const PLAN_RPC: PlanEnv['rpc'] = {
  install: (provider) => rpc.call('accounts.install', { provider }),
  add: (provider) => rpc.call('accounts.add', { provider }),
  recheck: () => rpc.call('accounts.detect'),
};
const timer: PlanEnv['timer'] = (ms, fire) => { const id = setTimeout(fire, ms); return () => clearTimeout(id); };
const focus: PlanEnv['focus'] = (fire) => {
  const onFocus = () => fire();
  window.addEventListener('focus', onFocus);
  return () => window.removeEventListener('focus', onFocus);
};

/** The line of the running or last finished flow, and which button runs. */
export const planFlow = signal<{ view?: PlanView; running: PlanProvider | null }>({ running: null });
let flow: PlanFlow | null = null;
/** The mounted setup's forced scan, called when a flow finished. */
let rescan: (() => void) | null = null;

/** Starts the flow for `provider` (a running one is replaced). */
function startPlan(provider: PlanProvider, report: () => DetectionReport | null): void {
  flow?.cancel();
  planFlow.value = { view: planFlow.value.view, running: provider };
  const handle = startPlanSetup(provider, { rpc: PLAN_RPC, accounts, report, timer, focus, show: (view) => { planFlow.value = { ...planFlow.value, view }; } });
  flow = handle;
  void handle.done.then((result) => {
    if (flow !== handle) return; // replaced by a newer flow
    flow = null;
    planFlow.value = { ...planFlow.value, running: null };
    if (result.ok || result.reason !== 'cancelled') rescan?.();
  });
}

/** Registers the mounted setup's scan for finished flows. */
export function usePlanRescan(onFinished: () => void): void {
  const latest = useRef(onFinished);
  latest.current = onFinished;
  useEffect(() => {
    const own = () => latest.current();
    rescan = own;
    return () => { if (rescan === own) rescan = null; };
  }, []);
}

/** "Claude plan" and "Codex plan"; busy on the running one only. */
export function PlanButtons(props: { report: () => DetectionReport | null; disabled?: boolean }) {
  const { running } = planFlow.value;
  return (
    <>
      {PLAN_PROVIDERS.map((provider) => (
        <Button key={provider} variant="secondary" class="small model-setup-plan" busy={running === provider} disabled={props.disabled}
          onClick={() => startPlan(provider, props.report)}>{PLAN_LABELS[provider]}</Button>
      ))}
    </>
  );
}
