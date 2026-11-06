// RPC handlers (B-076, "auch am Handy"): the side pane of this PC for its phone – tabs.get and tabs.set
// (devices/sync/tabs.ts; the event tabs.changed comes with every change of <data>/side-tabs.json) – and where a tab is
// scrolled to – tabs.position and tabs.positions (devices/sync/positions.ts). For the owner and 'manage' devices.
// Owns: param checks. Never: decides what a space holds or where a value goes.

import '../../../shared/api/methods-tabs.ts';
import { positionOf, tabPositions } from '../../devices/sync/positions.ts';
import { paneTabs, setPaneTabs } from '../../devices/sync/tabs.ts';
import { bad, capJson, input, obj, onlyKeys, optStrings } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const MANAGE = { capability: 'manage' } as const;
/** A phone's spaces in one call (side-tabs.json holds a few dozen tabs per space). */
const SPACES_MAX = 400_000;

export function register(table: HandlerTable): void {
  table.add('tabs.get', (_params, ctx) => paneTabs(ctx.services), MANAGE);
  table.add('tabs.set', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['spaces', 'closed']);
    const spaces = obj(o, 'spaces');
    capJson('spaces', spaces, SPACES_MAX);
    setPaneTabs(ctx.services, spaces, optStrings(o, 'closed', { maxItems: 200, max: 700 }) ?? []);
    return { ok: true as const };
  }, MANAGE);
  table.add('tabs.position', (params, ctx) => {
    const position = positionOf(params);
    if (!position) bad('params', 'a tab position {tab, fraction, line?, time?, from}');
    tabPositions(ctx.services).report(position);
    return { ok: true as const };
  }, MANAGE);
  table.add('tabs.positions', (_params, ctx) => tabPositions(ctx.services).list(), MANAGE);
}
