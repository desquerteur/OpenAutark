// AF-004 – the small Stop of an agent view row: which existing stop a row may call and calling it. A main-lane run stops
// with runs.cancel (its own turn – groups it made that have not started never start, runtime agents/split-stop.ts); a part
// with splits.stop {id}; an agent that only waits for its parts with splits.stop {groupId} per group. Where this
// connection may not call the method (a phone without 'manage') the slot stays empty – the cell keeps its room.
// AF-012 builds the run Stop of the composer and may replace `stopAction` with its shared stop; the row only asks here.
// Owns: the choice of the method and its error toast. Never: draws the button (AgentView.tsx), or stops more than its row.

import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { applyGroup } from '../splits/split-model.ts';
import type { StopTarget } from './agent-tree.ts';

/** The row's Stop, or undefined when there is nothing to stop or this connection may not. */
export function stopAction(target: StopTarget | undefined): (() => Promise<void>) | undefined {
  if (!target) return undefined;
  if (target.kind === 'run') {
    if (!can('runs.cancel')) return undefined;
    return async () => {
      try { await rpc.call('runs.cancel', { runId: target.runId }); } catch (error) { toastError(error, 'Could not stop the run'); }
    };
  }
  if (!can('splits.stop')) return undefined;
  if (target.kind === 'split') {
    return async () => {
      try {
        await rpc.call('splits.stop', { id: target.splitId });
        applyGroup((await rpc.call('splits.get', { id: target.splitId })).group); // its new state, also where no split event reaches
      } catch (error) {
        toastError(error, 'Could not stop the part');
      }
    };
  }
  return async () => {
    try { await Promise.all(target.groupIds.map((groupId) => rpc.call('splits.stop', { groupId }))); } catch (error) { toastError(error, 'Could not stop the parts'); }
  };
}
