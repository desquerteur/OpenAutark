// The sync between linked PCs, put together once by the runtime's composition root (main.ts): the mesh methods
// sync.rows (rows.ts; from an employee's PC it takes only that person's own lines and task changes, employee.ts),
// sync.secret (secrets.ts), sync.file (files.ts with the settings and stored files' bytes), sync.login (logins.ts) and,
// B-076, the side pane: sync.tabs (tabs.ts), files.path (paths.ts: a file tab of another PC reads there) and
// tabs.position (positions.ts: where a tab is scrolled to) – none of them open methods, so an employee's PC cannot call
// them – and the listeners, attached only while a PC is linked (nothing runs without a link). <data>/side-tabs.json
// gets its owner on the data folder watcher here: every change is told to this PC's window and phones (tabs.changed),
// and goes to the linked PCs while one is. B-078: sync.roster and device.sibling (roster.ts) let my devices know each
// other and their phones. A link that comes up (device.upserted 'online') runs its link-up: the roster first, then
// the side pane (small, so a PC that just joined shows the other's pane at once), rows, secrets, settings and files
// owed since that PC's cursor (stamps.ts) and every plan's login, then the wakes that waited for it; a complete link-up moves the cursor to its start. Removing a PC drops its cursor, so a
// new link begins with everything again. A link that comes up or goes re-places the schedules' due times (one PC fires
// each).
// Owns: this wiring and the link-up order. Never: decides what a link carries (home.ts) or logs content.

import type { RuntimeServices } from '../../contracts.ts';
import { ROOT_SIDE_TABS } from '../../root/layout.ts';
import { PATH_OPS } from '../../rpc/handlers/files-path.ts';
import type { PeerHandler } from '../rpc-peer.ts';
import { FileSync, type WatcherTap } from './files.ts';
import { links } from './home.ts';
import { LoginSync } from './logins.ts';
import { RemotePaths } from './paths.ts';
import { tabPositions } from './positions.ts';
import { RowSync } from './rows.ts';
import { SecretSync } from './secrets.ts';
import { Stamps } from './stamps.ts';
import { RosterSync, type RosterMesh } from './roster.ts';
import { placeSchedules } from './tables.ts';
import { EVERY_LINK, type LinkKind } from '../mesh.ts';
import { announcePane, TabSync } from './tabs.ts';

export interface SyncInput {
  s: RuntimeServices;
  /** Where peer methods are registered (the mesh); with add/revoke/selfInfo the roster runs too (roster.ts). */
  mesh: { register(method: string, handler: PeerHandler, kinds?: readonly LinkKind[]): void } & Partial<Omit<RosterMesh, 'register'>>;
  /** The data folder watcher's tap, when it has one (live file changes; else the owners' events and link-ups). */
  tap?: WatcherTap;
}

export interface Sync { stop(): void }

export function startSync(input: SyncInput): Sync {
  const { s, mesh } = input;
  const stamps = new Stamps(s.db, s.clock);
  const rows = new RowSync(s, stamps);
  const secrets = new SecretSync(s, stamps);
  const files = new FileSync(s, stamps);
  const logins = new LoginSync(s);
  const tabs = new TabSync(s, stamps);
  const paths = new RemotePaths(s, rows, PATH_OPS);
  const { add, revoke, selfInfo } = mesh;
  const roster = add && revoke && selfInfo ? new RosterSync(s, { register: mesh.register.bind(mesh), add: add.bind(mesh), revoke: revoke.bind(mesh), selfInfo: selfInfo.bind(mesh) }) : undefined;
  mesh.register('sync.rows', (params, from) => rows.receive(params, from), EVERY_LINK); // from an employee's PC only its person's own part (employee.ts)
  mesh.register('sync.secret', (params, from) => secrets.receive(params, from));
  mesh.register('sync.file', (params, from) => files.receive(params, from));
  mesh.register('sync.login', (params, from) => logins.receive(params, from));
  mesh.register('sync.tabs', (params, from) => tabs.receive(params, from));
  mesh.register('files.path', (params, from) => paths.serve(params, from));
  mesh.register('tabs.position', (params, from) => tabPositions(s).receive(params, from));
  const unwatch = s.rootWatcher?.register(ROOT_SIDE_TABS, () => { announcePane(s); tabs.changed(); });

  let detach: (() => void) | undefined;
  const online = new Set<string>();
  const refresh = () => {
    const linked = links(s.db).length > 0;
    if (linked && !detach) {
      const offs = [rows.attach(), secrets.attach(), files.attach(input.tap), logins.attach(), tabs.attach(), ...(roster ? [roster.attach()] : [])];
      detach = () => { for (const off of offs) off(); };
    } else if (!linked && detach) {
      detach();
      detach = undefined;
    }
  };
  const linkUp = async (peer: string) => {
    const since = stamps.cursor(peer);
    const started = s.clock.now();
    await roster?.linkUp(peer).catch((error: unknown) => s.log.warn('roster not exchanged', { peer, error: String((error as Error)?.message ?? error) })); // small, first: my devices know each other at once
    await tabs.catchUp(peer); // every space, at every link-up, first: no part of the cursor, and a PC that joined has the pane at once
    const rowsDone = await rows.catchUp(peer, since);
    rows.resume(); // B-077: waiting wakes go as soon as the rows are there, not after secrets, the file rescan and logins
    const done = [rowsDone, await secrets.catchUp(peer, since), await files.catchUp(peer, since)];
    await logins.catchUp(peer); // every login, at every link-up: no part of the cursor
    if (done.every(Boolean)) stamps.setCursor(peer, started);
    s.log.info('linked PC caught up', { peer, first: since === undefined, complete: done.every(Boolean) });
  };
  // Which PC fires a schedule follows the links (tables.ts placeSchedules).
  const place = () => { try { placeSchedules(s); } catch (error) { s.log.warn('schedules not placed', { error: String((error as Error)?.message ?? error) }); } };
  const off = s.bus.on('device.upserted', (device) => {
    if (device.kind !== 'pc' || device.self) return;
    refresh();
    if (device.status !== 'online') {
      online.delete(device.id);
      if (device.status === 'revoked') { stamps.dropCursor(device.id); place(); }
      return;
    }
    if (online.has(device.id)) return;
    online.add(device.id);
    place();
    void linkUp(device.id).catch((error: unknown) => s.log.warn('linked PC not caught up', { peer: device.id, error: String((error as Error)?.message ?? error) }));
  });
  refresh();
  return { stop: () => { off(); unwatch?.(); detach?.(); detach = undefined; } };
}
