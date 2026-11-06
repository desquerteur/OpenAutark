// LIVE (opt-in): the Windows computer-use helper against a disposable WinForms window this test
// opens itself (fixtures/cu-form.ps1, always on top, closes itself after 3 minutes) – no app or
// file of the person is touched. Reports how long each step took (test diagnostics – the
// numbers for the build log).
//   WORKFORCE_LIVE=1 – UI Automation only (window list, UI tree, set_value, invoke), window-scoped
//                      OCR and closing the window: no mouse or keyboard input.
//   WORKFORCE_LIVE=1 WORKFORCE_LIVE_COMPUTER=1 – also brings the window to the front, types into
//                      its field and clicks its button with the real keyboard and mouse (ask the
//                      person first: it moves their pointer).
//   WORKFORCE_LIVE=1 node --test test/live/computer-use.test.ts
// B-044: a second case lets the disposable window stand in for the Workforce app (its process
// in appPids) with "Mark" as a guarded control of a fake app-window check: the real helper refuses
// input on that window until the runtime cleared it, the guarded button refuses (UIA invoke, and
// with WORKFORCE_LIVE_COMPUTER=1 a real click), the text field stays operable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsHelper } from '../../src/runtime/computer/helper.ts';
import { ComputerService } from '../../src/runtime/computer/service.ts';
import { Supervisor } from '../../src/runtime/system/supervisor.ts';
import { MemoryLogger } from '../../src/runtime/system/log.ts';
import type { Host } from '../../src/runtime/host.ts';
import type { AppGuardQuery } from '../../src/shared/api/host-bridge.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const live = process.env.WORKFORCE_LIVE === '1' && process.platform === 'win32';
/** Real keyboard and mouse input only when the person agreed to it as well. */
const input = live && process.env.WORKFORCE_LIVE_COMPUTER === '1';

interface Win { hwnd: number; title: string; foreground?: boolean }
interface Node { rid: string; role: string; name?: string; value?: string; rect?: number[] }

/** Runs `step` and returns its result with the milliseconds it took. */
async function timed<T>(step: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await step();
  return [result, Math.round(performance.now() - started)];
}

test('computer use on a disposable window: UIA, OCR, close (keyboard and mouse with WORKFORCE_LIVE_COMPUTER=1)', { skip: !live, timeout: 120_000 }, async (t) => {
  const form = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'fixtures', 'cu-form.ps1')], { stdio: 'ignore' });
  const log = new MemoryLogger();
  const helper = new WindowsHelper({ supervisor: new Supervisor({ log }), scriptPath: path.join(root, 'resources', 'computer', 'windows-helper.ps1'), log, appPids: () => [process.pid] });
  t.after(async () => { await helper.dispose(); form.kill(); });

  const findWin = async (prefix: string): Promise<Win> => {
    for (let i = 0; i < 40; i++) {
      const found = (await helper.call<Win[]>('windows', {}, { timeoutMs: 60_000 })).find((w) => w.title?.startsWith(prefix));
      if (found) return found;
      await delay(500);
    }
    throw new Error(`window "${prefix}" did not appear`);
  };
  const nodes = async (hwnd: number) => (await helper.call<{ nodes: Node[] }>('tree', { hwnd, depth: 4, max: 80 })).nodes;
  const numbers: string[] = [];

  // The first call starts the helper; the window may still be opening.
  const [win, findMs] = await timed(() => findWin('WF-CU-Check'));
  numbers.push(`helper start + window ${findMs} ms`);
  const [tree, treeMs] = await timed(() => nodes(win.hwnd));
  numbers.push(`UI tree ${treeMs} ms (${tree.length} nodes)`);
  const edit = tree.find((n) => n.role === 'edit');
  const button = tree.find((n) => n.role === 'button' && n.name === 'Mark');
  assert.ok(edit && button, 'the UI tree exposes the text field and the button');

  // Semantic actions through UI Automation patterns: no mouse or keyboard input.
  const [, setMs] = await timed(() => helper.call('act', { hwnd: win.hwnd, rid: edit.rid, action: 'set_value', value: 'hello from workforce' }));
  const [, invokeMs] = await timed(() => helper.call('act', { hwnd: win.hwnd, rid: button.rid, action: 'invoke' }));
  numbers.push(`set_value ${setMs} ms`, `invoke ${invokeMs} ms`);
  assert.equal((await findWin('Done ')).title, 'Done 1: hello from workforce');

  await t.test('keyboard and mouse into the disposable window', { skip: input ? false : 'moves the real mouse and keyboard: set WORKFORCE_LIVE_COMPUTER=1 as well' }, async () => {
    // Keyboard into the focused field.
    await helper.call('focus_window', { hwnd: win.hwnd });
    await helper.call('act', { hwnd: win.hwnd, rid: edit.rid, action: 'focus' });
    const [, typeMs] = await timed(() => helper.call('type', { text: ' typed' }));
    assert.match((await nodes(win.hwnd)).find((n) => n.role === 'edit')?.value ?? '', /typed/);

    // Mouse click at the button's centre (input is delivered asynchronously).
    const rect = (await nodes(win.hwnd)).find((n) => n.role === 'button' && n.name === 'Mark')!.rect!;
    const [, clickMs] = await timed(() => helper.call('click', { x: Math.round(rect[0] + rect[2] / 2), y: Math.round(rect[1] + rect[3] / 2) }));
    await delay(400);
    assert.match((await findWin('Done ')).title, /^Done 2: .*typed/);
    numbers.push(`type ${typeMs} ms`, `click ${clickMs} ms`);
  });

  // OCR of just this window returns a list of lines (regression: PSObject-wrapped list).
  const [ocr, ocrMs] = await timed(() => helper.call<{ lines?: unknown }>('ocr', { hwnd: win.hwnd }, { timeoutMs: 40_000 }));
  assert.ok(Array.isArray(ocr.lines), 'OCR lines are a JSON list');
  const lines = ocr.lines as Array<{ text: string }>;
  assert.ok(lines.some((line) => /Marked/.test(line.text)), 'OCR reads the window text');
  numbers.push(`OCR ${ocrMs} ms (${lines.length} lines)`);

  const done = await findWin('Done ');
  const top = (await helper.call<{ nodes: Node[] }>('tree', { hwnd: done.hwnd, depth: 0, max: 1 })).nodes[0];
  await helper.call('act', { hwnd: done.hwnd, rid: top.rid, action: 'window_close' });
  t.diagnostic(`computer-use live${input ? '' : ' (no keyboard/mouse)'}: ${numbers.join(', ')}`);
});

test('B-044: a guarded control of the app\'s own window refuses an agent, the rest of it stays operable (real click with WORKFORCE_LIVE_COMPUTER=1)', { skip: !live, timeout: 120_000 }, async (t) => {
  const form = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'fixtures', 'cu-form.ps1')], { stdio: 'ignore' });
  const log = new MemoryLogger();
  // The disposable window's process stands in for the Workforce app.
  const helper = new WindowsHelper({ supervisor: new Supervisor({ log }), scriptPath: path.join(root, 'resources', 'computer', 'windows-helper.ps1'), log, appPids: () => [form.pid!] });
  const asked: AppGuardQuery[] = [];
  let mark: [number, number, number, number] | undefined; // the "guarded" button's rectangle
  const onMark = (x: number, y: number) => mark !== undefined && x >= mark[0] && y >= mark[1] && x < mark[0] + mark[2] && y < mark[1] + mark[3];
  // A fake app-window check (main/app-guard.ts answers from the page in the app): "Mark" is guarded.
  const host = {
    kind: 'electron', encrypt: async () => new Uint8Array(), decrypt: async () => '', notify: async () => false,
    openExternal: async () => {}, openPath: async () => {}, onPower: () => () => {}, keepAwake: () => () => {},
    app: { version: '0.0.0', packaged: false, resourcesDir: root, dataDir: root, executable: process.execPath },
    async idleSeconds() { return 600; },
    async appGuard(query: AppGuardQuery) {
      asked.push(query);
      const rect = query.rect;
      const hit = (query.points ?? []).some((point) => onMark(point.x, point.y)) || (rect !== undefined && onMark(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2));
      return hit ? { target: 'page' as const, guarded: true, area: 'approvals', label: 'Mark' } : { target: 'page' as const, guarded: false };
    },
  } as Host;
  const computer = new ComputerService({ host, supervisor: { spawn: () => { throw new Error('the helper is injected'); } }, resourcesDir: path.join(root, 'resources'), log, helper, platform: 'win32' });
  t.after(async () => { await computer.dispose(); form.kill(); });

  let win: { hwnd: number; title: string; app: boolean } | undefined;
  for (let i = 0; i < 40 && !win; i++) {
    win = (await computer.windows()).find((w) => w.title.startsWith('WF-CU-Check'));
    if (!win) await delay(500);
  }
  assert.ok(win, 'the disposable window appeared');
  assert.equal(win.app, true, 'marked as the app\'s own window');
  const tree = await computer.uiTree({ window: win.hwnd, depth: 4 });
  const ref = (pattern: RegExp) => pattern.exec(tree.text)?.[1];
  const button = ref(/button "Mark" \[ref=(e\d+)\]/);
  const field = ref(/edit "Input" \[ref=(e\d+)\]/);
  assert.ok(button && field, tree.text);
  mark = computer.elementRect(button);
  assert.ok(mark, 'the button has a rectangle');

  // Element actions: the guarded button refuses, the field is set (the helper asked first both times).
  await assert.rejects(computer.act({ ref: button, action: 'invoke' }), /That control needs the person \(approvals: "Mark"\)/);
  assert.ok(asked.some((query) => query.window === win!.hwnd && query.rect !== undefined), 'asked with the app window and the element\'s rectangle');
  await computer.act({ ref: field, action: 'set_value', value: 'checked by the window' });
  const after = (await computer.windows()).find((w) => w.hwnd === win!.hwnd);
  assert.equal(after?.title, 'WF-CU-Check', 'the guarded button never ran');

  await t.test('a real click on the guarded button refuses, the field takes a click and text', { skip: input ? false : 'moves the real mouse and keyboard: set WORKFORCE_LIVE_COMPUTER=1 as well' }, async () => {
    await computer.focusWindow(win!.hwnd);
    const centre = { x: Math.round(mark![0] + mark![2] / 2), y: Math.round(mark![1] + mark![3] / 2) };
    await assert.rejects(computer.click(centre), /That control needs the person/);
    const box = computer.elementRect(field)!;
    await computer.click({ x: Math.round(box[0] + box[2] / 2), y: Math.round(box[1] + box[3] / 2) });
    await computer.type({ text: ' typed' });
    await delay(400);
    assert.equal((await computer.windows()).find((w) => w.hwnd === win!.hwnd)?.title, 'WF-CU-Check', 'still not marked');
    assert.ok(asked.some((query) => query.keyboard === true), 'keys into the app window were checked too');
  });
  await computer.act({ ref: ref(/window "WF-CU-Check" \[ref=(e\d+)\]/) ?? field, action: 'window_close' });
});
