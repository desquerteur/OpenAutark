// <data>/settings.json is the one store of the settings (settings/service.ts, read.ts, schema.ts):
// - the app writes the file whole: "$schema", a comment per section, a comment line above every key (what it does,
//   the allowed values, the default) and every key with its current value; settings.schema.json lies beside it;
// - round trip: settings → text → the same settings; update() writes the file and survives a restart;
// - an edit on disk (with comments, a trailing comma, a missing key, null) is taken over once and the file is
//   written whole again with fresh comments; a section removed from the file goes back to the defaults;
// - the older file that held only the values differing from the defaults becomes whole once, every value kept;
//   the old database rows move in once – the file's own values win – and the table is emptied;
// - an invalid section keeps its last good value and stays in the file as written with the reason above it and a
//   quiet notice; a fix clears both; a key no section knows is left out; an unknown section stays as written;
// - a file that is no JSON is copied to settings.rejected.json before the app writes over it; a deleted file is
//   written again from the current values; a disk edit not handed over yet comes before an update;
// - a settings.json that is still the pre-rebuild store (schema 1–7) is neither read nor written.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { defaultSettings } from '../../../src/runtime/settings/defaults.ts';
import { pcOf, settingsFrom, withOldRows } from '../../../src/runtime/settings/read.ts';
import { SECTIONS, SETTINGS_SCHEMA_FILE, parseText, settingsText, stripJsonc } from '../../../src/runtime/settings/schema.ts';
import { RootWatcher } from '../../../src/runtime/root/watcher.ts';
import { ROOT_SETTINGS } from '../../../src/runtime/root/layout.ts';
import type { Db } from '../../../src/runtime/db/database.ts';
import type { Settings } from '../../../src/shared/model/system.ts';
import { clock, memoryDb, recordingBus, tempDir } from '../store/helpers.ts';

const env = { locale: 'en-US', timezone: 'Europe/Berlin' };
const defaults = defaultSettings(env);
const pc = pcOf(defaults);

function setup(seed?: (db: Db, file: string) => void) {
  const temp = tempDir('wf-settings-file-');
  const db = memoryDb();
  const file = path.join(temp.dir, ROOT_SETTINGS);
  seed?.(db, file);
  const recorder = recordingBus();
  const time = clock();
  const root = new RootWatcher({ root: temp.dir, clock: time, watch: false, debounceMs: 1, maxWaitMs: 5 });
  root.start();
  const make = () => new SettingsStore({ db, bus: recorder.bus, clock: time, env, dataDir: temp.dir, root });
  const settings = make();
  const text = () => readFileSync(file, 'utf8');
  const json = () => parseText(text()).data as Record<string, Record<string, unknown>>;
  /** An edit on disk, then the watcher hands it over. */
  const edit = (body: string) => { writeFileSync(file, body, 'utf8'); root.nudge(ROOT_SETTINGS); root.flush(ROOT_SETTINGS); };
  const done = () => { settings.close(); root.stop(); temp.cleanup(); };
  return { temp, db, settings, make, file, text, json, edit, done, root, ...recorder };
}

const row = (db: Db, key: string, value: unknown) => db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)', [key, JSON.stringify(value)]);
/** The line right above `"key":` (the first one in the text). */
const above = (body: string, key: string): string => {
  const lines = body.split('\n');
  return lines[lines.findIndex((line) => line.trimStart().startsWith(`"${key}":`)) - 1].trim();
};

test('a first start writes the whole file: every section and key with a comment above it, and settings.schema.json beside it', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.get();
  const body = h.text();
  assert.match(body, /^\/\/ Autark settings: every setting of the app with its current value\./);
  const data = h.json();
  assert.equal(data.$schema, './settings.schema.json');
  for (const section of SECTIONS) {
    assert.ok(body.includes([`  // ${section.title}`, ...(section.notes ?? []).map((note) => `  // ${note}`), `  "${section.key}": {`].join('\n')), section.key);
    for (const def of section.keys) assert.ok(def.key in data[section.key], `${section.key}.${def.key}`);
  }
  assert.equal(above(body, 'theme'), '// Colour scheme of the window. Options: system | light | dark. Default: system');
  assert.equal(above(body, 'sidebarWidth'), '// Width of the sidebar in pixels. From 200 to 420. Default: 288');
  assert.equal(above(body, 'closeToTray'), '// Closing the window keeps the app and the agents running. Options: true | false. Default: true');
  assert.match(above(body, 'language'), /Default: en \(this PC\)$/);
  assert.equal(data.preferences.theme, 'system');
  assert.equal(data.notifications.quietHours, null, 'a key not set reads null');
  assert.equal(data.notifications.sound, true, 'notifications sound by default');
  assert.match(above(body, 'sound'), /^\/\/ A sound with each notification .*Default: true$/, 'the first "sound" key is the notifications one');
  assert.deepEqual(data.lifecycle, { retention: { traceDays: 0, historyDays: 0 } }, 'a section without defaults shows its defaults too');
  assert.deepEqual(settingsFrom(data, defaults, defaults).settings, h.settings.get(), 'what the file says is what applies');
  const schema = JSON.parse(readFileSync(path.join(h.temp.dir, SETTINGS_SCHEMA_FILE), 'utf8')) as { properties: Record<string, { properties: Record<string, Record<string, unknown>> }> };
  assert.deepEqual(Object.keys(schema.properties), ['$schema', ...SECTIONS.map((section) => section.key)]);
  assert.deepEqual(schema.properties.preferences.properties.theme.enum, ['system', 'light', 'dark']);
  assert.equal(schema.properties.preferences.properties.theme.default, 'system');
  assert.equal(schema.properties.preferences.properties.theme.description, 'Colour scheme of the window. Options: system | light | dark. Default: system');
});

test('round trip: settings → text → the same settings and the same text', () => {
  const settings = structuredClone(defaults) as Settings;
  Object.assign(settings.profile, { name: 'Ada "A" Lovelace', avatarFileId: 'file_01' });
  settings.preferences.theme = 'dark';
  settings.notifications.quietHours = { from: '22:00', to: '07:00' };
  settings.voice.vocabulary = Array.from({ length: 40 }, (_, index) => `Word ${index} // not a comment`);
  Object.assign(settings.routing, { work: 'codex', decision: 'claude:opus', image: 'off' });
  settings.devices.relay = 'wss://relay.example.com';
  settings.lifecycle = { retention: { traceDays: 30 } };
  settings.calendar = { googleClientId: '1234-abc.apps.googleusercontent.com' };
  const body = settingsText(settings, pc);
  const read = settingsFrom(parseText(body).data!, defaults, defaults);
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.settings, settings);
  assert.equal(settingsText(read.settings, pc), body);
  assert.equal(settingsFrom(parseText(settingsText(defaults, pc)).data!, defaults, defaults).settings.lifecycle, undefined, 'defaults read as defaults (no lifecycle)');
});

test('the meeting server: Autark\'s own by default (null in the file too), "" turns it off, a test profile skips the default (B-072)', async () => {
  const { DEFAULT_RELAY } = await import('../../../src/shared/model/relay.ts');
  const { meetingAddress } = await import('../../../src/runtime/devices/connect.ts');
  const pc = { language: 'en', timezone: 'Europe/Vienna' };
  const defaults = defaultSettings(pc);
  assert.equal(defaults.devices.relay, DEFAULT_RELAY);
  assert.equal(settingsFrom({ devices: { relay: null } }, defaults, defaults).settings.devices.relay, DEFAULT_RELAY, 'an older file\'s null is the default');
  assert.equal(settingsFrom({ devices: { relay: '' } }, defaults, defaults).settings.devices.relay, '', 'empty stays off');
  assert.equal(meetingAddress(DEFAULT_RELAY, {}), DEFAULT_RELAY);
  assert.equal(meetingAddress(DEFAULT_RELAY, { WORKFORCE_TEST_DATA: 'C:/tmp/x' }), '', 'a test profile never calls the real server by default');
  assert.equal(meetingAddress('ws://127.0.0.1:8790', { WORKFORCE_TEST_DATA: 'C:/tmp/x' }), 'ws://127.0.0.1:8790', 'its own address still works');
});

test('update() writes the file whole and survives a restart', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.update({ preferences: { theme: 'dark', closeToTray: false }, devices: { relay: 'wss://relay.example.com' } });
  assert.equal(h.json().preferences.theme, 'dark');
  assert.equal(h.json().preferences.closeToTray, false);
  assert.equal(h.json().preferences.sidebarWidth, 288, 'the other keys stay in the file');
  assert.equal(h.json().devices.relay, 'wss://relay.example.com');
  assert.equal(above(h.text(), 'theme'), '// Colour scheme of the window. Options: system | light | dark. Default: system');
  h.settings.close();
  const again = h.make();
  assert.equal(again.get().preferences.closeToTray, false);
  assert.equal(again.get().devices.relay, 'wss://relay.example.com');
  again.close();
});

test('an edit with comments, a trailing comma, a missing key and null applies; the file is written whole again', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.get();
  const edited = h.text()
    .replace('"theme": "system",', '"theme": "light", // my choice\n    /* a block\n       comment */')
    .replace(/\n\s*\/\/[^\n]*\n\s*"workspaceWidth": 420,/, '')
    .replace('"agentLane": false', '"agentLane": true,')
    .replace('"bufferMin": 10', '"bufferMin": null');
  assert.ok(edited.includes('"agentLane": true,\n'), 'a trailing comma before }');
  assert.ok(!edited.includes('"workspaceWidth"') && edited.includes('"bufferMin": null,') && edited.includes('// my choice'));
  h.edit(edited);
  const s = h.settings.get();
  assert.equal(s.preferences.theme, 'light');
  assert.equal(s.day?.agentLane, true);
  assert.equal(s.day?.bufferMin, 10, 'null reads as the default');
  assert.equal(s.preferences.workspaceWidth, 420, 'a missing key reads as the default');
  assert.equal(h.settings.notice(), undefined);
  assert.equal(h.of('settings.updated').length, 1);
  assert.equal(h.text(), `${settingsText(s, pc)}`, 'written whole again: the key is back, own comments go, the comments are current');
  assert.equal(h.json().day.bufferMin, 10);
});

test('the comments are regenerated: a file without or with stale comments gets the current ones; the values stay', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.update({ profile: { name: 'Ada' } });
  const plain = JSON.stringify(h.json(), null, 2);
  h.edit(plain.replace('"name": "Ada"', '"name": "Grace"'));
  assert.equal(h.settings.get().profile.name, 'Grace');
  assert.equal(h.text(), settingsText(h.settings.get(), pc));
  h.edit(h.text().replace('// Colour scheme of the window', '// An old description'));
  assert.ok(h.text().includes('// Colour scheme of the window. Options: system | light | dark. Default: system'));
  assert.equal(h.of('settings.updated').length, 2, 'a comment change alone is no settings change');
});

test('the older file holding only the values that differ from the defaults becomes whole once, every value kept', (t) => {
  const old = { profile: { name: 'Ada' }, preferences: { theme: 'dark' }, devices: { findable: null }, voice: { vocabulary: ['Kimi'] }, lifecycle: { retention: { traceDays: 30 } }, routing: { functions: { chat: 'claude:opus' } } };
  const h = setup((_db, file) => writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`, 'utf8'));
  t.after(h.done);
  const s = h.settings.get();
  assert.equal(s.profile.name, 'Ada');
  assert.equal(s.preferences.theme, 'dark');
  assert.equal(s.devices.findable, true, 'null (removed) read as the default');
  assert.deepEqual(s.voice.vocabulary, ['Kimi']);
  assert.deepEqual(s.lifecycle, { retention: { traceDays: 30 } });
  assert.equal(s.routing.work, 'claude:opus', 'the older functions.chat became the Work use');
  assert.equal(h.text(), settingsText(s, pc), 'the file is whole now');
  assert.equal(h.json().preferences.sidebarWidth, 288);
  h.settings.close();
  assert.deepEqual(h.make().get(), s, 'the next start reads the same');
});

test('the old database rows move into the file once: the file wins, database-only sections and keys come along', (t) => {
  const h = setup((db, file) => {
    row(db, 'profile', { name: 'Old name', company: 'Acme' });
    row(db, 'preferences', { theme: 'light', closeToTray: false, openAtLogin: true });
    row(db, 'routing', { costMode: 'best', allowPaidFallback: true });
    row(db, 'onboarding', { completed: true, step: 'done' });
    row(db, 'pwa', { enabled: true, bind: 'lan' });
    writeFileSync(file, JSON.stringify({ profile: { name: 'Ada' }, preferences: { theme: 'dark' } }), 'utf8');
  });
  t.after(h.done);
  const s = h.settings.get();
  assert.equal(s.profile.name, 'Ada', 'the file wins');
  assert.equal(s.profile.company, '', 'file sections come from the file only');
  assert.equal(s.preferences.theme, 'dark');
  assert.equal(s.preferences.closeToTray, false, 'a database-only key comes along');
  assert.equal(s.preferences.openAtLogin, true);
  assert.equal(s.routing.allowPaidFallback, true);
  assert.equal(s.routing.costMode, 'balanced', 'the file had no routing values');
  assert.deepEqual([s.onboarding.completed, s.onboarding.step], [true, 'done']);
  assert.deepEqual(s.pwa, { enabled: true, bind: 'lan' });
  assert.deepEqual(h.json().pwa, { enabled: true, bind: 'lan' });
  assert.deepEqual(h.db.all('SELECT key FROM settings'), [], 'the table is emptied: the rows never come back');
});

test('without a settings.json the rows are everything; comments and trailing commas are read like VS Code reads them', () => {
  assert.deepEqual(withOldRows(undefined, { profile: { name: 'Ana' } }), { profile: { name: 'Ana' } });
  assert.deepEqual(withOldRows({ voice: { realtime: 'auto' } }, { voice: { realtime: 'off', recognizer: 'local' }, devices: { peer: 'off' } }), { voice: { realtime: 'auto' }, devices: { peer: 'off' } });
  const body = '// head\n{\n  "a": "x // y", /* note */ "b": "p /* q */ \\" // r",\n  "c": [1, 2,], // tail\n  "d": { "e": "f", },\n}\n';
  assert.deepEqual(parseText(body).data, { a: 'x // y', b: 'p /* q */ " // r', c: [1, 2], d: { e: 'f' } });
  assert.equal(stripJsonc('{"a":1}'), '{"a":1}');
  assert.deepEqual(parseText('  // only a comment\n'), { data: {} });
  assert.deepEqual(parseText('{ "a": 1 '), { whole: 'settings.json is not valid JSON' });
  assert.deepEqual(parseText('[1]'), { whole: 'settings.json is not a JSON object' });
});

test('an edit on disk is taken over once; a section removed from the file goes back to the defaults', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.get();
  h.edit('{\n  "profile": { "name": "Ada", "company": "Lab" },\n  "preferences": { "theme": "light" }\n}\n');
  assert.equal(h.of('settings.updated').length, 1);
  assert.equal(h.settings.get().profile.name, 'Ada');
  h.edit('{\n  "profile": { "name": "Ada", "company": "Lab" },\n  "preferences": { "theme": "light" }\n}\n');
  assert.equal(h.of('settings.updated').length, 1, 'no event when nothing changed');
  h.edit('{ "profile": { "name": "Ada", "company": "Lab" } }');
  assert.equal(h.settings.get().preferences.theme, 'system');
  // The app's own write is no edit.
  h.settings.update({ preferences: { theme: 'dark' } });
  const events = h.of('settings.updated').length;
  h.settings.fromDisk();
  assert.equal(h.of('settings.updated').length, events);
});

test('an invalid value keeps the last good one, stays in the file as written with the reason above it; a fix clears it', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.update({ routing: { costMode: 'best' } });
  h.edit(h.text().replace('"costMode": "best"', '"costMode": "cheapest"').replace('"theme": "system"', '"theme": "dark"'));
  assert.equal(h.settings.get().routing.costMode, 'best', 'last good value');
  assert.equal(h.settings.get().preferences.theme, 'dark', 'the valid section applies');
  const notice = h.settings.notice()!;
  assert.match(notice, /^settings\.json: routing was not applied \(routing\.costMode: expected economy \| balanced \| best\)\./);
  assert.deepEqual(h.of('settings.notice').at(-1), { text: notice });
  assert.equal(h.json().routing.costMode, 'cheapest', 'the text stays as written');
  assert.ok(h.text().includes('  // Models\n  // Not applied (routing.costMode: expected economy | balanced | best) – the last good values are used until this is fixed.\n  "routing": {'));
  assert.match(above(h.text(), 'costMode'), /^\/\/ How models are chosen/, 'its keys keep their comments');
  h.settings.update({ notifications: { sound: false } });
  assert.equal(h.json().routing.costMode, 'cheapest', 'another change keeps the invalid text in the file');
  assert.equal(h.json().notifications.sound, false);
  h.edit(h.text().replace('"costMode": "cheapest"', '"costMode": "economy"'));
  assert.equal(h.settings.get().routing.costMode, 'economy');
  assert.equal(h.settings.notice(), undefined);
  assert.deepEqual(h.of('settings.notice').at(-1), {});
  assert.doesNotMatch(h.text(), /Not applied/);
});

test('unknown keys: a key no section knows and a retired section are left out; an unknown section stays as written with a notice', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.get();
  h.edit('{ "voice": { "realtime": "auto", "recognizer": "windows" }, "org": { "reportDelayMin": 5 }, "permissions": { "mode": "x" }, "$schema": "elsewhere" }');
  assert.equal(h.settings.get().voice.realtime, 'auto');
  const data = h.json();
  assert.equal(data.voice.realtime, 'auto');
  assert.equal('recognizer' in data.voice, false, 'the unknown key is left out');
  assert.equal('org' in data, false, 'the retired section is left out');
  assert.deepEqual(data.permissions, { mode: 'x' }, 'the unknown section stays as written');
  assert.equal(data.$schema, './settings.schema.json', '"$schema" is the app\'s');
  assert.ok(h.text().trimEnd().endsWith('  // Not applied (permissions is not a settings section) – the last good values are used until this is fixed.\n  "permissions": { "mode": "x" }\n}'));
  assert.match(h.settings.notice() ?? '', /permissions is not a settings section/);
  assert.doesNotMatch(h.settings.notice() ?? '', /org/);
});

test('a file that is no JSON keeps the values and is copied aside before the app writes; a deleted file comes back', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.update({ profile: { name: 'Ada' } });
  h.edit('{ "profile": { "name": "Bea" ');
  assert.equal(h.settings.get().profile.name, 'Ada');
  assert.match(h.settings.notice() ?? '', /^settings\.json is not valid JSON\./);
  assert.equal(h.text(), '{ "profile": { "name": "Bea" ', 'not written over until the next change');
  h.settings.update({ profile: { company: 'Lab' } });
  assert.equal(readFileSync(path.join(h.temp.dir, 'settings.rejected.json'), 'utf8'), '{ "profile": { "name": "Bea" ');
  assert.equal(h.json().profile.name, 'Ada');
  assert.equal(h.json().profile.company, 'Lab');
  assert.equal(h.settings.notice(), undefined);
  rmSync(h.file);
  h.root.nudge(ROOT_SETTINGS);
  h.root.flush(ROOT_SETTINGS);
  assert.equal(h.text(), settingsText(h.settings.get(), pc));
  assert.equal(h.json().profile.company, 'Lab');
});

test('an edit not handed over yet comes before an update', (t) => {
  const h = setup();
  t.after(h.done);
  h.settings.get();
  writeFileSync(h.file, '{ "profile": { "name": "Ada" } }', 'utf8');
  h.settings.update({ preferences: { theme: 'dark' } });
  assert.equal(h.json().profile.name, 'Ada');
  assert.equal(h.json().preferences.theme, 'dark');
});

test('a settings.json that is still the pre-rebuild store is neither read nor written', (t) => {
  for (const big of [false, true]) {
    const legacy = `{\n  "schema": 7,\n  "profile": { "name": "Old" },\n  "chats": [${big ? `"${'x'.repeat(1024 * 1024)}"` : ''}]\n}\n`;
    const h = setup((db, file) => { row(db, 'profile', { name: 'Ada' }); writeFileSync(file, legacy, 'utf8'); });
    t.after(h.done);
    assert.equal(h.settings.get().profile.name, 'Ada', `the old rows hold the values (${big ? 'large' : 'small'} store)`);
    h.settings.update({ profile: { company: 'Acme' } });
    assert.equal(readFileSync(h.file, 'utf8'), legacy, 'never written over');
    assert.equal(existsSync(path.join(h.temp.dir, 'settings.rejected.json')), false);
    rmSync(h.file); // the legacy import moved it aside: the values in memory are written now
    h.root.nudge(ROOT_SETTINGS);
    h.root.flush(ROOT_SETTINGS);
    assert.equal(h.json().profile.name, 'Ada');
    assert.equal(h.json().profile.company, 'Acme');
  }
});
