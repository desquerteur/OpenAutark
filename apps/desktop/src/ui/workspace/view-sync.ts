// Where a file, folder or media tab is scrolled to, in step with the PC it came from, the other linked PCs and the phone
// (B-076, owner 05.11.2026: "wenn Remote gescrollt auch am anderen PC"). A view reports its own scrolling as a light
// value per tab – the fraction 0..1 of its height plus the top line of a text, or a video's second – at most one call
// every VIEW_MS (the first at once, the last one always: Gather); the runtime passes it on (tabs.position). A value from
// elsewhere moves the view there unless the person's own input here is newer than LOCAL_MS – theirs wins for that
// moment – and the move reports nothing back. A view opened later starts where its tab was last – also the first one
// after a start, which opens before the runtime's last values arrive: those move it like a value that just came.
// Owns: the gathering, the last values here and the two hooks. Never: talks to another PC itself or keeps a value over
// a restart.

import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import '../../shared/api/methods-tabs.ts';
import type { TabPosition } from '../../shared/api/methods-tabs.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';

export const VIEW_MS = 300;
/** The person's own scrolling here wins over a value from elsewhere for this long. */
export const LOCAL_MS = 1000;
/** After a move made here for a value from elsewhere, the scroll or seek it causes is no input. */
const SETTLE_MS = 300;

/** Where a view is: the fraction of its height, its top line (1-based) or its second. */
export type Spot = Pick<TabPosition, 'fraction' | 'line' | 'time'>;

/** Sends a key's value at once, then at most one more – its newest – every `ms` while values keep coming. */
export class Gather<T> {
  private readonly waiting = new Map<string, T>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly send: (key: string, value: T) => void;
  private readonly ms: number;

  constructor(send: (key: string, value: T) => void, ms = VIEW_MS) {
    this.send = send;
    this.ms = ms;
  }

  put(key: string, value: T): void {
    if (this.timers.has(key)) { this.waiting.set(key, value); return; }
    this.send(key, value);
    this.arm(key);
  }

  private arm(key: string): void {
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (!this.waiting.has(key)) return;
      const value = this.waiting.get(key)!;
      this.waiting.delete(key);
      this.send(key, value);
      this.arm(key);
    }, this.ms));
  }
}

/** Where an element is scrolled to; `lineHeight`: a text's line height in px (its top line goes along). */
export function spotOf(top: number, scrollHeight: number, clientHeight: number, lineHeight?: number): Spot {
  const range = Math.max(0, scrollHeight - clientHeight);
  return { fraction: range ? Math.min(1, Math.max(0, top / range)) : 0, ...(lineHeight ? { line: Math.floor(top / lineHeight + 0.5) + 1 } : {}) };
}

/** The scroll top for a spot: by its top line when this view shows lines too (the same text), else by its fraction. */
export function topOf(spot: Spot, scrollHeight: number, clientHeight: number, lineHeight?: number): number {
  const range = Math.max(0, scrollHeight - clientHeight);
  const top = lineHeight && spot.line !== undefined ? (spot.line - 1) * lineHeight : spot.fraction * range;
  return Math.min(range, Math.max(0, Math.round(top)));
}

/** A value from elsewhere moves the view once the person's own input here is LOCAL_MS old. */
export const takesRemote = (localAt: number, now: number): boolean => now - localAt >= LOCAL_MS;

/** This window or phone (its own values come back from the runtime and are skipped). */
const CLIENT = Math.random().toString(36).slice(2, 12);
const last = new Map<string, TabPosition>();
const listeners = new Map<string, Set<(position: TabPosition) => void>>();
const gather = new Gather<TabPosition>((_tab, position) => { rpc.call('tabs.position', position).catch(() => undefined); });
let started = false;

function arrived(position: TabPosition): void {
  if (position.from === CLIENT) return;
  last.set(position.tab, position);
  for (const listener of listeners.get(position.tab) ?? []) listener(position);
}

/** Follows the values from elsewhere (false when this connection cannot); exported for the tests. */
export function start(): boolean {
  if (!can('tabs.position')) return false;
  if (started) return true;
  started = true;
  rpc.on('tabs.position', arrived);
  const read = () => { rpc.call('tabs.positions').then((list) => { for (const position of list) if (!last.has(position.tab)) arrived(position); }, () => undefined); };
  rpc.onOpen(read);
  read();
  return true;
}

function report(tab: string, spot: Spot): void {
  const position: TabPosition = { tab, ...spot, from: CLIENT };
  last.set(tab, position);
  gather.put(tab, position);
}

/** `listener` hears each value from elsewhere for `tab` (a view's hook; exported for the tests). */
export function listen(tab: string, listener: (position: TabPosition) => void): () => void {
  let set = listeners.get(tab);
  if (!set) listeners.set(tab, (set = new Set()));
  set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(tab); };
}

/** A line height in px, when the element has a fixed one. */
export function lineHeightOf(element: Element): number | undefined {
  const height = parseFloat(getComputedStyle(element).lineHeight);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/** Keeps `ref`'s vertical scrolling in step for tab `tab`; `ready` changes when its content is (re)drawn; `lines`: a text field (its top line goes along). */
export function useScrollPosition(tab: string, ref: RefObject<HTMLElement>, ready: unknown, lines = false): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !start()) return;
    let localAt = 0;
    let settle = { until: 0, top: -1 };
    const height = () => (lines ? lineHeightOf(element) : undefined);
    const move = (spot: Spot) => {
      const top = topOf(spot, element.scrollHeight, element.clientHeight, height());
      if (Math.abs(element.scrollTop - top) < 1) return;
      settle = { until: Date.now() + SETTLE_MS, top };
      element.scrollTop = top;
    };
    const onScroll = () => {
      if (Date.now() < settle.until && Math.abs(element.scrollTop - settle.top) <= 1) return; // the move made here
      localAt = Date.now();
      report(tab, spotOf(element.scrollTop, element.scrollHeight, element.clientHeight, height()));
    };
    const first = last.get(tab);
    if (first) move(first);
    element.addEventListener('scroll', onScroll, { passive: true });
    const off = listen(tab, (position) => { if (takesRemote(localAt, Date.now())) move(position); });
    return () => { element.removeEventListener('scroll', onScroll); off(); };
  }, [tab, ready]);
}

/** Keeps the second of the video or recording inside `ref` in step for tab `tab` (seeking and pausing count, playing does not). */
export function useTimePosition(tab: string, ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const stage = ref.current;
    if (!stage || !start()) return;
    let localAt = 0;
    let settleUntil = 0;
    const media = () => stage.querySelector<HTMLMediaElement>('video, audio');
    const move = (spot: Spot) => {
      const player = media();
      if (!player || spot.time === undefined || player.readyState < 1 || Math.abs(player.currentTime - spot.time) < 0.5) return;
      settleUntil = Date.now() + SETTLE_MS;
      player.currentTime = spot.time;
    };
    // seeked, pause and loadedmetadata do not bubble: heard on their way down (capture)
    const onSeek = (event: Event) => {
      const player = event.target as HTMLMediaElement;
      if (Date.now() < settleUntil || !player.duration) return;
      localAt = Date.now();
      report(tab, { fraction: Number.isFinite(player.duration) ? player.currentTime / player.duration : 0, time: player.currentTime });
    };
    const onReady = () => { const first = last.get(tab); if (first) move(first); };
    stage.addEventListener('seeked', onSeek, true);
    stage.addEventListener('pause', onSeek, true);
    stage.addEventListener('loadedmetadata', onReady, true);
    onReady();
    const off = listen(tab, (position) => { if (takesRemote(localAt, Date.now())) move(position); });
    return () => {
      stage.removeEventListener('seeked', onSeek, true);
      stage.removeEventListener('pause', onSeek, true);
      stage.removeEventListener('loadedmetadata', onReady, true);
      off();
    };
  }, [tab]);
}
