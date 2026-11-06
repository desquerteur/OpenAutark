// The side pane between the CEO's own PCs and on this PC's phone (B-076, owner 05.11.2026: the side pane shows on the
// other PC "ziemlich das exakt dasselbe"). Between PCs (mesh method 'sync.tabs'): one unit per space of
// <data>/side-tabs.json ('global', 'chat:<id>', 'agent:<id>'), key 'tabs/<space>' in the sync clock (stamps.ts), last
// writer wins. When the file changes – the data folder watcher hears main's saves and every outside edit (service.ts) –
// each space is looked at in its shared form (tabs-map.ts); one whose form really changed gets a new stamp and goes to
// the online CEO PCs with the remote panels closed here since (`closed`, so their own PC closes them), so unchanged
// content sends nothing and a copy written here never echoes. A copy that wins is merged into this PC's file – its own
// websites stay its own – and written atomically (main follows within a second), then passed on to the other CEO PCs;
// `closed` is acted on even when its copy lost. What the merge kept or closed travels back as this PC's own change. A
// link-up sends every space; one nobody changed since the link has a baseline at 0, so the PC that joined takes the
// other's (its own websites stay and travel back) – what its person changes before that pane came stays at 0 too
// (`joining`). A copy that wins never brings back a website of another PC closed here – also one whose close has not
// gone out yet: the space's record keeps naming it in `closed`, and the next copy from here carries it. The phone: paneTabs / setPaneTabs (tabs.get, tabs.set) and
// announcePane (event tabs.changed) on every change of the file, with or without a linked PC.
// Owns: the space stamps, the last shared form per space (kv 'sync.tabs') and this exchange. Never: talks to a PC that is
// no 'ceo' link, opens a website of this PC for another PC, or logs what a tab shows.

import '../../../shared/api/methods-tabs.ts';
import type { PaneTabs } from '../../../shared/api/methods-tabs.ts';
import { isSpace, type SideSpace, type SideSpaces } from '../../../shared/api/workspace-browser.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { readSideTabs, sideTabsFile, writeSideTabs } from '../../root/side-tabs.ts';
import { KvRepo } from '../../store/kv.ts';
import { DevicesRepo } from '../repo.ts';
import { linkOf, links, selfId } from './home.ts';
import { hashOf, wins, type Stamps } from './stamps.ts';
import { applyPhone, closedBetween, mergeSpace, phoneSpaces, sharedSpace, withoutClosed, withoutIds } from './tabs-map.ts';

const PREFIX = 'tabs/';
const NS = 'sync.tabs';
/** Remote panels closed here that a copy keeps naming (their tab ids are never used again). */
const CLOSED_MAX = 50;

/** One space as it travels: its shared form, its stamp and the remote panels closed here since. */
export interface SpaceCopy extends SideSpace { at: number; h: string; closed?: string[] }
export interface TabsMessage { spaces: Record<string, SpaceCopy> }
/** The last shared form of a space here, with the remote panels closed here (kv 'sync.tabs'). */
type Last = SideSpace & { closed?: string[] };

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validCopy = (copy: unknown): copy is SpaceCopy => plain(copy) && typeof copy.at === 'number' && typeof copy.h === 'string' && Array.isArray(copy.tabs);
const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export class TabSync {
  private readonly s: RuntimeServices;
  private readonly stamps: Stamps;
  private readonly kv: KvRepo;
  private live = false;
  /** This PC joined another and has not had that PC's pane yet: a change here keeps its stamp at 0, so that pane wins. */
  private joining = false;

  constructor(s: RuntimeServices, stamps: Stamps) {
    this.s = s;
    this.stamps = stamps;
    this.kv = new KvRepo(s.db);
  }

  private get file(): string { return sideTabsFile(this.s.paths.data); }

  /** A PC is linked: what changed while none was is stamped (a space never stamped gets its baseline at 0); returns the off switch. */
  attach(): () => void {
    this.live = true;
    this.joining = !this.stamps.since(PREFIX, -1).length && links(this.s.db).some(({ record, link }) => link.kind === 'ceo' && record.joinedAs === 'ceo');
    this.changed(true);
    return () => { this.live = false; };
  }

  /** The file changed: each space whose shared form changed gets its stamp and goes to the online CEO PCs. */
  changed(baseline = false): void {
    if (!this.live) return;
    try {
      const spaces = readSideTabs(this.file);
      if (!spaces) return; // no tab file right now: nothing travels until it is one again
      const self = selfId(this.s.db);
      const out: Record<string, SpaceCopy> = {};
      for (const key of this.keys(spaces)) {
        const copy = this.note(key, sharedSpace(spaces[key], self), self, baseline);
        if (copy) out[key] = copy;
      }
      if (Object.keys(out).length) void this.toCeo({ spaces: out });
    } catch (error) {
      this.s.log.warn('side pane change not synced', { error: errorText(error) });
    }
  }

  /** Every space the file or the clock knows. */
  private keys(spaces: SideSpaces): string[] {
    return [...new Set([...Object.keys(spaces), ...this.stamps.since(PREFIX, -1).map(({ key }) => key.slice(PREFIX.length))])].filter(isSpace);
  }

  /** Records space `key`'s shared form; its copy when the form changed since its stamp. */
  private note(key: string, form: SideSpace, self: string, baseline: boolean): SpaceCopy | undefined {
    const h = hashOf(form);
    const old = this.stamps.get(PREFIX + key);
    if (old?.h === h) return undefined;
    const now = this.s.clock.now();
    if ((!old && baseline) || ((!old || old.at === 0) && this.joining)) { // nothing changed since the link, or the joined PC's pane is still to come
      this.stamps.set(PREFIX + key, { at: 0, h });
      this.kv.set(NS, key, form, now);
      return undefined;
    }
    const last = this.kv.get<Last>(NS, key);
    const listed = new Set(form.tabs.map((tab) => tab.id));
    const closed = [...new Set([...(last?.closed ?? []).filter((id) => !listed.has(id)), ...closedBetween(last, form, self)])].slice(-CLOSED_MAX);
    const stamp = this.stamps.next(old, h);
    const record: Last = { ...form, ...(closed.length ? { closed } : {}) };
    this.stamps.set(PREFIX + key, stamp);
    this.kv.set(NS, key, record, now);
    return { ...record, at: stamp.at, h };
  }

  /** Every space for a link-up, as last recorded (at 0 when nobody changed it since the link). */
  current(): TabsMessage {
    const spaces: Record<string, SpaceCopy> = {};
    for (const { key, stamp } of this.stamps.since(PREFIX, -1)) {
      const space = key.slice(PREFIX.length);
      const last = this.kv.get<Last>(NS, space);
      if (last && isSpace(space)) spaces[space] = { ...last, at: stamp.at, h: stamp.h };
    }
    return { spaces };
  }

  /** What the link-up owes a CEO PC: every space (a change the watcher has not handed over yet first). */
  async catchUp(peer: string): Promise<boolean> {
    if (!this.live || linkOf(new DevicesRepo(this.s.db).get(peer))?.kind !== 'ceo') return true;
    this.changed();
    return this.post(peer, this.current());
  }

  private async toCeo(message: TabsMessage, except?: string): Promise<void> {
    for (const { record, link } of links(this.s.db)) {
      if (link.kind !== 'ceo' || record.id === except || !this.s.devices.online(record.id)) continue;
      await this.post(record.id, message);
    }
  }

  private async post(peer: string, message: TabsMessage): Promise<boolean> {
    try {
      await this.s.devices.call(peer, 'sync.tabs', message);
      return true;
    } catch (error) {
      this.s.log.info('side pane not sent', { peer, error: errorText(error) });
      return false;
    }
  }

  /** 'sync.tabs' from a CEO PC: each space that wins is merged into the file, `closed` closes this PC's own websites. */
  async receive(params: unknown, from: string): Promise<{ ok: true }> {
    const record = new DevicesRepo(this.s.db).get(from);
    if (linkOf(record)?.kind !== 'ceo') throw new WorkforceError('forbidden', 'The side pane comes only from the CEO\'s own PCs.');
    const message = (params ?? {}) as { spaces?: unknown };
    if (!plain(message.spaces)) return { ok: true };
    this.changed(); // a change of this PC's own the watcher has not handed over yet gets its stamp first
    const current = readSideTabs(this.file);
    if (!current) return { ok: true }; // no tab file right now: the next link-up brings it again
    const self = selfId(this.s.db);
    const copies = Object.entries(message.spaces).filter((entry): entry is [string, SpaceCopy] => isSpace(entry[0]) && validCopy(entry[1]));
    const closed = new Set(copies.flatMap(([, copy]) => (Array.isArray(copy.closed) ? copy.closed.filter((id): id is string => typeof id === 'string') : [])));
    const won: Record<string, SpaceCopy> = {};
    let next: SideSpaces = { ...current };
    for (const [key, copy] of copies) {
      const local = this.stamps.get(PREFIX + key) ?? (current[key] ? { at: 0, h: hashOf(sharedSpace(current[key], self)) } : undefined);
      if (local?.h === copy.h || !wins({ at: copy.at, h: copy.h }, local, Boolean(record?.joinedAs))) continue;
      won[key] = copy;
      const merged = withoutIds(mergeSpace(current[key], copy, self, closed), this.kv.get<Last>(NS, key)?.closed ?? []);
      if (merged.tabs.length) next[key] = merged;
      else delete next[key];
    }
    next = withoutClosed(next, closed, self);
    // First the stamps and forms: the change of the file then finds nothing new where a copy was taken as it came, and
    // nothing the merge left out counts as closed here; what was closed here stays named until it went out.
    const now = this.s.clock.now();
    for (const [key, copy] of Object.entries(won)) {
      const closedHere = this.kv.get<Last>(NS, key)?.closed ?? [];
      this.stamps.set(PREFIX + key, { at: copy.at, h: copy.h });
      this.kv.set(NS, key, { ...sharedSpace(next[key], self), ...(closedHere.length ? { closed: closedHere } : {}) }, now);
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) writeSideTabs(this.file, next);
    if (record?.joinedAs === 'ceo') this.joining = false; // the joined PC's pane is here
    this.changed(); // what this PC kept (its own websites) or closed goes back as its own change
    if (Object.keys(won).length) void this.toCeo({ spaces: won }, from);
    return { ok: true };
  }
}

// ---------------------------------------------------------------- the phone

/** This PC's side pane as its phone shows it. */
export function paneTabs(s: Pick<RuntimeServices, 'db' | 'paths'>): PaneTabs {
  const self = selfId(s.db);
  return { device: self, spaces: phoneSpaces(readSideTabs(sideTabsFile(s.paths.data)) ?? {}, self) };
}

/** The spaces the phone changed go into the file (main and the linked PCs follow from there). */
export function setPaneTabs(s: Pick<RuntimeServices, 'db' | 'paths'>, spaces: Plain, closed: readonly string[]): void {
  const file = sideTabsFile(s.paths.data);
  const current = readSideTabs(file);
  if (!current) throw new WorkforceError('conflict', 'side-tabs.json cannot be read right now.');
  const next = applyPhone(current, spaces, new Set(closed), selfId(s.db));
  if (JSON.stringify(next) !== JSON.stringify(current)) writeSideTabs(file, next);
}

/** Tells this PC's window and phones what the side pane holds now (event tabs.changed). */
export function announcePane(s: Pick<RuntimeServices, 'db' | 'paths' | 'bus' | 'log'>): void {
  try { s.bus.emit('tabs.changed', paneTabs(s)); } catch (error) { s.log.warn('side pane not announced', { error: errorText(error) }); }
}
