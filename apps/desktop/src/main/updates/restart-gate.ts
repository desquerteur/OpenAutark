// Safe-point rules for an automatic update restart (concept F-27, decision B-023).
// Owns: the pure decision "may the app restart by itself now, and if not, when to look again".
// Never: reads system state itself – the update service gathers the inputs.

export const IDLE_REQUIRED_S = 60; // system idle before an automatic restart
export const COUNTDOWN_MS = 10_000; // visible announcement before it happens
export const BUSY_RECHECK_MS = 30_000; // runtime busy (streaming, drafts, writes): look again later

export interface GateInput {
  packaged: boolean;
  automaticInstall: boolean; // false on macOS without mac-self-update.ts (manual download only)
  autoDownload: boolean; // user preference "install updates automatically"
  deferred: boolean; // "Later" was clicked in this process
  rendererReady: boolean; // UI says: no dialog/settings open, empty composer, no recording
  idleSeconds: number; // powerMonitor.getSystemIdleTime()
  runtimeReady: boolean; // runtime: no streaming replies, unsaved drafts/attachments, pending writes
}

export type GateDecision =
  | { action: 'never' } // automatic restart is off for this download (manual click only)
  | { action: 'wait'; recheckMs: number | null; reasons: string[] } // null = wait for an event
  | { action: 'restart' };

export function evaluateGate(input: GateInput): GateDecision {
  if (!input.packaged || !input.automaticInstall || !input.autoDownload || input.deferred) return { action: 'never' };
  const reasons: string[] = [];
  if (!input.rendererReady) reasons.push('ui-busy');
  if (!input.runtimeReady) reasons.push('runtime-busy');
  if (input.idleSeconds < IDLE_REQUIRED_S) reasons.push('user-active');
  if (!reasons.length) return { action: 'restart' };
  // The UI reports its changes as events; idle and runtime state need a timer.
  let recheckMs: number | null = null;
  if (input.idleSeconds < IDLE_REQUIRED_S) recheckMs = Math.max(1, IDLE_REQUIRED_S - Math.floor(input.idleSeconds)) * 1000;
  if (!input.runtimeReady) recheckMs = Math.max(recheckMs ?? 0, BUSY_RECHECK_MS);
  if (!input.rendererReady) recheckMs = null; // an event will trigger the next look
  return { action: 'wait', recheckMs, reasons };
}
