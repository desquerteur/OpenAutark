// Where a file, folder or media tab is scrolled to (B-076, owner 05.11.2026: "wenn Remote gescrollt auch am anderen
// PC") – a light value per tab, never in side-tabs.json (every change there makes main reload). This PC's window and
// phones report it (tabs.position, gathered to about every 300 ms in ui/workspace/view-sync.ts); this PC keeps the last
// one per tab (at most POSITIONS_MAX, the oldest go), tells its window and phones (event tabs.position) and sends it to
// its online CEO PCs (mesh method 'tabs.position') under the tab's shared id (tabs-map.ts). One from there is kept and
// told here under this PC's id for that tab, and never passed on.
// Owns: these values. Never: writes a file, or takes a value from a PC that is no 'ceo' link.

import '../../../shared/api/methods-tabs.ts';
import type { TabPosition } from '../../../shared/api/methods-tabs.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { DevicesRepo } from '../repo.ts';
import { linkOf, links, selfId } from './home.ts';
import { localId, sharedId } from './tabs-map.ts';

export const POSITIONS_MAX = 200;
const TAB_MAX = 700;

type Services = Pick<RuntimeServices, 'db' | 'bus' | 'devices' | 'log'>;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A position as it may be kept (the fraction clamped to 0..1), else undefined. */
export function positionOf(value: unknown): TabPosition | undefined {
  if (!plain(value) || typeof value.tab !== 'string' || !value.tab || value.tab.length > TAB_MAX || !finite(value.fraction)) return undefined;
  if (typeof value.from !== 'string' || value.from.length > 64) return undefined;
  const line = finite(value.line) && value.line >= 0 ? Math.floor(value.line) : undefined;
  const time = finite(value.time) && value.time >= 0 ? value.time : undefined;
  return { tab: value.tab, fraction: Math.min(1, Math.max(0, value.fraction)), ...(line !== undefined ? { line } : {}), ...(time !== undefined ? { time } : {}), from: value.from };
}

export class TabPositions {
  private readonly s: Services;
  private readonly last = new Map<string, TabPosition>();

  constructor(s: Services) { this.s = s; }

  /** From this PC's window or phone: kept, told here and sent to the online CEO PCs. */
  report(position: TabPosition): void {
    this.keep(position);
    const self = selfId(this.s.db);
    const shared = { ...position, tab: sharedId(position.tab, self) };
    for (const { record, link } of links(this.s.db)) {
      if (link.kind !== 'ceo' || !this.s.devices.online(record.id)) continue;
      this.s.devices.call(record.id, 'tabs.position', shared).catch((error: unknown) => {
        this.s.log.debug('tab position not sent', { peer: record.id, error: String((error as Error)?.message ?? error) });
      });
    }
  }

  /** 'tabs.position' from a CEO PC: kept and told here under this PC's id. */
  async receive(params: unknown, from: string): Promise<{ ok: true }> {
    if (linkOf(new DevicesRepo(this.s.db).get(from))?.kind !== 'ceo') throw new WorkforceError('forbidden', 'Tab positions come only from the CEO\'s own PCs.');
    const position = positionOf(params);
    if (position) this.keep({ ...position, tab: localId(position.tab, selfId(this.s.db)) });
    return { ok: true };
  }

  /** The last position of every tab (oldest first). */
  list(): TabPosition[] {
    return [...this.last.values()];
  }

  private keep(position: TabPosition): void {
    this.last.delete(position.tab);
    this.last.set(position.tab, position);
    if (this.last.size > POSITIONS_MAX) this.last.delete(this.last.keys().next().value!);
    this.s.bus.emit('tabs.position', position);
  }
}

const hubs = new WeakMap<object, TabPositions>();

/** This runtime's positions (one per services object). */
export function tabPositions(s: Services): TabPositions {
  let hub = hubs.get(s);
  if (!hub) hubs.set(s, (hub = new TabPositions(s)));
  return hub;
}
