// RPC handlers: the views in <data>/pages (runtime/root/pages.ts): pages.list for the pane's "+" page, pages.read for a page's frame.
// Owns: param checks. Never: what a page may do – it talks through the same RPC as everything else.

import '../../../shared/api/methods-pages.ts';
import { listPages, pageHtml } from '../../root/pages.ts';
import { input, onlyKeys, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('pages.list', (_params, ctx) => listPages(ctx.services.paths.data));
  table.add('pages.read', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name']);
    return { html: pageHtml(ctx.services.paths.data, text(o, 'name', { max: 200 })) };
  });
}
