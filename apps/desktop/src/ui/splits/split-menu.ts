// The ONE menu of a split (the sidebar's split rows, a split row in a chat, the split's page name): Open · Stop. Stop
// shows while the part has not settled. Text only.
// Owns: the items and what Stop sends. Never: draws the menu (lib/context-menu.tsx) or merges a part's branch.

import type { MenuSection } from '../lib/popover.tsx';
import type { SplitView } from '../../shared/model/splits.ts';
import { rpc } from '../lib/rpc.ts';
import { go } from '../lib/router.ts';
import { toastError } from '../lib/toasts.ts';
import { applyGroup } from './split-model.ts';
import { isSettled } from './split-text.ts';

async function stopSplit(split: SplitView): Promise<void> {
  try {
    await rpc.call('splits.stop', { id: split.id });
    applyGroup((await rpc.call('splits.get', { id: split.id })).group); // its new status, also where no split event reaches this window
  } catch (error) {
    toastError(error, 'Could not stop the split');
  }
}

export function splitMenu(split: SplitView): MenuSection[] {
  return [{ items: [
    { label: 'Open', onSelect: () => go.split(split.agentId, split.id) },
    ...(!isSettled(split.status) ? [{ label: 'Stop', danger: true, onSelect: () => void stopSplit(split) }] : []),
  ] }];
}
