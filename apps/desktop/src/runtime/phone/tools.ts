// phone.* tools: operate an Android phone – B-078: the person's phone with the Autark app (phone use, no ADB: serial =
// its device id, phone/drivers.ts) or one connected to a PC over ADB (USB or wireless debugging) – and connect an ADB
// one: phone.pair with the 6-digit code from the phone's pairing dialog, phone.connect, phone.disconnect;
// phone.devices also lists phones nearby. Remote-capable – the phone hangs off whichever PC it is paired with. The skills
// phone-access (the app) and phone-adb (adb) say how each is set up. Every output of an action says to look again (no
// blind chains).
// Owns: schemas, summaries, output formatting. Never: repeats a pairing code in a summary or an output.

import type { ToolContext, ToolDef } from '../tools/types.ts';
import { failure, json, text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { imageOutput } from '../computer/tools.ts';
import { notConnected, pairThenConnect } from './connect.ts';
import { movingKey } from './adb-args.ts';
import { typedText } from '../secrets/handles.ts';
import type { PhoneDriver, PhoneStepOptions, PhoneWireless } from './driver.ts';

type Phone = PhoneDriver & PhoneWireless;

const SERIAL = { type: 'string', maxLength: 120, description: 'device serial from phone.devices (only needed with several phones)' };
const VERIFY = 'Not verified – I read phone.ui_tree before the next step.';
const ADDRESS = { type: 'string', minLength: 3, maxLength: 260, description: 'host:port shown on the phone, e.g. 192.168.1.20:37099' };
const short = (value: unknown) => String(value ?? '').slice(0, 80);

const where = (ctx: ToolContext) => ctx.deviceId ?? 'this PC';
const phone = (summary: string, ctx: ToolContext, reversible: boolean) => ({ summary, resource: where(ctx), reversible, external: false });

export function phoneTools(adb: Phone): ToolDef[] {
  const step = (ctx: ToolContext): PhoneStepOptions => ({ signal: ctx.signal });

  const devices = defineTool<Record<string, never>>({
    name: 'phone.devices',
    description: "The Android phones I can use from this PC: the person's phone with the Autark app (phone use, no ADB – state 'phone use off' until they turn it on), phones over ADB (USB or wireless debugging) with their state, and phones nearby that offer ADB pairing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => phone('List connected phones', ctx, true),
    async run() {
      if (!(await adb.available())) return text("No phone is connected: the Autark app on the person's phone is not connected to this PC right now, and adb is not installed here (skill phone-access for the app; skill phone-adb: winget install Google.PlatformTools).");
      const list = await adb.devices();
      const nearby = notConnected(await adb.discover().catch(() => []), list);
      const lines = list.map((d) => `- ${d.serial} · ${d.state}${d.model ? ` · ${d.model}` : ''}`);
      const near = nearby.map((n) => `- ${n.address} · ${n.service === 'pairing' ? 'pairing dialog open (phone.pair with the code shown there)' : 'paired phone ready to connect (phone.connect)'}`);
      if (!lines.length && !near.length) return text("No phone is connected. The person's phone joins with the Autark app (skill phone-access); another one with wireless debugging (skill phone-adb, then phone.pair).");
      const body = [lines.length ? lines.join('\n') : 'No phone is connected.', near.length ? `Nearby:\n${near.join('\n')}` : ''].filter(Boolean).join('\n');
      return { ...text(body), structured: { devices: list, nearby } };
    },
  });

  const pair = defineTool<{ address: string; code: string; connect?: string }>({
    name: 'phone.pair',
    description: "Pair an Android phone over wireless debugging: the IP address:port and 6-digit code from the phone's \"Pair device with pairing code\" dialog, then connect (connect = the address under Wireless debugging, else found nearby).",
    inputSchema: {
      type: 'object',
      properties: { address: ADDRESS, code: { type: 'string', minLength: 6, maxLength: 20, description: 'the 6-digit pairing code' }, connect: ADDRESS },
      required: ['address', 'code'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    // A pairing leaves a lasting trust on the phone that only the phone can undo.
    describe: (args, ctx) => phone(`Pair the Android phone at ${short(args.address)} with ${where(ctx)}`, ctx, false),
    async run(args, ctx) {
      ctx.status('pairing the phone');
      const result = await pairThenConnect(adb, args);
      if (result.connected) return text(`Paired with ${result.paired} and connected to ${result.connected}. phone.devices shows the phone as "device" once it is ready.`);
      return text(`Paired with ${result.paired}, not connected yet: ${result.connectError ?? 'no connect port known'} Then call phone.connect.`);
    },
  });

  const connect = defineTool<{ address: string }>({
    name: 'phone.connect',
    description: 'Connect to an already paired Android phone over wireless debugging (the IP address:port shown under Wireless debugging; it changes after a restart).',
    inputSchema: { type: 'object', properties: { address: ADDRESS }, required: ['address'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Connect to the Android phone at ${short(args.address)} from ${where(ctx)}`, ctx, false), // any host:port
    async run(args, ctx) {
      ctx.status('connecting to the phone');
      const result = await adb.connect(args.address);
      const state = (await adb.devices().catch(() => [])).find((device) => device.serial === result.address)?.state;
      const hint = state === 'unauthorized' ? ' The phone waits for the person to unlock it and allow this PC.' : state && state !== 'device' ? ' Reconnect or pair again.' : '';
      return text(`${result.already ? 'Already connected to' : 'Connected to'} ${result.address}${state ? ` (state: ${state})` : ''}.${hint}`);
    },
  });

  const disconnect = defineTool<{ serial: string }>({
    name: 'phone.disconnect',
    description: 'Disconnect a phone on wireless debugging (its serial from phone.devices, e.g. 192.168.1.20:37099) – when the task on the phone is done.',
    inputSchema: { type: 'object', properties: { serial: { ...SERIAL, minLength: 3, description: 'serial of a wireless phone from phone.devices' } }, required: ['serial'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Disconnect the Android phone ${short(args.serial)} from ${where(ctx)}`, ctx, true),
    async run(args) {
      const result = await adb.disconnect(args.serial);
      // adb's answer is not the truth for every serial (an mDNS-connected phone): the list is.
      const listed = (await adb.devices().catch(() => undefined))?.some((device) => device.serial.replace(/\.$/, '') === result.serial.replace(/\.$/, ''));
      if (listed) return text(`${result.serial} is still connected (adb did not disconnect it). The person can turn wireless debugging off on the phone.`);
      return text(result.was ? `Disconnected ${result.serial}. The person can turn wireless debugging off on the phone.` : `${result.serial} was not connected.`);
    },
  });

  const screenshot = defineTool<{ serial?: string }>({
    name: 'phone.screenshot',
    description: 'Screenshot of the phone screen (downscaled; the text gives the factor to phone pixels). Prefer phone.ui_tree to find elements.',
    inputSchema: { type: 'object', properties: { serial: SERIAL }, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => phone('Screenshot of the phone', ctx, true),
    async run(args, ctx) {
      ctx.status('looking at the phone');
      const shot = await adb.screenshot(args.serial, step(ctx));
      return imageOutput(shot, `Phone ${shot.serial} screen ${shot.screen.width}×${shot.screen.height}; image ${shot.width}×${shot.height} (1 image pixel = ${Math.round(shot.scale * 1000) / 1000} phone pixels). Tap with phone pixels.`);
    },
  });

  const uiTree = defineTool<{ serial?: string }>({
    name: 'phone.ui_tree',
    description: 'Elements on the phone screen (uiautomator): class, text, description, id, tap/scroll ability and the centre point to tap.',
    inputSchema: { type: 'object', properties: { serial: SERIAL }, additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (_args, ctx) => phone('Read the phone screen', ctx, true),
    async run(args, ctx) {
      ctx.status('reading the phone screen');
      const tree = await adb.uiTree(args.serial, step(ctx));
      const head = `Phone ${tree.serial}${tree.screen ? ` · ${tree.screen.width}×${tree.screen.height}` : ''} · ${tree.count} elements${tree.truncated ? ' (truncated)' : ''}. Format: class "text" (description) #id (actions) @x,y`;
      return text(`${head}\n${tree.text || '(nothing readable – the app may draw its own UI; phone.screenshot shows it)'}`);
    },
  });

  const tap = defineTool<{ x: number; y: number; serial?: string }>({
    name: 'phone.tap',
    description: 'Tap at phone pixel coordinates (use the @x,y of an element from phone.ui_tree).',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, serial: SERIAL }, required: ['x', 'y'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Tap the phone at ${args.x},${args.y}`, ctx, false),
    async run(args, ctx) {
      ctx.status('tapping on the phone');
      await adb.tap(args.serial, args.x, args.y, step(ctx));
      return text(`Tapped ${Math.round(args.x)},${Math.round(args.y)}. ${VERIFY}`);
    },
  });

  const swipe = defineTool<{ x1: number; y1: number; x2: number; y2: number; durationMs?: number; serial?: string }>({
    name: 'phone.swipe',
    description: 'Swipe on the phone (scroll a list: from lower to upper point, 300–500 ms). Through the Autark app the path is a light curve with a little jitter, like a finger.',
    inputSchema: {
      type: 'object',
      properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, durationMs: { type: 'integer', minimum: 50, maximum: 10_000 }, serial: SERIAL },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Swipe on the phone from ${args.x1},${args.y1} to ${args.x2},${args.y2}`, ctx, false), // swipe-to-delete, swipe-to-confirm
    async run(args, ctx) {
      await adb.swipe(args.serial, { x: args.x1, y: args.y1 }, { x: args.x2, y: args.y2 }, args.durationMs, step(ctx));
      return text(`Swiped. ${VERIFY}`);
    },
  });

  const type = defineTool<{ text: string; serial?: string }>({
    name: 'phone.type',
    description: 'Type text into the focused field on the phone (tap the field first). Over ADB only ASCII; through the Autark app any text. Newlines press Enter.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 }, serial: SERIAL }, required: ['text'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Type ${args.text.length} characters on the phone`, ctx, false),
    async run(args, ctx) {
      ctx.status('typing on the phone');
      const typed = await typedText(ctx, args.text); // secret://<id> → the value, now (secrets/handles.ts)
      await adb.type(args.serial, typed.text, step(ctx));
      return text(`Typed ${args.text.length} characters. ${VERIFY}`);
    },
  });

  const key = defineTool<{ key: string; serial?: string }>({
    name: 'phone.key',
    description: 'Press a phone key: back, home, recents, enter, delete, tab, escape, up/down/left/right, page_up/page_down, wakeup.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 40 }, serial: SERIAL }, required: ['key'], additionalProperties: false },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Press ${short(args.key)} on the phone`, ctx, movingKey(args.key)),
    async run(args, ctx) {
      const code = await adb.key(args.serial, args.key, step(ctx));
      return text(`Pressed ${code}. ${VERIFY}`);
    },
  });

  const open = defineTool<{ url?: string; package?: string; serial?: string }>({
    name: 'phone.open',
    description: 'Open a link (http/https) or an installed app by package name (e.g. com.whatsapp) on the phone.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: 4000 }, package: { type: 'string', maxLength: 200 }, serial: SERIAL },
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => phone(`Open ${short(args.url ?? args.package)} on the phone`, ctx, false), // a link can start an action in an app
    async run(args, ctx) {
      if (!args.url && !args.package) return failure('Give url or package.');
      const opened = await adb.open(args.serial, { url: args.url, package: args.package }, step(ctx));
      return json({ opened, note: VERIFY });
    },
  });

  return [devices, pair, connect, disconnect, screenshot, uiTree, tap, swipe, type, key, open];
}
