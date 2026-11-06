// Repair mode in the window (23.10.2026): after every (re)connect of the desktop window the
// runtime is asked whether it runs in repair mode (repair.state – a normal runtime answers
// active: false). While it does, App.tsx shows the repair screen instead of the shell; after Retry
// or a restore the runtime restarts, the window reconnects and the next answer decides again.
// Owns: the repairState signal and the three actions' calls. Never: a timer or polling, or a call
// from a phone/browser (the repair runtime serves only the PC's own window).

import { signal } from '@preact/signals';
import type { DiagnosticsExport, RepairState } from '../../shared/model/repair.ts';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';

/** The runtime's answer to repair.state after the last connect (null before it, or when it failed). */
export const repairState = signal<RepairState | null>(null);

let started = false;

export function startRepairWatch(): void {
  if (started || platform !== 'desktop') return;
  started = true;
  rpc.onOpen(() => {
    void rpc.call('repair.state').then((state) => { repairState.value = state; }).catch(() => { repairState.value = null; });
  });
}

export function retryStart(): Promise<{ ok: true }> {
  return rpc.call('repair.retry');
}

export function restoreCopy(id: string): Promise<{ ok: true; kept: string }> {
  return rpc.call('repair.restore', { id });
}

export function exportDiagnostics(): Promise<DiagnosticsExport> {
  return rpc.call('repair.diagnostics');
}
