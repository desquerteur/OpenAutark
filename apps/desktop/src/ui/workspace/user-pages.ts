// The views in <data>/pages as the window knows them: read once when the pane opens, then kept current by 'pages.updated'.
// Owns: that list. Never: draws a page (PageView.tsx) or reads a file.

import { signal } from '@preact/signals';
import '../../shared/api/methods-pages.ts';
import type { PageInfo } from '../../shared/api/methods-pages.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';

/** Undefined until the first answer. */
export const userPages = signal<PageInfo[] | undefined>(undefined);

let started = false;

export function watchUserPages(): void {
  if (started || !can('pages.list')) return;
  started = true;
  const read = () => { rpc.call('pages.list').then((pages) => { userPages.value = pages; }, () => undefined); };
  rpc.on('pages.updated', (update) => { userPages.value = update.pages; });
  rpc.onOpen(read);
  read();
}
