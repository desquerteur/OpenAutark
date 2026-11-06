// Fresh quota readings when the person opens the limits (B-044, moved out of shell/QuotaRail.tsx): the quota
// details card and Settings › Models (settings/ModelSetup.tsx, AccountRow.tsx – the plan rows with their limit
// bars and Codex resets) ask usage.list with refresh. The runtime's account monitor then reads the plans that
// are due – Codex with its banked resets' credit details, which its background reads skip
// (runtime/accounts/monitor.ts) – and usage.updated brings the new readings. At most once a minute from this window.
// Owns: that request and its minute gate. Never: polls or keeps readings of its own (lib/store.ts usage does).

import { rpc } from './rpc.ts';
import { can } from './session.ts';
import { usage } from './store.ts';

export const USAGE_REFRESH_MS = 60_000;
let refreshedAt = 0;

/** The person opened the limits: fresh readings with the reset details, at most once a minute from this window. */
export function refreshUsage(): void {
  const now = Date.now();
  if (now - refreshedAt < USAGE_REFRESH_MS || !can('usage.list')) return;
  refreshedAt = now;
  rpc.call('usage.list', { refresh: true }).then((list) => { usage.value = list; }, () => { /* the last readings stay */ });
}
