// Phone use via ADB (USB or wireless debugging): the PhoneDriver (driver.ts) agents' phone.* tools use.
// Owns: finding adb (PATH, Android SDK and winget locations – adb-args.ts), command building with
// argument arrays, device selection (a named ready phone from an `adb devices` answer younger than
// REUSE_MS is not asked for again – no polling),
// screenshot (exec-out screencap -p, downscaled), the uiautomator tree, tap/swipe/text/keyevent with
// bounds validation, opening URLs/apps (a step's signal ends it before the next command), and
// wireless debugging: pair/connect/disconnect, nearby phones, phone info, USB to Wi-Fi (connect.ts).
// The test profile WORKFORCE_ADB=none (adbOverride) finds no adb anywhere.
// Never: runs adb through a shell on this PC, sends keys that lock or power off the phone,
// installs or uninstalls apps, or touches developer settings.

import { existsSync } from 'node:fs';
import os from 'node:os';
import type { Logger } from '../contracts.ts';
import type { CliId, Executable } from '../accounts/executables.ts';
import type { Supervisor } from '../system/supervisor.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { NearbyPhone } from '../../shared/model/phone.ts';
import { finite } from '../computer/geometry.ts';
import { isPng, pngSize, shrinkPng } from '../computer/png.ts';
import { parseDevices, parseDump, parseWmSize, renderDump, screenOf, type PhoneDevice } from './uiautomator.ts';
import { spawnAdb, type AdbExec, type ExecResult } from './adb-exec.ts';
import { connectPhone, disconnectPhone, discoverPhones, pairPhone, type AdbRun } from './connect.ts';
import { inputText, keycode, sdkCandidates, shQuote } from './adb-args.ts';
import type { PhoneDriver, PhoneShot, PhoneStepOptions, PhoneTree, PhoneWireless } from './driver.ts';

export type { AdbExec, ExecResult } from './adb-exec.ts';
export { inputText, keycode, sdkCandidates, shQuote } from './adb-args.ts';

/** AdbPhone deps for a test profile with WORKFORCE_ADB=none: no adb is found anywhere. */
export function adbOverride(env: NodeJS.ProcessEnv = process.env): Partial<AdbDeps> {
  return env.WORKFORCE_ADB === 'none' ? { finder: undefined, exists: () => false } : {};
}

export interface AdbDeps {
  supervisor?: Pick<Supervisor, 'spawn'>;
  /** The CLI finder (PATH and common dirs); SDK locations are checked here as well. */
  finder?: { find(id: CliId, options?: { force?: boolean }): Promise<Executable | null> };
  log: Logger;
  exec?: AdbExec; // tests inject a fake
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  home?: string;
  now?: () => number;
}

const DUMP_PATH = '/data/local/tmp/workforce-ui.xml';
const MAX_EDGE = 1600;
const REUSE_MS = 1000;

export class AdbPhone implements PhoneDriver, PhoneWireless {
  private readonly deps: AdbDeps;
  private adbPath: Promise<string | undefined> | undefined;
  /** Screen size per device; `exact` when taken from a dump/screenshot (current orientation). */
  private readonly sizes = new Map<string, { width: number; height: number; exact: boolean }>();
  private readonly runner: AdbRun = (args, options) => this.run(args, options);
  /** The last `adb devices` answer: a named ready phone in it is used without asking again for REUSE_MS. */
  private recent: { at: number; devices: PhoneDevice[] } | undefined;
  private readonly now: () => number;

  constructor(deps: AdbDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Is adb installed on this PC? */
  async available(): Promise<boolean> {
    return Boolean(await this.locate());
  }

  async devices(): Promise<PhoneDevice[]> {
    const result = await this.run(['devices', '-l'], { timeoutMs: 15_000 });
    const devices = parseDevices(text(result.stdout));
    this.recent = { at: this.now(), devices };
    return devices;
  }

  /** Wireless debugging (phone/connect.ts): pair with the dialog's host:port + 6-digit code, connect, disconnect. */
  pair(address: string, code: string): Promise<{ address: string; name?: string }> { return pairPhone(this.runner, address, code); }
  connect(address: string): Promise<{ address: string; already: boolean }> { return connectPhone(this.runner, address); }
  disconnect(serial: string): Promise<{ serial: string; was: boolean }> { this.recent = undefined; return disconnectPhone(this.runner, serial); }
  /** Phones announcing wireless debugging nearby (adb mdns services). */
  discover(): Promise<NearbyPhone[]> { return discoverPhones(this.runner); }

  async screenshot(serial?: string, step?: PhoneStepOptions): Promise<PhoneShot> {
    const device = await this.pick(serial);
    await this.admit(device, step, 'look');
    const result = await this.run(['-s', device, 'exec-out', 'screencap', '-p'], { timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024 });
    if (!isPng(result.stdout)) throw new WorkforceError('unavailable', 'The phone returned no screenshot (screen off, locked, or a protected app is open – those show black by design).');
    const size = pngSize(result.stdout)!;
    this.sizes.set(device, { ...size, exact: true });
    const small = shrinkPng(result.stdout, MAX_EDGE);
    const out = pngSize(small.data) ?? size;
    return { serial: device, data: small.data, mime: 'image/png', width: out.width, height: out.height, scale: small.scale, screen: size };
  }

  async uiTree(serial?: string, step?: PhoneStepOptions): Promise<PhoneTree> {
    const device = await this.pick(serial);
    await this.admit(device, step, 'look');
    const dump = await this.run(['-s', device, 'shell', 'uiautomator', 'dump', DUMP_PATH], { timeoutMs: 30_000, allowFailure: true });
    const message = `${text(dump.stdout)} ${dump.stderr}`;
    if (dump.code !== 0 || /ERROR|null root node|could not get idle state/i.test(message)) {
      throw new WorkforceError('unavailable', 'The phone could not dump its screen (it may be animating, locked or showing a protected app). Wait a moment and try again.');
    }
    const xml = text((await this.run(['-s', device, 'exec-out', 'cat', DUMP_PATH], { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024 })).stdout);
    if (!xml.includes('<hierarchy')) throw new WorkforceError('unavailable', 'The phone returned no UI tree.');
    const nodes = parseDump(xml);
    const screen = screenOf(nodes);
    if (screen) this.sizes.set(device, { ...screen, exact: true });
    const rendered = renderDump(nodes);
    return { serial: device, ...rendered, nodes, screen };
  }

  async tap(serial: string | undefined, x: number, y: number, step?: PhoneStepOptions): Promise<void> {
    const device = await this.pick(serial);
    const point = await this.checkPoint(device, x, y);
    await this.input(device, ['input', 'tap', String(point.x), String(point.y)], step);
  }

  async swipe(serial: string | undefined, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 400, step?: PhoneStepOptions): Promise<void> {
    const device = await this.pick(serial);
    const a = await this.checkPoint(device, from.x, from.y);
    const b = await this.checkPoint(device, to.x, to.y);
    const ms = Math.round(finite(durationMs, 'durationMs'));
    if (ms < 50 || ms > 10_000) throw new WorkforceError('bad_request', 'durationMs must be between 50 and 10000.');
    await this.input(device, ['input', 'swipe', String(a.x), String(a.y), String(b.x), String(b.y), String(ms)], step);
  }

  async type(serial: string | undefined, value: string, step?: PhoneStepOptions): Promise<void> {
    if (!value) throw new WorkforceError('bad_request', 'Nothing to type.');
    if (value.length > 2000) throw new WorkforceError('bad_request', 'Type at most 2000 characters at once.');
    const device = await this.pick(serial);
    const lines = value.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.input(device, ['input', 'text', inputText(lines[i])], step);
      if (i < lines.length - 1) await this.input(device, ['input', 'keyevent', 'KEYCODE_ENTER'], step);
    }
  }

  async key(serial: string | undefined, name: string, step?: PhoneStepOptions): Promise<string> {
    const device = await this.pick(serial);
    const code = keycode(name);
    await this.input(device, ['input', 'keyevent', code], step);
    return code;
  }

  async open(serial: string | undefined, target: { url?: string; package?: string }, step?: PhoneStepOptions): Promise<string> {
    const device = await this.pick(serial);
    if (target.url) {
      let url: URL;
      try { url = new URL(target.url); } catch { throw new WorkforceError('bad_request', 'Give a valid URL.'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new WorkforceError('bad_request', 'Only http and https links can be opened on the phone.');
      await this.input(device, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', shQuote(url.href)], step);
      return url.href;
    }
    const pkg = target.package?.trim() ?? '';
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) throw new WorkforceError('bad_request', 'Give a URL or an app package name like com.whatsapp.');
    await this.admit(device, step, 'input');
    const result = await this.run(['-s', device, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { timeoutMs: 20_000, allowFailure: true });
    if (/No activities found|monkey aborted/i.test(`${text(result.stdout)} ${result.stderr}`)) throw new WorkforceError('not_found', `The app ${pkg} is not installed or has no launcher screen.`);
    if (result.code !== 0) throw new WorkforceError('unavailable', `The app ${pkg} could not be opened.`);
    return pkg;
  }

  // ------------------------------------------------------------------ internals

  /** A stopped step sends nothing more. */
  private async admit(_device: string, step: PhoneStepOptions | undefined, _kind: 'look' | 'input'): Promise<void> {
    if (step?.signal?.aborted) throw step.signal.reason instanceof Error ? step.signal.reason : new WorkforceError('cancelled', 'The phone step was stopped.');
  }

  /** One input command (tap, swipe, text, key, link). */
  private async input(device: string, args: string[], step: PhoneStepOptions | undefined): Promise<ExecResult> {
    await this.admit(device, step, 'input');
    return this.shell(device, args);
  }

  /** The device to use: the given serial (must be ready), or the only connected one. */
  private async pick(serial: string | undefined): Promise<string> {
    // A probe lists the phones, then describes each ready one: no second `adb devices` per phone.
    const known = serial && this.recent && this.now() - this.recent.at < REUSE_MS ? this.recent.devices.find((d) => d.serial === serial && d.state === 'device') : undefined;
    if (known) return known.serial;
    const devices = await this.devices();
    if (serial) {
      const device = devices.find((candidate) => candidate.serial === serial);
      if (!device) throw new WorkforceError('not_found', `Phone ${serial} is not connected. Connected: ${devices.map((d) => d.serial).join(', ') || 'none'}.`);
      return ready(device);
    }
    const usable = devices.filter((device) => device.state === 'device');
    if (usable.length === 1) return usable[0].serial;
    if (usable.length > 1) throw new WorkforceError('conflict', `Several phones are connected (${usable.map((d) => `${d.serial}${d.model ? ` ${d.model}` : ''}`).join(', ')}); pass serial.`);
    if (devices.length) return ready(devices[0]);
    throw new WorkforceError('unavailable', 'No Android phone is connected over ADB. Pair one with wireless debugging (phone.pair, skill phone-adb), or connect it by USB with USB debugging on.');
  }

  /** Bounds validation: finite whole pixels on the phone's current screen. */
  private async checkPoint(device: string, x: number, y: number): Promise<{ x: number; y: number }> {
    const point = { x: Math.round(finite(x, 'x')), y: Math.round(finite(y, 'y')) };
    if (point.x < 0 || point.y < 0) throw new WorkforceError('bad_request', 'Phone coordinates start at 0,0 (top left).');
    let size = this.sizes.get(device);
    if (!size) {
      const result = await this.shell(device, ['wm', 'size']);
      const physical = parseWmSize(text(result.stdout));
      if (physical) { size = { ...physical, exact: false }; this.sizes.set(device, size); }
    }
    if (size) {
      // Without a dump/screenshot the orientation is unknown: accept the longer edge both ways.
      const maxX = size.exact ? size.width : Math.max(size.width, size.height);
      const maxY = size.exact ? size.height : Math.max(size.width, size.height);
      if (point.x >= maxX || point.y >= maxY) throw new WorkforceError('bad_request', `(${point.x}, ${point.y}) is outside the phone screen (${size.width}×${size.height}). Use coordinates from phone.ui_tree.`);
    }
    return point;
  }

  private shell(device: string, args: string[]): Promise<ExecResult> {
    return this.run(['-s', device, 'shell', ...args], { timeoutMs: 20_000 });
  }

  private async run(args: string[], options: { timeoutMs: number; maxBytes?: number; allowFailure?: boolean }): Promise<ExecResult> {
    const adb = await this.locate();
    if (!adb) throw new WorkforceError('unavailable', 'adb (Android platform tools) is not installed on this PC. Install "Android SDK Platform-Tools" (winget install Google.PlatformTools – skill phone-adb) and put adb on the PATH.');
    const exec: AdbExec = this.deps.exec ?? ((command, argv, opts) => spawnAdb(this.deps.supervisor, command, argv, opts));
    const result = await exec(adb, args, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes ?? 4 * 1024 * 1024 });
    if (result.code !== 0 && !(options.allowFailure && result.code !== null)) {
      const stderr = result.stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
      if (/unauthorized/i.test(stderr)) throw new WorkforceError('unavailable', 'The phone has not allowed this PC yet: unlock it and accept the "Allow USB debugging" prompt.');
      if (/device offline|no devices|not found/i.test(stderr)) throw new WorkforceError('unavailable', `The phone is not reachable (${stderr || 'offline'}). Reconnect wireless debugging.`);
      throw new WorkforceError('unavailable', `adb failed${stderr ? `: ${stderr}` : ''}.`);
    }
    return result;
  }

  private locate(): Promise<string | undefined> {
    this.adbPath ??= (async () => {
      try {
        const found = await this.deps.finder?.find('adb' as string as CliId); // the finder's lookup is generic over the name
        if (found) return found.command;
      } catch { /* fall through to SDK paths */ }
      const exists = this.deps.exists ?? ((file: string) => { try { return existsSync(file); } catch { return false; } });
      const candidates = sdkCandidates(this.deps.env ?? process.env, this.deps.platform ?? process.platform, this.deps.home ?? os.homedir());
      const hit = candidates.find((file) => exists(file));
      if (!hit) this.adbPath = undefined; // look again next time (the person may install it meanwhile)
      return hit;
    })();
    return this.adbPath;
  }
}

function ready(device: PhoneDevice): string {
  if (device.state === 'device') return device.serial;
  if (device.state === 'unauthorized') throw new WorkforceError('unavailable', `Phone ${device.serial} has not allowed this PC yet: unlock it and accept the debugging prompt.`);
  throw new WorkforceError('unavailable', `Phone ${device.serial} is ${device.state}. Reconnect it (wireless debugging ports change after a restart).`);
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
