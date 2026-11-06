// computer.* tools: what agents call to see and operate a PC (this one or a linked one – the
// registry forwards `remote` tools to ctx.deviceId). Thin adapters over ComputerService;
// computer.act (element steps) is computer/act-tool.ts.
// Owns: schemas, descriptions, action summaries for the run journal, which window and app each seen element
// belongs to (computer/seen.ts), output formatting (a UI tree carries `structured.app` when this PC knows the
// window's app, and computer.windows the list: the registry's app hints read them, knowledge/site-notes.ts).
// Never: hides that an action may have failed. Before a payment or a delete, look at the window again.
//
// Resource: the app (process name) the call works in: a ref's window, an explicit window id, or the window in
// front – as far as this PC's outputs showed them (computer.windows maps windows to apps; computer.ui_tree without
// a window and focus_window tell which one is in front). A step that can bring another window to the front
// (activating, closing, keys, coordinate clicks, drags, typing a newline) forgets the front window until the agent
// observes again. Unknown app, or a call for a linked PC → the PC itself.
//
// Precise pointer steps (23.10.2026, computer/anchors.ts): computer.drag from an element to another
// or by an exact offset, computer.scroll over an element – refs instead of guessed coordinates.
// The Workforce app itself (B-044) is operated like any app.
//
// B-055: each call names its caller (computer/lease.ts callerOf – an agent of a linked PC too), so
// the pointer lease, the agent's own refs and the window memory know who acts; the pointer tools take
// `motion` (computer/tool-notes.ts), and every result ends with who else points on this screen.

import type { ToolDef, ToolOutput } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { ComputerService, Screenshot, WindowInfo } from './service.ts';
import { deviceAction as device, labelWords, onThisPc, RefLabels, WindowApps } from './seen.ts';
import { actTool } from './act-tool.ts';
import { ANCHOR_SCHEMA, dragPoints, OFFSET_SCHEMA, resolveAnchor, type Anchor, type Offset } from './anchors.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { judgeTyped, typedText } from '../secrets/handles.ts';
import { callerOf } from './lease.ts';
import { lockedDesktop } from './broker.ts';
import { MOTION_ARG, withNotes, withOthers } from './tool-notes.ts';
import type { MotionStyle } from '../../shared/model/pointer-motion.ts';

export { idWords, onThisPc, RefLabels, WindowApps } from './seen.ts';

const COORDS = { type: 'string', enum: ['screen', 'screenshot'], description: "'screen' (default): physical screen pixels as in computer.ui_tree; 'screenshot': pixels of my last computer.screenshot." };
const BUTTON = { type: 'string', enum: ['left', 'right', 'middle'] };
const INT = { type: 'integer' };

export function imageOutput(shot: Pick<Screenshot, 'data' | 'mime'>, caption: string, structured?: unknown): ToolOutput {
  return {
    content: [
      { type: 'image', mime: shot.mime, dataBase64: Buffer.from(shot.data).toString('base64') },
      { type: 'text', text: caption },
    ],
    structured,
  };
}

export function windowLine(window: WindowInfo): string {
  const flags = [
    window.foreground ? '[foreground]' : '', window.minimized ? '[minimized]' : '', window.app ? '[Autark – this app]' : '',
  ].filter(Boolean).join(' ');
  const rect = window.rect ? ` · ${window.rect[0]},${window.rect[1]} ${window.rect[2]}x${window.rect[3]}` : '';
  return `- window ${window.hwnd} "${window.title}" · ${window.process || 'unknown'} (pid ${window.pid})${rect}${flags ? ` ${flags}` : ''}`;
}

export function computerTools(computer: ComputerService): ToolDef[] {
  const refLabels = new RefLabels();
  const apps = new WindowApps();
  const inFront = () => apps.app(apps.front);
  const forgetFront = () => { apps.front = undefined; };
  const screenshot = defineTool<{ display?: number; window?: number; region?: { x: number; y: number; width: number; height: number }; ocr?: boolean; maxEdge?: number }>({
    name: 'computer.screenshot',
    description: 'Screenshot of a screen, a window or a region (downscaled; the text says how image pixels map to screen pixels). Use when content is drawn (canvas, video, charts) – prefer computer.ui_tree for structure. ocr:true adds recognised text lines (Windows).',
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'integer', minimum: 0, maximum: 16, description: '0 = primary screen' },
        window: { ...INT, description: 'window id from computer.windows' },
        region: { type: 'object', properties: { x: INT, y: INT, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false },
        ocr: { type: 'boolean' },
        maxEdge: { type: 'integer', minimum: 320, maximum: 2400 },
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(args.window !== undefined ? 'Screenshot of a window' : 'Screenshot of the screen', ctx, true, args.window !== undefined ? apps.app(args.window) : undefined),
    async run(args, ctx) {
      ctx.status('looking at the screen');
      const shot = await computer.screenshot({ ...args, agentId: ctx.agent.id, signal: ctx.signal });
      const lines = [
        `Screenshot ${shot.width}×${shot.height} (${shot.source}). Image pixel (0,0) = screen (${shot.origin.x},${shot.origin.y}); 1 image pixel = ${round(shot.scale)} screen pixels.`,
        'To click something seen here, pass its image pixel with coords:"screenshot", or use the screen coordinates from computer.ui_tree.',
      ];
      if (lockedDesktop()) lines.push('This is the Windows secure desktop (locked screen or UAC prompt). I reach it through the desktop broker with these same tools; on the sign-in screen "Sign-in options" leads to the password, which I type as its secret:// handle.');
      if (shot.ocr?.length) {
        lines.push('Recognised text (screen coordinates x,y width×height):');
        for (const line of shot.ocr.slice(0, 300)) lines.push(`- "${line.text}" @${line.rect[0]},${line.rect[1]} ${line.rect[2]}×${line.rect[3]}`);
      } else if (args.ocr) {
        lines.push('No text recognised.');
      }
      return imageOutput(shot, lines.join('\n'), { width: shot.width, height: shot.height, origin: shot.origin, scale: shot.scale, ocr: shot.ocr });
    },
  });

  const windows = defineTool<Record<string, never>>({
    name: 'computer.windows',
    description: 'List the open windows (id, title, app, position, which one is in front). Start here, then read a window with computer.ui_tree.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => device('List open windows', ctx),
    async run(_args, ctx) {
      const list = await computer.windows(ctx.signal);
      if (onThisPc(ctx)) apps.learn(list);
      if (!list.length) return text('No visible windows.');
      return { ...text(list.map(windowLine).join('\n')), structured: list };
    },
  });

  const uiTree = defineTool<{ window?: number; depth?: number; maxNodes?: number; name?: string; automationId?: string; role?: string }>({
    name: 'computer.ui_tree',
    description: 'Read the UI Automation tree of a window (default: the window in front): role, name, value, state, supported actions, centre point and a ref per element. With name/automationId/role it searches the window instead. Refs are used by computer.act.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { ...INT, description: 'window id from computer.windows' },
        depth: { type: 'integer', minimum: 1, maximum: 40 },
        maxNodes: { type: 'integer', minimum: 20, maximum: 2000 },
        name: { type: 'string', maxLength: 200, description: 'search: name contains (case-insensitive)' },
        automationId: { type: 'string', maxLength: 200 },
        role: { type: 'string', maxLength: 40, description: 'search: control type, e.g. button, edit, menuitem, listitem' },
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(args.name || args.automationId || args.role ? 'Search a window\'s UI elements' : 'Read a window\'s UI elements', ctx, true, apps.app(args.window ?? apps.front)),
    async run(args, ctx) {
      ctx.status('reading the window');
      if (args.name || args.automationId || args.role) {
        const found = await computer.find({ window: args.window, name: args.name, automationId: args.automationId, role: args.role, signal: ctx.signal, caller: callerOf(ctx) });
        refLabels.learn(found.text, args.window ?? apps.front);
        return text(found.count ? `${found.count} match${found.count === 1 ? '' : 'es'}${found.truncated ? ' (search stopped early)' : ''}:\n${found.text}` : 'No matching element. Read the whole tree or check the window.');
      }
      const tree = await computer.uiTree({ window: args.window, depth: args.depth, maxNodes: args.maxNodes, signal: ctx.signal, caller: callerOf(ctx) });
      refLabels.learn(tree.text, tree.window.hwnd);
      if (args.window === undefined && onThisPc(ctx)) apps.front = tree.window.hwnd;
      const head = `Window ${tree.window.hwnd} "${tree.window.title}" · ${tree.count} elements${tree.truncated ? ' (truncated – raise maxNodes or search by name/role)' : ''}. Format: role "name" [ref] #automationId = value [state] (actions) @centre-x,centre-y`;
      return withNotes({ ...text(`${head}\n${tree.text}`), structured: { window: tree.window.hwnd, app: apps.app(tree.window.hwnd) } }, tree.shared);
    },
  });

  const act = actTool(computer, refLabels, apps);

  const click = defineTool<{ x: number; y: number; button?: 'left' | 'right' | 'middle' | 'none'; count?: number; coords?: 'screen' | 'screenshot'; motion?: MotionStyle }>({
    name: 'computer.click',
    description: 'Click at a point (last resort – prefer computer.act on a ref). button "none" only moves the pointer (hover). count 2 = double-click. Re-observe afterwards.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle', 'none'] }, count: { type: 'integer', minimum: 1, maximum: 3 }, coords: COORDS, motion: MOTION_ARG },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(`${args.button === 'none' ? 'Move the pointer to' : 'Click at'} ${args.x},${args.y}`, ctx, args.button === 'none', inFront()),
    async run(args, ctx) {
      if (args.button !== 'none') forgetFront();
      const step = { coords: args.coords, agentId: ctx.agent.id, signal: ctx.signal, caller: callerOf(ctx), motion: args.motion };
      if (args.button === 'none') {
        const point = await computer.move({ x: args.x, y: args.y, ...step });
        return withNotes(text(`Pointer at screen ${point.x},${point.y}.`), point.shared);
      }
      ctx.status('clicking');
      const point = await computer.click({ x: args.x, y: args.y, button: args.button, count: args.count, ...step });
      return withNotes(text(`Clicked ${args.button ?? 'left'}${args.count && args.count > 1 ? ` ×${args.count}` : ''} at screen ${point.x},${point.y}. Not verified – observe the result.`), point.shared);
    },
  });

  const type = defineTool<{ text: string; ref?: string }>({
    name: 'computer.type',
    description: 'Type text with the keyboard into the focused element (or focus ref first). Newlines press Enter. No clipboard is used. For whole field values prefer computer.act set_value.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 5000 }, ref: { type: 'string', maxLength: 20 } }, required: ['text'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => {
      const label = args.ref && onThisPc(ctx) ? refLabels.get(args.ref) : undefined;
      const action = device(`Type ${args.text.length} characters${args.ref ? ` into ${args.ref}` : ''}`, ctx, false, apps.app(args.ref ? refLabels.window(args.ref) : apps.front));
      return judgeTyped(ctx, action, args.text);
    },
    async run(args, ctx) {
      if (args.text.includes('\n')) forgetFront();
      if (args.ref) await computer.act({ ref: args.ref, action: 'focus', signal: ctx.signal, caller: callerOf(ctx) });
      ctx.status('typing');
      const typed = await typedText(ctx, args.text); // secret://<id> → the value, now (secrets/handles.ts)
      const count = await computer.type({ text: typed.text, signal: ctx.signal, caller: callerOf(ctx) });
      return text(`Typed ${count} characters. I check the field before the next step.`);
    },
  });

  const key = defineTool<{ keys: string; repeat?: number }>({
    name: 'computer.key',
    description: 'Press a key or shortcut in the window in front, e.g. "enter", "esc", "tab", "ctrl+s", "alt+f4", "ctrl+shift+t", "down".',
    inputSchema: { type: 'object', properties: { keys: { type: 'string', minLength: 1, maxLength: 40 }, repeat: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['keys'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(`Press ${args.keys}${args.repeat && args.repeat > 1 ? ` ×${args.repeat}` : ''}`, ctx, false, inFront()),
    async run(args, ctx) {
      forgetFront();
      await computer.key({ combo: args.keys, repeat: args.repeat, signal: ctx.signal, caller: callerOf(ctx) });
      return text(`Pressed ${args.keys}${args.repeat && args.repeat > 1 ? ` ×${args.repeat}` : ''}.`);
    },
  });

  const scroll = defineTool<{ dy?: number; dx?: number; x?: number; y?: number; coords?: 'screen' | 'screenshot'; at?: Anchor; motion?: MotionStyle }>({
    name: 'computer.scroll',
    description: 'Scroll with the mouse wheel over an element (at: a ref from computer.ui_tree, x/y = fraction inside it), at a point, or where the pointer is: dy > 0 scrolls down, dx > 0 right; one step = one wheel notch. For lists that support it, computer.act scroll / scroll_into_view is more precise.',
    inputSchema: {
      type: 'object',
      properties: { dy: { type: 'integer', minimum: -50, maximum: 50 }, dx: { type: 'integer', minimum: -50, maximum: 50 }, x: { type: 'number' }, y: { type: 'number' }, coords: COORDS, at: ANCHOR_SCHEMA, motion: MOTION_ARG },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(`Scroll ${args.dy ?? 0}/${args.dx ?? 0}${args.at ? ` over ${refLabels.get(args.at.ref) ?? args.at.ref}` : ''}`, ctx, true, inFront()),
    async run(args, ctx) {
      const { at, ...rest } = args;
      const caller = callerOf(ctx);
      const point = at ? resolveAnchor(at, (ref) => computer.elementRect(ref, caller)) : undefined;
      const done = await computer.scroll({ ...rest, ...(point ? { x: point.x, y: point.y, coords: 'screen' as const } : {}), agentId: ctx.agent.id, signal: ctx.signal, caller });
      return withNotes(text('Scrolled. Observe again to see what is visible now.'), done?.shared);
    },
  });

  type DragArgs = { x1?: number; y1?: number; x2?: number; y2?: number; from?: Anchor; to?: Anchor; by?: Offset; durationMs?: number; button?: 'left' | 'right' | 'middle'; coords?: 'screen' | 'screenshot'; motion?: MotionStyle };
  const dragWhat = (args: DragArgs) => (args.from
    ? `Drag ${refLabels.get(args.from.ref) ?? args.from.ref} ${args.to ? `onto ${refLabels.get(args.to.ref) ?? args.to.ref}` : `by ${args.by?.dx ?? 0},${args.by?.dy ?? 0} px`}`
    : `Drag from ${args.x1},${args.y1} to ${args.x2},${args.y2}`);
  const drag = defineTool<DragArgs>({
    name: 'computer.drag',
    description: 'Drag with a smooth motion (timelines, sliders, selections, moving items): precisely from an element to another (from/to: refs from computer.ui_tree, x/y = fraction inside the element, default its centre) or by an exact offset (from + by: dx/dy screen pixels), else between coordinates (x1,y1 → x2,y2). durationMs controls the speed. Verify the result.',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        from: ANCHOR_SCHEMA, to: ANCHOR_SCHEMA, by: OFFSET_SCHEMA,
        durationMs: { type: 'integer', minimum: 50, maximum: 10_000 }, button: BUTTON, coords: COORDS, motion: MOTION_ARG,
      },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => device(dragWhat(args), ctx, false, inFront()),
    async run(args, ctx) {
      const { from, to, by, ...rest } = args;
      const caller = callerOf(ctx);
      let points: { x1: number; y1: number; x2: number; y2: number; coords?: 'screen' | 'screenshot' };
      if (from) {
        if (!to === !by) throw new WorkforceError('bad_request', 'With from, give either to (an element) or by (dx, dy).');
        const resolved = dragPoints(from, (to ?? by)!, (ref) => computer.elementRect(ref, caller));
        points = { x1: resolved.from.x, y1: resolved.from.y, x2: resolved.to.x, y2: resolved.to.y, coords: 'screen' };
      } else {
        if (![rest.x1, rest.y1, rest.x2, rest.y2].every((value) => typeof value === 'number')) throw new WorkforceError('bad_request', 'Give from with to or by, or the coordinates x1, y1, x2, y2.');
        points = { x1: rest.x1!, y1: rest.y1!, x2: rest.x2!, y2: rest.y2!, coords: rest.coords };
      }
      forgetFront();
      ctx.status('dragging');
      const result = await computer.drag({ ...points, durationMs: rest.durationMs, button: rest.button, agentId: ctx.agent.id, signal: ctx.signal, caller, motion: rest.motion });
      return withNotes(text(`Dragged from screen ${result.from.x},${result.from.y} to ${result.to.x},${result.to.y}. Verify the result.`), result.shared);
    },
  });

  return withOthers([screenshot, windows, uiTree, act, click, type, key, scroll, drag], (caller) => computer.othersLine?.(caller) ?? '');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
