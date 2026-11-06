// B-044 open file system maps (root/readme.ts) and system.root (rpc/handlers/system.ts):
// - <data>/README.md names every documented entry and what editing does (settings.json: every setting with a comment
//   above each key, settings.schema.json beside it), the app-managed entries, the workspace
//   and how a program or agent calls the running app (wf call / POST /rpc with runtime.json) – never a token value;
// - <data>/agents/README.md: name → folder, role, reports to (archived last, table cells escaped);
// - RootMaps writes both at start, only when the text changes, and the agents map again after team changes
//   (gathered) and when the person's name changes (settings.updated); system.root answers {path, readme} (the
//   map written when missing) plus the settings file's notice.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { agentsReadme, GATHER_MS, RootMaps, rootReadme } from '../../../src/runtime/root/readme.ts';
import { ROOT_ENTRIES } from '../../../src/runtime/root/layout.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import { recordingBus, tempDir } from '../store/helpers.ts';

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  id, name, role: '', avatar: { kind: 'initials', text: name[0], palette: 0 }, mode: 'general', skills: [], modelPolicy: {},
  status: 'idle', createdBy: HUMAN_ID, createdAt: 0, updatedAt: 0, instructions: '', ...extra,
} as Agent);
const log = { debug() {}, info() {}, warn() {}, error() {} };

test('the root map names every entry, the app-managed ones, the workspace and how to call the running app', () => {
  const text = rootReadme({ data: '/data', workspace: '/home/ada/Workforce' });
  for (const entry of ROOT_ENTRIES) assert.ok(text.includes(`| ${entry.includes('.') ? entry : `${entry}/`} |`), entry);
  assert.match(text, /This folder holds the app's data on this PC: \/data/);
  assert.match(text, /changed by the person and by agents/);
  assert.match(text, /\| settings\.json \| Every setting of the app with its current value: .*Above each key a comment line names what it does, the allowed values and the default\. settings\.schema\.json beside it/);
  assert.match(text, /null or a missing key means the default\)\. An invalid value keeps its last good value.*Skill: app-settings\./);
  assert.match(text, /\| theme\.css \| The app's look/);
  assert.ok(text.includes('rules.md (how every agent works)') && !text.includes('cannot be replaced'), 'every shipped prompt can be replaced, rules.md included');
  assert.match(text, /runtime\.json \(port and owner token of the running app\)/);
  assert.match(text, /boot\.json .*run-state\.json, next-due\.json and launcher\.json/);
  for (const name of ['git-no-hooks/', 'window-state.json', 'before-restore-<time>/', 'restore-result.json', 'settings.v7-backup.json']) assert.ok(text.includes(name), name);
  assert.match(text, /avatar\.png or avatar\.jpg \(a copy of its picture\)/);
  assert.match(text, /\/home\/ada\/Workforce – projects/);
  assert.match(text, /wf call <method>/);
  assert.match(text, /POST http:\/\/127\.0\.0\.1:<port>\/rpc with the header "Authorization: Bearer <token>"/);
  assert.match(text, /An agent acts in another of these companies right from its own chat: tools\.call \{"name":"<tool>","args":\{…\},"company":"<name or folder from companies\.list>"\}/); // B-075
  assert.doesNotMatch(text, /password|sk-|only in the app|may not|private/i);
});

test('the agents map: name → folder, role, reports to; archived last; cells escaped', () => {
  const text = agentsReadme([
    agent('ag_m', 'Manager', { role: 'Chief of staff' }),
    agent('ag_w', 'Wri|ter', { role: 'Writer', managerId: 'ag_m' }),
    agent('ag_old', 'Old', { role: 'Gone', managerId: 'ag_m', archivedAt: 5 }),
  ], 'Ada');
  assert.match(text, /\| Manager \| ag_m\/ \| Chief of staff \| Ada \|/);
  assert.match(text, /\| Wri\\\|ter \| ag_w\/ \| Writer \| Manager \|/);
  assert.match(text, /## Archived\n\n\| Name \| Folder \| Role \| Reported to \|\n\|---\|---\|---\|---\|\n\| Old \| ag_old\/ \| Gone \| Manager \|/);
  assert.match(agentsReadme([agent('ag_m', 'M')], ''), /\| M \| ag_m\/ \| – \| The person \|/);
});

test('RootMaps writes both maps at start, only on a change, and the agents map again after team changes', async (t) => {
  const temp = tempDir('wf-maps-');
  t.after(temp.cleanup);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const team = [agent('ag_m', 'Manager')];
  let person = 'Ada';
  const recorder = recordingBus();
  const writes: string[] = [];
  const maps = new RootMaps({
    paths: { data: temp.dir, workspace: path.join(temp.dir, 'workspace') }, bus: recorder.bus, log,
    agents: () => team, personName: () => person, writes: { wrote: (file) => { writes.push(path.relative(temp.dir, file)); } },
  });
  maps.start();
  t.after(() => maps.stop());
  assert.deepEqual(writes.sort(), ['README.md', path.join('agents', 'README.md')]);
  const agentsFile = path.join(temp.dir, 'agents', 'README.md');
  assert.match(readFileSync(agentsFile, 'utf8'), /\| Manager \|/);
  assert.equal(maps.writeRoot(), false, 'the same text is not written again');
  team.push(agent('ag_w', 'Writer', { managerId: 'ag_m' }));
  recorder.bus.emit('agent.upserted', team[1]);
  recorder.bus.emit('agent.upserted', team[0]);
  t.mock.timers.tick(GATHER_MS);
  assert.match(readFileSync(agentsFile, 'utf8'), /\| Writer \| ag_w\/ \| – \| Manager \|/);
  assert.equal(writes.length, 3, 'two events, one write');
  const before = statSync(agentsFile).mtimeMs;
  recorder.bus.emit('agent.upserted', team[0]);
  t.mock.timers.tick(GATHER_MS);
  assert.equal(statSync(agentsFile).mtimeMs, before, 'nothing changed: not written');
  // The person's name heads "Reports to": a settings change follows it (written only when the text changes).
  person = 'Grace';
  recorder.bus.emit('settings.updated', {} as never);
  t.mock.timers.tick(GATHER_MS);
  assert.match(readFileSync(agentsFile, 'utf8'), /\| Manager \| ag_m\/ \| – \| Grace \|/);
  assert.equal(writes.length, 4);
});

test('system.root: <data>, its map (written when missing) and the settings file notice', async (t) => {
  const temp = tempDir('wf-root-rpc-');
  t.after(temp.cleanup);
  const maps = new RootMaps({ paths: { data: temp.dir, workspace: path.join(temp.dir, 'workspace') }, bus: recordingBus().bus, log, agents: () => [], personName: () => '' });
  const services = { paths: { data: temp.dir, workspace: path.join(temp.dir, 'workspace') }, rootMaps: maps, settings: { notice: () => 'In settings.json the voice section was not used.' } };
  const handler = createHandlerTable().get('system.root')!;
  assert.equal(handler.scope, 'owner');
  const readme = path.join(temp.dir, 'README.md');
  rmSync(readme, { force: true });
  const result = await handler.handler(undefined as never, { scope: { kind: 'owner' }, services, extras: {}, topics: new Set(), signal: new AbortController().signal } as never);
  assert.deepEqual(result, { path: temp.dir, workspace: path.join(temp.dir, 'workspace'), readme, notices: ['In settings.json the voice section was not used.'] });
  assert.ok(existsSync(readme));
});
