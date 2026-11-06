// Computer use on this PC: screenshots, windows, the UI Automation tree, element actions and
// raw input – semantic first, pixels last, every action checked.
// Windows: everything goes through the persistent PowerShell helper (helper.ts); Linux (23.10.2026):
// the AT-SPI helper (computer/drivers.ts – element actions, input on X11 only); macOS: screenshots
// through the host only, control reports "unavailable" honestly.
// Owns: coordinate validation (Number.isFinite, screenshot→screen mapping), element refs (one table
// per agent), observation, and the live screen preview (also for linked PCs via DeviceService); the
// human-priority gate before every input action is pointer-input.ts (the judgement: presence.ts), an
// element step and act-and-verify element-act.ts (a refused element click runs as the element's own
// pattern action where that is the same step, quiet-actions.ts). MP7: every helper call goes through the activity hub
// (activity.ts – the person's Stop refuses and ends input ops). B-044: agents may operate the
// Workforce app's own window like any other.
// B-055: the raw pointer and keyboard steps, their human-priority gate and the motion of the
// pointer live in pointer-input.ts; one agent at a time holds mouse and keyboard (lease.ts), each
// agent has its own ref table (one counter: a ref names one agent's observation), windows remember
// the agent that last worked in them (window-memory.ts) and pointer moves are named pointers
// (screen-pointers.ts). A `caller` names the agent of a step; without one (internal calls) nothing
// is leased and the shared default table is used, exactly as before.
// Never: fights the human for mouse or keyboard, types through the clipboard, focuses windows
// unless asked, or retries an input action by itself (the guarded-control check is a refusal
// before anything was sent).

import type { Logger, RuntimeServices } from '../contracts.ts';
import type { Host } from '../host.ts';
import type { Supervisor } from '../system/supervisor.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { finite, toScreen, validPoint, type Point, type Rect, type ShotGeometry } from './geometry.ts';
import type { HelperClient } from './helper.ts';
import { createHelper, driverFor } from './drivers.ts';
import { forbiddenCombo, parseCombo } from './keys.ts';
import { helperShot, hostShot, type Screenshot } from './capture.ts';
import { parseNodes, RefTable, renderTree, type RefCounter } from './tree.ts';
import { bindComputerActivity, ComputerActivity } from './activity.ts';
import { PointerLease, type ComputerCaller } from './lease.ts';
import { WindowMemory } from './window-memory.ts';
import { ScreenPointers } from './screen-pointers.ts';
import { PointerInput, type PointerResult } from './pointer-input.ts';
import { elementAct, type ActInput, type ActResult } from './element-act.ts';
import type { MotionStyle } from '../../shared/model/pointer-motion.ts';

export interface ComputerDeps {
  host: Host;
  supervisor: Pick<Supervisor, 'spawn'>;
  resourcesDir: string;
  log: Logger;
  /** Late-bound services (linked-PC preview through DeviceService). */
  services?: () => RuntimeServices;
  helper?: HelperClient; // tests inject a fake
  platform?: NodeJS.Platform;
  now?: () => number;
}

export type { Screenshot } from './capture.ts';

export interface WindowInfo {
  hwnd: number;
  title: string;
  process: string;
  pid: number;
  rect?: [number, number, number, number];
  minimized: boolean;
  foreground: boolean;
  /** A window of the Workforce app itself. */
  app: boolean;
}

export interface ScreenInfo { index: number; x: number; y: number; width: number; height: number; primary: boolean; name: string }

export type { ActExpectation, ActResult, ElementAction } from './element-act.ts';

type TreeInput = { window?: number; depth?: number; maxNodes?: number; signal?: AbortSignal; caller?: ComputerCaller };
export interface UiTree { text: string; count: number; truncated: boolean; window: { hwnd: number; title: string }; shared?: string }

type Coords = 'screen' | 'screenshot';
/** Who takes a step and how the pointer travels (B-055). */
type Step = { caller?: ComputerCaller; motion?: MotionStyle; signal?: AbortSignal };

export { HUMAN_IDLE_SECONDS } from './presence.ts';
export type { PointerResult } from './pointer-input.ts';
const MAX_REF_TABLES = 16;

export class ComputerService {
  private readonly deps: ComputerDeps;
  private helperClient: HelperClient | undefined;
  private guarded: HelperClient | undefined;
  /** What agents do on this PC and the person's Stop latch (MP7). */
  readonly activity: ComputerActivity;
  /** B-055 Q10: one agent at a time holds mouse and keyboard on this PC. */
  readonly lease: PointerLease;
  readonly windowMemory: WindowMemory;
  private readonly pointers: ScreenPointers;
  private readonly input: PointerInput;
  private readonly refCounter: RefCounter = { next: 1 };
  private readonly refTables = new Map<string, RefTable>();
  private readonly shots = new Map<string, ShotGeometry>();

  constructor(deps: ComputerDeps) {
    this.deps = deps;
    this.helperClient = deps.helper;
    this.activity = new ComputerActivity({ now: () => this.now(), services: deps.services });
    this.windowMemory = new WindowMemory({ now: () => this.now() });
    this.lease = new PointerLease({ now: () => this.now(), titleOf: (hwnd) => this.windowMemory.titleOf(hwnd) });
    this.pointers = new ScreenPointers({ services: deps.services });
    this.input = new PointerInput({
      host: deps.host, helper: () => this.helper(), activity: this.activity, lease: this.lease, windows: this.windowMemory, pointers: this.pointers,
      now: () => this.now(), canControl: () => this.canControl(), requireControl: (feature) => this.requireWindows(feature),
    });
    try { const services = deps.services?.(); if (services) bindComputerActivity(services, this.activity); } catch { /* bound by registerDeviceHandlers */ }
  }

  /** One line per other pointer on this screen for `caller`'s result (the person, other agents); '' when nobody else is there. */
  othersLine(caller: ComputerCaller | undefined): string { return this.pointers.line(caller); }

  get platform(): NodeJS.Platform { return this.deps.platform ?? process.platform; }

  /** Can this PC be controlled (not just viewed)? A platform with a driver (computer/drivers.ts). */
  canControl(): boolean { return driverFor(this.platform) !== undefined; }
  /** Screenshots through the helper (Windows); elsewhere the host captures the screen. */
  private helperShots(): boolean { return this.platform === 'win32'; }

  async dispose(): Promise<void> {
    await this.helperClient?.dispose();
  }

  // ------------------------------------------------------------------ observe

  async screenshot(input: { display?: number; window?: number; region?: Rect; maxEdge?: number; quality?: number; ocr?: boolean; agentId?: string; signal?: AbortSignal } = {}): Promise<Screenshot> {
    const maxEdge = clampInt(input.maxEdge ?? 1600, 320, 2400);
    if (input.region) {
      for (const key of ['x', 'y', 'width', 'height'] as const) finite(input.region[key], `region.${key}`);
      if (!(input.region.width > 0) || !(input.region.height > 0)) throw new WorkforceError('bad_request', 'region needs a positive width and height.');
    }
    let shot: Screenshot | undefined;
    if (this.helperShots()) {
      try {
        shot = await helperShot(this.helper(), { ...input, maxEdge }, this.now());
      } catch (error) {
        if (!(error instanceof WorkforceError) || error.code !== 'unavailable' || input.window !== undefined || input.region || !this.deps.host.capture) throw error;
        this.deps.log.warn('helper screenshot failed, using the host capture', { error: error.message });
      }
    } else if (input.window !== undefined || input.region || input.ocr) {
      throw new WorkforceError('unavailable', `Window, region and text-recognition screenshots are only available on Windows for now (this PC runs ${platformName(this.platform)}).`);
    }
    shot ??= await hostShot(this.deps.host, input.display, maxEdge, this.now());
    if (input.agentId) this.remember(input.agentId, shot);
    return shot;
  }

  async screens(): Promise<ScreenInfo[]> {
    this.requireWindows('Listing screens');
    const list = await this.helper().call<unknown[]>('screens');
    return (Array.isArray(list) ? list : []).map((item) => item as ScreenInfo);
  }

  async windows(signal?: AbortSignal): Promise<WindowInfo[]> {
    this.requireWindows('Listing windows');
    const list = await this.helper().call<unknown[]>('windows', {}, { signal });
    const windows = (Array.isArray(list) ? list : []).map(parseWindow).filter((window): window is WindowInfo => Boolean(window));
    for (const window of windows) this.windowMemory.title(window.hwnd, window.title);
    return windows;
  }

  /** Brings a window to the front – a keyboard-focus step: it needs the pointer lease. */
  async focusWindow(hwnd: number, signal?: AbortSignal, caller?: ComputerCaller): Promise<{ focused: boolean; shared?: string }> {
    this.requireWindows('Focusing windows');
    const id = finite(hwnd, 'window');
    this.lease.check(caller);
    await this.guardHuman();
    const end = this.lease.begin(caller, id);
    try {
      const result = await this.helper().call<{ focused?: boolean }>('focus_window', { hwnd: id }, { signal });
      const shared = this.windowMemory.use(caller, id);
      return { focused: result?.focused === true, ...(shared ? { shared } : {}) };
    } finally { end(); }
  }

  async uiTree(input: TreeInput = {}): Promise<UiTree> {
    const tree = await this.readTree(input, this.refsOf(input.caller));
    this.windowMemory.title(tree.window.hwnd, tree.window.title);
    const shared = this.windowMemory.note(input.caller, tree.window.hwnd);
    return shared ? { ...tree, shared } : tree;
  }

  /** The rectangle (physical screen px) the caller's latest observation showed for a ref – element anchors (computer/anchors.ts). */
  elementRect(ref: string, caller?: ComputerCaller): [number, number, number, number] | undefined { return this.refsOf(caller).get(ref)?.rect; }

  /** The same read with throwaway refs (computer/pay-check.ts): each observed ref keeps the name and role act() expects. */
  windowText(input: TreeInput = {}): Promise<UiTree> { return this.readTree(input, new RefTable()); }

  async find(input: { window?: number; name?: string; automationId?: string; role?: string; max?: number; signal?: AbortSignal; caller?: ComputerCaller }): Promise<{ text: string; count: number; truncated: boolean }> {
    this.requireWindows('Finding elements');
    if (!input.name && !input.automationId && !input.role) throw new WorkforceError('bad_request', 'Give a name, automationId or role to search for.');
    const result = await this.helper().call<{ hwnd: number; nodes: unknown; truncated?: boolean }>('find', {
      hwnd: input.window, name: input.name, aid: input.automationId, role: input.role?.toLowerCase(), max: clampInt(input.max ?? 20, 1, 100),
    }, { timeoutMs: 40_000, signal: input.signal });
    const hwnd = windowId(result?.hwnd, input.window);
    const nodes = parseNodes(result?.nodes).map((node) => ({ ...node, d: 0, p: -1 }));
    const refs = this.refsOf(input.caller);
    const lines = nodes.map((node) => renderTree([node], hwnd, refs).text);
    return { text: lines.join('\n'), count: lines.length, truncated: result?.truncated === true };
  }

  // ------------------------------------------------------------------ act (semantic)

  act(input: ActInput): Promise<ActResult> {
    this.requireWindows('Element actions');
    return elementAct({
      helper: () => this.helper(), input: this.input, lease: this.lease, windows: this.windowMemory,
      refs: (caller) => this.refsOf(caller), listWindows: (signal) => this.windows(signal),
    }, input);
  }

  // ------------------------------------------------------------------ act (raw input, pointer-input.ts)

  async click(input: { x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number; coords?: Coords; agentId?: string; targetSize?: number } & Step): Promise<PointerResult> {
    const point = this.point(input.x, input.y, input.coords, input.agentId);
    return this.input.click(point, { ...input, count: clampInt(input.count ?? 1, 1, 3) });
  }

  async move(input: { x: number; y: number; coords?: Coords; agentId?: string } & Step): Promise<PointerResult> {
    return this.input.move(this.point(input.x, input.y, input.coords, input.agentId), input);
  }

  async drag(input: { x1: number; y1: number; x2: number; y2: number; durationMs?: number; button?: 'left' | 'right' | 'middle'; coords?: Coords; agentId?: string } & Step): Promise<{ from: Point; to: Point; window?: number; shared?: string }> {
    const from = this.point(input.x1, input.y1, input.coords, input.agentId, ['x1', 'y1']);
    const to = this.point(input.x2, input.y2, input.coords, input.agentId, ['x2', 'y2']);
    const durationMs = input.durationMs === undefined ? undefined : clampInt(input.durationMs, 50, 10_000);
    const result = await this.input.drag(from, to, { ...input, durationMs });
    return { from, to, ...(result.window ? { window: result.window } : {}), ...(result.shared ? { shared: result.shared } : {}) };
  }

  async scroll(input: { x?: number; y?: number; dx?: number; dy?: number; coords?: Coords; agentId?: string } & Step): Promise<PointerResult | undefined> {
    const dx = Math.round(finite(input.dx ?? 0, 'dx'));
    const dy = Math.round(finite(input.dy ?? 0, 'dy'));
    if (!dx && !dy) throw new WorkforceError('bad_request', 'Scroll by at least one step (dy > 0 scrolls down).');
    if (Math.abs(dx) > 50 || Math.abs(dy) > 50) throw new WorkforceError('bad_request', 'Scroll at most 50 steps at once, then re-observe.');
    if ((input.x === undefined) !== (input.y === undefined)) throw new WorkforceError('bad_request', 'Give both x and y, or neither.');
    const point = input.x !== undefined ? this.point(input.x, input.y, input.coords, input.agentId) : undefined;
    return this.input.scroll(point, dx, dy, input);
  }

  async type(input: { text: string } & Step): Promise<number> {
    if (typeof input.text !== 'string' || !input.text) throw new WorkforceError('bad_request', 'Nothing to type.');
    if (input.text.length > 5000) throw new WorkforceError('bad_request', 'Type at most 5000 characters at once (set long text with computer.act set_value).');
    await this.input.type(input.text, input);
    return input.text.length;
  }

  async key(input: { combo: string; repeat?: number } & Step): Promise<number[]> {
    const vks = parseCombo(input.combo);
    const refused = forbiddenCombo(vks);
    if (refused) throw new WorkforceError('forbidden', refused);
    const repeat = clampInt(input.repeat ?? 1, 1, 50);
    await this.input.key(vks, repeat, input);
    return vks;
  }

  /** Human priority before a pointer or keyboard step (pointer-input.ts). */
  guardHuman(): Promise<void> { return this.input.guardHuman(); }

  // ------------------------------------------------------------------ preview (UI)

  /** Live screen image for the UI: this PC, or a linked PC through its runtime. */
  async preview(input: { deviceId?: string; display?: number }): Promise<{ dataUrl: string; width: number; height: number; at: number }> {
    const services = this.deps.services?.();
    if (input.deviceId && services) {
      let selfId: string | undefined;
      try { selfId = services.devices.self().id; } catch { selfId = undefined; }
      if (input.deviceId !== selfId) {
        const result = await services.devices.call(input.deviceId, 'computer.preview', { display: input.display });
        return parsePreview(result);
      }
    }
    const shot = await this.previewShot(input.display);
    return { dataUrl: `data:${shot.mime};base64,${Buffer.from(shot.data).toString('base64')}`, width: shot.width, height: shot.height, at: shot.at };
  }

  // ------------------------------------------------------------------ internals

  private async readTree(input: TreeInput, refs: RefTable): Promise<UiTree> {
    this.requireWindows('The UI Automation tree');
    const result = await this.helper().call<{ hwnd: number; title: string; nodes: unknown; truncated?: boolean }>('tree', {
      hwnd: input.window, depth: clampInt(input.depth ?? 12, 1, 40), maxNodes: clampInt(input.maxNodes ?? 400, 20, 2000),
    }, { timeoutMs: 40_000, signal: input.signal });
    const hwnd = windowId(result?.hwnd, input.window);
    const rendered = renderTree(parseNodes(result?.nodes), hwnd, refs);
    return { text: rendered.text, count: rendered.count, truncated: result?.truncated === true, window: { hwnd, title: typeof result?.title === 'string' ? result.title : '' } };
  }

  private helper(): HelperClient {
    this.helperClient ??= createHelper(this.platform, {
      supervisor: this.deps.supervisor, resourcesDir: this.deps.resourcesDir, log: this.deps.log, unpacked: unpackedPath,
    });
    this.guarded ??= this.activity.wrapHelper(this.helperClient);
    return this.guarded;
  }

  /** Time: injected (tests), else the runtime clock, else the system clock (before wiring). */
  private now(): number {
    if (this.deps.now) return this.deps.now();
    try { return this.deps.services?.().clock.now() ?? Date.now(); } catch { return Date.now(); }
  }

  private requireWindows(feature: string): void {
    if (this.canControl()) return;
    throw new WorkforceError('unavailable', `${feature} is only available on Windows and Linux for now (this PC runs ${platformName(this.platform)}). Screenshots work.`);
  }

  private point(x: unknown, y: unknown, coords: Coords | undefined, agentId: string | undefined, names: [string, string] = ['x', 'y']): Point {
    const point = validPoint(x, y, names);
    if (coords !== 'screenshot') return point;
    const shot = agentId ? this.shots.get(agentId) : undefined;
    if (!shot) throw new WorkforceError('bad_request', 'No screenshot yet: take computer.screenshot first, or pass screen coordinates.');
    return toScreen(point, shot);
  }

  /** The caller's own ref table (internal calls: the default one); at most MAX_REF_TABLES agents, the least recent dropped. */
  private refsOf(caller: ComputerCaller | undefined): RefTable {
    const key = caller?.key ?? '';
    let table = this.refTables.get(key);
    if (table) {
      this.refTables.delete(key);
    } else {
      table = new RefTable(4000, this.refCounter);
      if (this.refTables.size >= MAX_REF_TABLES) this.refTables.delete(this.refTables.keys().next().value as string);
    }
    this.refTables.set(key, table);
    return table;
  }

  private remember(agentId: string, shot: ShotGeometry): void {
    this.shots.delete(agentId);
    this.shots.set(agentId, { width: shot.width, height: shot.height, origin: shot.origin, scale: shot.scale });
    if (this.shots.size > 100) this.shots.delete(this.shots.keys().next().value as string);
  }

  /** Preview prefers the host capture (no extra process); the helper serves headless Windows PCs. */
  private async previewShot(display: number | undefined): Promise<Screenshot> {
    if (this.deps.host.capture) {
      // JPEG straight from the host: native encoding, no pixel work in the runtime (the UI scales it).
      try { return await hostShot(this.deps.host, display, 1280, this.now(), 'jpeg'); } catch (error) {
        if (!this.helperShots()) throw error;
      }
    }
    if (this.helperShots()) return helperShot(this.helper(), { display, maxEdge: 1280, quality: 60 }, this.now());
    throw new WorkforceError('unavailable', 'This PC has no screen to capture (headless runtime).');
  }
}

/** powershell.exe cannot read inside app.asar; the packaged build unpacks *.ps1 next to it. */
export function unpackedPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/** The window a tree/search answer belongs to (refs are keyed by it). */
function windowId(answered: unknown, asked: number | undefined): number {
  if (typeof answered === 'number' && Number.isFinite(answered)) return answered;
  return asked ?? 0;
}

function clampInt(value: number, min: number, max: number): number {
  const number = Math.round(finite(value, 'value'));
  return Math.min(max, Math.max(min, number));
}

function platformName(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
}

function parseWindow(value: unknown): WindowInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.hwnd !== 'number') return undefined;
  const rect = Array.isArray(item.rect) && item.rect.length === 4 ? item.rect as [number, number, number, number] : undefined;
  return {
    hwnd: item.hwnd, title: String(item.title ?? ''), process: String(item.process ?? ''), pid: Number(item.pid ?? 0), rect,
    minimized: item.minimized === true, foreground: item.foreground === true, app: item.app === true,
  };
}

function parsePreview(value: unknown): { dataUrl: string; width: number; height: number; at: number } {
  const item = (value ?? {}) as Record<string, unknown>;
  if (typeof item.dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(item.dataUrl)) {
    throw new WorkforceError('unavailable', 'The linked PC returned no screen image.');
  }
  return { dataUrl: item.dataUrl, width: Number(item.width) || 0, height: Number(item.height) || 0, at: Number(item.at) || Date.now() };
}
