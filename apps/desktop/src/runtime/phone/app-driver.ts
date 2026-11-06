// B-078 (D6): phone use through the Autark Android app – no ADB, no cable. The app's own use socket attaches
// (phoneUse.attach, rpc/handlers/phone-use.ts) and hears `phoneUse.request` for its device only; this driver sends one
// request per step on the bus and waits for its phoneUse.reply (20 s, or the run's cancel). The serial of an app phone
// is its device id. On the phone an AccessibilityService reads nothing until a request asks, a bubble shows while it
// acts (a tap there cancels and pauses for 30 s) and each new app asks the person once (apps/android phoneuse/*).
// Owns: the attached phones, the request/answer pairing and turning answers into PhoneDriver values.
// Never: reaches a phone that is not attached, or keeps a request beyond its timeout.

import { randomBytes } from 'node:crypto';
import type { Bus } from '../bus.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { PhoneUseAttach, PhoneUseOp, PhoneUseReply } from '../../shared/api/methods-phone.ts';
import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import type { PhoneDriver, PhoneShot, PhoneStepOptions, PhoneTree } from './driver.ts';
import { renderDump, screenOf, type PhoneDevice, type PhoneNode } from './uiautomator.ts';

export const APP_PHONE_TIMEOUT_MS = 20_000;

/** What the phone says when phone use is not on yet (it shows the enable notification itself). */
export const PHONE_USE_OFF = 'Phone use is off on this phone. The app showed the person a notification "Let the AI use this phone"; one tap opens Android\'s Accessibility settings (a sideloaded app first needs App info › ⋮ › Allow restricted settings). I try again once it is on.';

export interface AppPhonesDeps {
  bus: Pick<Bus, 'on' | 'emit'>;
  /** The device list (names of phones). */
  devices(): Device[];
  timeoutMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Attached { model?: string; screen?: { width: number; height: number }; ready: boolean; sockets: number }
interface Pending { deviceId: string; resolve(value: unknown): void; reject(error: Error): void; timer: unknown; off?: () => void }

const realTimers = {
  set: (fn: () => void, ms: number) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer as unknown; },
  clear: (handle: unknown) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

const KNOWN: ReadonlySet<string> = new Set(['bad_request', 'not_found', 'forbidden', 'conflict', 'unavailable', 'timeout', 'cancelled']);

export class AppPhones implements PhoneDriver {
  private readonly deps: AppPhonesDeps;
  private readonly attached = new Map<string, Attached>();
  private readonly pending = new Map<string, Pending>();
  private readonly offs: Array<() => void>;

  constructor(deps: AppPhonesDeps) {
    this.deps = deps;
    this.offs = [
      deps.bus.on('phoneUse.attached', (event) => this.attach(event)),
      deps.bus.on('phoneUse.reply', (reply) => this.answer(reply)),
    ];
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const [id, entry] of [...this.pending]) this.settle(id, entry, new WorkforceError('unavailable', 'Autark is shutting down.'));
  }

  /** True when an app phone with this serial (device id) is attached. */
  has(serial: string | undefined): boolean { return Boolean(serial && this.attached.has(serial)); }

  /** The attached app phones' serials. */
  serials(): string[] { return [...this.attached.keys()]; }

  async available(): Promise<boolean> { return this.attached.size > 0; }

  async devices(): Promise<PhoneDevice[]> {
    const names = new Map(this.deps.devices().map((device) => [device.id, device.name]));
    return [...this.attached].map(([serial, entry]) => ({
      serial, state: entry.ready ? 'device' : 'phone use off', model: entry.model ?? names.get(serial), transport: 'autark-app',
    }));
  }

  async screenshot(serial?: string, step?: PhoneStepOptions): Promise<PhoneShot> {
    const device = this.pick(serial);
    const shot = await this.ask(device, 'screenshot', {}, step) as { data?: unknown; mime?: unknown; width?: unknown; height?: unknown; screen?: { width?: unknown; height?: unknown } };
    if (typeof shot?.data !== 'string') throw new WorkforceError('unavailable', 'The phone sent no screenshot (it needs Android 11 or newer).');
    const width = num(shot.width);
    const screen = { width: num(shot.screen?.width) || width, height: num(shot.screen?.height) || num(shot.height) };
    return {
      serial: device, data: Buffer.from(shot.data, 'base64'), mime: typeof shot.mime === 'string' ? shot.mime : 'image/jpeg',
      width, height: num(shot.height), scale: width ? screen.width / width : 1, screen,
    };
  }

  async uiTree(serial?: string, step?: PhoneStepOptions): Promise<PhoneTree> {
    const device = this.pick(serial);
    const tree = await this.ask(device, 'ui_tree', {}, step) as { nodes?: unknown; screen?: { width?: unknown; height?: unknown } };
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes.slice(0, 3000).map(safeNode) : [];
    const rendered = renderDump(nodes);
    const screen = tree?.screen && num(tree.screen.width) ? { width: num(tree.screen.width), height: num(tree.screen.height) } : screenOf(nodes);
    return { serial: device, text: rendered.text, count: rendered.count, truncated: rendered.truncated, nodes, ...(screen ? { screen } : {}) };
  }

  async tap(serial: string | undefined, x: number, y: number, step?: PhoneStepOptions): Promise<void> {
    await this.ask(this.pick(serial), 'tap', { x: Math.round(x), y: Math.round(y) }, step);
  }

  async swipe(serial: string | undefined, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 400, step?: PhoneStepOptions): Promise<void> {
    await this.ask(this.pick(serial), 'swipe', { x1: Math.round(from.x), y1: Math.round(from.y), x2: Math.round(to.x), y2: Math.round(to.y), durationMs }, step);
  }

  async type(serial: string | undefined, value: string, step?: PhoneStepOptions): Promise<void> {
    await this.ask(this.pick(serial), 'type', { text: value }, step);
  }

  async key(serial: string | undefined, name: string, step?: PhoneStepOptions): Promise<string> {
    const result = await this.ask(this.pick(serial), 'key', { key: name }, step) as { key?: unknown } | undefined;
    return typeof result?.key === 'string' ? result.key : name;
  }

  async open(serial: string | undefined, target: { url?: string; package?: string }, step?: PhoneStepOptions): Promise<string> {
    const result = await this.ask(this.pick(serial), 'open', { ...(target.url ? { url: target.url } : {}), ...(target.package ? { package: target.package } : {}) }, step) as { opened?: unknown } | undefined;
    return typeof result?.opened === 'string' ? result.opened : (target.url ?? target.package ?? '');
  }

  // ---------------------------------------------------------------- internals

  private pick(serial: string | undefined): string {
    if (serial) {
      if (!this.attached.has(serial)) throw new WorkforceError('not_found', `Phone ${serial} is not connected through the Autark app right now.`);
      return serial;
    }
    const all = this.serials();
    if (all.length === 1) return all[0];
    if (all.length > 1) throw new WorkforceError('conflict', `Several phones are connected (${all.join(', ')}); pass serial.`);
    throw new WorkforceError('unavailable', 'No phone is connected through the Autark app right now.');
  }

  /** One step on the phone: the request on the bus, its answer (or the timeout / the run's cancel). */
  private ask(deviceId: string, op: PhoneUseOp, args: Record<string, unknown>, step?: PhoneStepOptions): Promise<unknown> {
    if (step?.signal?.aborted) return Promise.reject(new WorkforceError('cancelled', 'Cancelled.'));
    const id = `pu_${randomBytes(8).toString('hex')}`;
    const timers = this.deps.timers ?? realTimers;
    return new Promise((resolve, reject) => {
      const entry: Pending = { deviceId, resolve, reject, timer: undefined };
      entry.timer = timers.set(() => this.settle(id, entry, new WorkforceError('timeout', 'The phone did not answer within 20 s (the app may be closed by the system, or the screen locked).')), this.deps.timeoutMs ?? APP_PHONE_TIMEOUT_MS);
      if (step?.signal) {
        const cancel = () => this.settle(id, entry, new WorkforceError('cancelled', 'Cancelled.'));
        step.signal.addEventListener('abort', cancel, { once: true });
        entry.off = () => step.signal?.removeEventListener('abort', cancel);
      }
      this.pending.set(id, entry);
      this.deps.bus.emit('phoneUse.request', { deviceId, id, op, args });
    });
  }

  private settle(id: string, entry: Pending, error?: Error, value?: unknown): void {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    (this.deps.timers ?? realTimers).clear(entry.timer);
    entry.off?.();
    if (error) entry.reject(error); else entry.resolve(value);
  }

  private answer(reply: PhoneUseReply & { deviceId: string }): void {
    const entry = this.pending.get(reply?.id);
    if (!entry || entry.deviceId !== reply.deviceId) return; // only the phone that was asked answers its request
    if (reply.error) {
      const code = reply.error.code === 'off' ? 'unavailable' : KNOWN.has(reply.error.code) ? reply.error.code : 'conflict';
      const message = reply.error.code === 'off' ? PHONE_USE_OFF : String(reply.error.message ?? 'The phone refused this step.').slice(0, 300);
      this.settle(reply.id, entry, new WorkforceError(code as ErrorCode, message));
      return;
    }
    this.settle(reply.id, entry, undefined, reply.result);
  }

  private attach(event: PhoneUseAttach & { deviceId: string; on: boolean }): void {
    const current = this.attached.get(event.deviceId);
    if (!event.on) {
      if (!current) return;
      current.sockets--;
      if (current.sockets > 0) return;
      this.attached.delete(event.deviceId);
      for (const [id, entry] of [...this.pending]) if (entry.deviceId === event.deviceId) this.settle(id, entry, new WorkforceError('unavailable', 'The phone went offline.'));
      return;
    }
    this.attached.set(event.deviceId, {
      model: event.model ?? current?.model, screen: event.screen ?? current?.screen, ready: event.ready ?? current?.ready ?? false, sockets: (current?.sockets ?? 0) + 1,
    });
  }
}

const str = (value: unknown, max = 300) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

/** One node of the phone's tree (apps/android phoneuse/ScreenTree) as uiautomator.ts renders it: order and parents checked. */
export function safeNode(value: unknown, index: number): PhoneNode {
  const node = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const parent = Number.isInteger(node.parent) && (node.parent as number) >= 0 && (node.parent as number) < index ? node.parent as number : -1;
  const b = Array.isArray(node.bounds) && node.bounds.length === 4 && node.bounds.every((n) => Number.isFinite(n)) ? node.bounds.map((n) => Math.round(n as number)) : undefined;
  const out: PhoneNode = { index, depth: Number.isInteger(node.depth) ? Math.max(0, node.depth as number) : 0, parent };
  const fields: Array<[keyof PhoneNode, unknown]> = [
    ['text', str(node.text)], ['desc', str(node.desc)], ['id', str(node.id, 200)], ['cls', str(node.cls, 80)], ['pkg', str(node.pkg, 200)],
    ['clickable', flag(node.clickable)], ['scrollable', flag(node.scrollable)], ['checkable', flag(node.checkable)], ['checked', flag(node.checked)],
    ['enabled', flag(node.enabled)], ['focused', flag(node.focused)], ['selected', flag(node.selected)], ['password', flag(node.password)],
  ];
  for (const [key, field] of fields) if (field !== undefined) (out as unknown as Record<string, unknown>)[key] = field;
  if (b && b[2] > b[0] && b[3] > b[1]) out.bounds = [b[0], b[1], b[2], b[3]];
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
