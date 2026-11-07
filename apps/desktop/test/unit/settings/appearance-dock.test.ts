// AF-010: settings.json › appearance.chatDock – where a chat's tabs dock and how large they are.
// - defaults (docked right, 480 px) for a fresh install and for a file written before the section existed;
// - save and load: an update lands in settings.json with a comment line above each key and survives a restart;
//   an edit on disk applies; a wrong value keeps the last good dock (and says why), the other sections apply;
// - the pure geometry: forgiving reads, the room the chat keeps, the floating window inside the chat, where a drop lands.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_SETTINGS } from '../../../src/runtime/root/layout.ts';
import {
  DEFAULT_CHAT_DOCK, chatDockOf, chatDockProblem, dockHeight, dockPlaceAt, dockWidth, fitFloat, previewBox,
} from '../../../src/shared/model/appearance.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

const env = { locale: 'en-US', timezone: 'Europe/Berlin' };

function setup() {
  const temp = tempDir('wf-appearance-dock-');
  const db = memoryDb();
  const file = path.join(temp.dir, ROOT_SETTINGS);
  const recorder = recordingBus();
  const time = clock();
  const root = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const make = () => new SettingsStore({ db, bus: recorder.bus, clock: time, env, dataDir: temp.dir, root });
  const settings = make();
  const text = () => readFileSync(file, 'utf8');
  const edit = (body: string) => { writeFileSync(file, body, 'utf8'); root.nudge(ROOT_SETTINGS); root.flush(ROOT_SETTINGS); };
  const done = () => { settings.close(); root.stop(); temp.cleanup(); };
  return { settings, make, file, text, edit, done };
}

test('a fresh install docks a chat\'s tabs right at 480 px, written into settings.json with its comments', () => {
  const { settings, text, done } = setup();
  try {
    assert.deepEqual(settings.get().appearance?.chatDock, DEFAULT_CHAT_DOCK);
    const written = text();
    assert.match(written, /\/\/ Look and layout \(Settings › Appearance\)/);
    assert.match(written, /\/\/ right or left of the messages, at the bottom or the top, or float = a window of its own over the chat\. Options: right \| left \| bottom \| top \| float\. Default: right/);
    assert.match(written, /"place": "right"/);
    assert.deepEqual((parseText(written).data as Record<string, Record<string, unknown>>).appearance.chatDock, DEFAULT_CHAT_DOCK);
  } finally { done(); }
});

test('the dock is saved and loaded: an update survives a restart, an edit on disk applies', () => {
  const { settings, make, text, edit, done } = setup();
  try {
    const dock = { place: 'bottom' as const, width: 520, height: 300, floatX: 10, floatY: 20, floatWidth: 600, floatHeight: 400 };
    settings.update({ appearance: { chatDock: dock } });
    assert.deepEqual((parseText(text()).data as Record<string, Record<string, unknown>>).appearance.chatDock, dock, 'in the file');
    settings.close();
    const again = make();
    assert.deepEqual(again.get().appearance?.chatDock, dock, 'after a restart');
    // a deep patch keeps the other keys
    assert.deepEqual(again.update({ appearance: { chatDock: { place: 'float' } as never } }).appearance?.chatDock, { ...dock, place: 'float' });
    // the person (or the AI) edits the file: floating at another box
    edit(text().replace('"floatX": 10', '"floatX": 240'));
    assert.equal(again.get().appearance?.chatDock.floatX, 240);
    again.close();
  } finally { done(); }
});

test('a wrong dock keeps the last good one; the rest of the file applies', () => {
  const { settings, text, edit, done } = setup();
  try {
    settings.update({ appearance: { chatDock: { ...DEFAULT_CHAT_DOCK, place: 'left' } } });
    assert.throws(() => settings.update({ appearance: { chatDock: { ...DEFAULT_CHAT_DOCK, place: 'middle' as never } } }), /appearance\.chatDock\.place/);
    assert.throws(() => settings.update({ appearance: { chatDock: { ...DEFAULT_CHAT_DOCK, width: 100 } } }), /appearance\.chatDock\.width/);
    assert.throws(() => settings.update({ appearance: { chatDock: { ...DEFAULT_CHAT_DOCK, extra: 1 } as never } }), /appearance\.chatDock\.extra/);
    edit(text().replace('"place": "left"', '"place": "sideways"').replace('"sidebarWidth": 288', '"sidebarWidth": 300'));
    assert.equal(settings.get().appearance?.chatDock.place, 'left', 'the last good dock stays');
    assert.equal(settings.get().preferences.sidebarWidth, 300, 'another section applies');
    assert.match(text(), /Not applied \(appearance\.chatDock\.place/, 'the reason above the section');
  } finally { done(); }
});

test('forgiving reads and the geometry the window uses', () => {
  assert.deepEqual(chatDockOf(undefined), DEFAULT_CHAT_DOCK, 'nothing set: the defaults');
  assert.deepEqual(chatDockOf({ place: 'top', width: 99999, height: 'x' }), { ...DEFAULT_CHAT_DOCK, place: 'top', width: 1600 }, 'clamped, unusable values take the default');
  assert.equal(chatDockProblem(DEFAULT_CHAT_DOCK), undefined);
  assert.deepEqual(chatDockProblem({ ...DEFAULT_CHAT_DOCK, height: 1.5 }), { path: 'chatDock.height', expected: 'a whole number from 140 to 1200' });

  assert.equal(dockWidth(480, 1100), 480, 'room enough: the saved width');
  assert.equal(dockWidth(900, 1100), 760, 'the chat keeps 340 px');
  assert.equal(dockWidth(480, 500), 240, 'never narrower than 240 px');
  assert.equal(dockHeight(320, 800), 320);
  assert.equal(dockHeight(700, 800), 560, 'the messages and the composer keep 240 px');

  const room = { width: 1000, height: 700 };
  assert.deepEqual(fitFloat({ floatX: 48, floatY: 48, floatWidth: 520, floatHeight: 420 }, room), { x: 48, y: 48, width: 520, height: 420 });
  assert.deepEqual(fitFloat({ floatX: 900, floatY: 650, floatWidth: 520, floatHeight: 420 }, room), { x: 480, y: 280, width: 520, height: 420 }, 'pushed back inside the chat');
  assert.deepEqual(fitFloat({ floatX: 0, floatY: 0, floatWidth: 2000, floatHeight: 1500 }, room), { x: 0, y: 0, width: 1000, height: 700 }, 'never larger than the chat');

  const rect = { x: 100, y: 50, width: 1000, height: 700 };
  assert.equal(dockPlaceAt({ x: 1090, y: 400 }, rect), 'right');
  assert.equal(dockPlaceAt({ x: 110, y: 400 }, rect), 'left');
  assert.equal(dockPlaceAt({ x: 600, y: 60 }, rect), 'top');
  assert.equal(dockPlaceAt({ x: 600, y: 740 }, rect), 'bottom');
  assert.equal(dockPlaceAt({ x: 600, y: 400 }, rect), 'float', 'the middle floats');
  assert.equal(dockPlaceAt({ x: 1095, y: 745 }, rect), 'right', 'a corner: the nearer edge by its band');
  assert.equal(dockPlaceAt({ x: 50, y: 400 }, rect), null, 'outside the chat: nowhere');

  const float = { x: 1, y: 2, width: 3, height: 4 };
  assert.deepEqual(previewBox('right', DEFAULT_CHAT_DOCK, room, float), { x: 520, y: 0, width: 480, height: 700 });
  assert.deepEqual(previewBox('bottom', DEFAULT_CHAT_DOCK, room, float), { x: 0, y: 380, width: 1000, height: 320 });
  assert.deepEqual(previewBox('float', DEFAULT_CHAT_DOCK, room, float), float);
});
