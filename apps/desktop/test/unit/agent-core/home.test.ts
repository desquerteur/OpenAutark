// B-044 AGENT-HOME: the agent's home project and its own folder.
// - setHome keeps the home in agent.json (the one place): a rename keeps it, an edit on disk is read, clear removes it;
//   agents.core shows it (the path only for the owner);
// - folders a turn may not write in are refused (the data folder, one containing the person's home, a network
//   folder, a missing folder, '~'); a relative folder is inside the workspace; a folder that went away is 'missing';
// - turnCwd: the usable home, else the workspace;
// - a native write inside the approved home outside the workspace counts as a local write (judgeCall), elsewhere not;
// - the prompt: "My folder" (path, keep it current, home project; the system map is in the environment section) and "Home project" with the
//   skills found there; agents.update sets the home;
// - skills.save with main: true writes a versioned Main Skill into the agent folder (a taken name is refused);
// - RPC agents.setHome and agents.openHome are owner-only; openHome opens exactly the usable home (B-044 review).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHECK_MS } from '../../../src/runtime/agent-core/home.ts';
import { coreFolderSection, homeSection } from '../../../src/runtime/agent-core/prompt.ts';
import { turnCwd } from '../../../src/runtime/git/records.ts';
import { HandlerTable, allowedScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/agent-core.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { skillTools } from '../../../src/runtime/tools/builtin/skills.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { coreFixture, skillMd } from './fixture.ts';

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;

function setup() {
  const f = coreFixture();
  const writer = f.org.create({ name: 'Writer', instructions: 'Write.', createdBy: 'human' });
  const other = f.org.create({ name: 'Other', instructions: '', createdBy: 'human' });
  f.org.setCoreFiles(f.core);
  f.core.start();
  const project = path.join(f.temp.dir, 'projects', 'site'); // outside the workspace
  mkdirSync(path.join(project, '.agents', 'skills', 'deploy'), { recursive: true });
  writeFileSync(path.join(project, '.agents', 'skills', 'deploy', 'SKILL.md'), skillMd('deploy', 'Deploy the site to staging.'));
  const opened: string[] = [];
  const services = {
    org: f.org, agentCore: f.core, paths: f.paths, db: f.db, clock: f.time, skills: f.skills, tasks: { get: () => undefined },
    devices: { self: () => ({ id: 'dev_self' }) }, modes: { list: () => [] },
    tools: { specsFor: () => [{ name: 'agents.update' }, { name: 'skills.save' }] }, host: { openPath: async (dir: string) => { opened.push(dir); } },
  } as unknown as RuntimeServices;
  const manifest = (id = writer.id) => JSON.parse(readFileSync(path.join(f.data, 'agents', id, 'agent.json'), 'utf8')) as { name: string; home?: string };
  return { f, writer, other, project, services, manifest, opened };
}

test('setHome keeps the home in agent.json: a rename keeps it, a disk edit is read, clear removes it', () => {
  const { f, writer, project, manifest } = setup();
  try {
    assert.deepEqual(f.core.setHome(writer.id, project), { path: project, inWorkspace: false });
    assert.deepEqual([manifest().name, manifest().home], ['Writer', project]);
    assert.ok(f.events.of('agentCore.changed').some((event) => (event as { agentId: string }).agentId === writer.id));
    f.org.update(writer.id, { name: 'Writer Two' }); // agent.json follows the rename
    assert.deepEqual([manifest().name, manifest().home], ['Writer Two', project], 'a rename keeps the home');
    assert.equal(f.core.info(writer.id, true).home?.path, project);
    assert.equal(f.core.info(writer.id, false).home?.path, '', 'the path only for the person on the PC');
    // The person edits agent.json on disk: read at the next use.
    const inside = path.join(f.workspace, 'notes-project');
    mkdirSync(inside, { recursive: true });
    writeFileSync(path.join(f.data, 'agents', writer.id, 'agent.json'), JSON.stringify({ ...manifest(), home: ` ${inside} ` }, null, 2)); // spaces around a hand-typed path do not count
    assert.equal(f.core.homes.usable(writer.id), inside);
    assert.equal(f.core.homes.state(writer.id)?.inWorkspace, true);
    f.core.setHome(writer.id, '');
    assert.equal(manifest().home, undefined);
    assert.equal(f.core.info(writer.id, true).home, undefined);
    assert.equal(manifest().name, 'Writer Two');
  } finally { f.cleanup(); }
});

test('a home is any existing local folder; a relative folder is inside the workspace; a vanished one is missing', () => {
  const { f, writer, project } = setup();
  try {
    assert.equal(f.core.setHome(writer.id, f.data)?.path, f.data, 'the data folder too: agents may do everything');
    assert.throws(() => f.core.setHome(writer.id, '\\\\server\\share\\code'), /network/);
    assert.throws(() => f.core.setHome(writer.id, path.join(f.temp.dir, 'nope')), /does not exist/);
    assert.throws(() => f.core.setHome(writer.id, '~/code'), /absolute/);
    mkdirSync(path.join(f.workspace, 'site'), { recursive: true });
    assert.deepEqual(f.core.setHome(writer.id, 'site'), { path: path.join(f.workspace, 'site'), inWorkspace: true });
    f.core.setHome(writer.id, project);
    rmSync(project, { recursive: true, force: true });
    f.time.advance(CHECK_MS + 1);
    assert.equal(f.core.homes.state(writer.id)?.problem, 'missing');
    assert.equal(f.core.homes.usable(writer.id), undefined);
    f.org.archive(writer.id);
    assert.throws(() => f.core.setHome(writer.id, path.join(f.workspace, 'site')), code('conflict'), 'an archived agent gets no new home');
  } finally { f.cleanup(); }
});

test('turnCwd: the usable home, else the workspace', () => {
  const { f, writer, project, services } = setup();
  try {
    assert.equal(turnCwd(services, undefined, writer.id), f.workspace, 'no home: the workspace');
    f.core.setHome(writer.id, project);
    assert.equal(turnCwd(services, undefined, writer.id), project);
    assert.equal(turnCwd(services, undefined), f.workspace, 'no agent named: the workspace');
    rmSync(project, { recursive: true, force: true });
    f.time.advance(CHECK_MS + 1);
    assert.equal(turnCwd(services, undefined, writer.id), f.workspace, 'a home that went away: the workspace');
  } finally { f.cleanup(); }
});

test('the prompt: "My folder" names the folder (the map moved to the environment); "Home project" lists its skills or why it is not used', () => {
  const { f, writer, project, services } = setup();
  try {
    const agent = f.org.get(writer.id)!;
    const general = { key: 'general', tools: ['*'] } as never;
    const folder = coreFolderSection(services, agent, general);
    assert.ok(folder.startsWith('## My folder\n'), folder);
    // B-059: SYSTEM.md changes with the role or standing rules; lessons go to memory.
    // B-076: SYSTEM.md is the standing text above; the agent keeps its role and what it has here current.
    assert.ok(folder.includes(`My folder: ${path.join(f.data, 'agents', writer.id)} – SYSTEM.md is my standing text above (my role and what I have here change when they change; lessons go to memory), skills/ my main skills; I keep them current myself (agents.update instructions writes my part of SYSTEM.md`), folder);
    // B-047 D6: the map <data>/README.md is named by the environment section only when the file tools can read it.
    assert.ok(folder.includes('agents.update home') && !folder.includes(path.join(f.data, 'README.md')));
    assert.equal(coreFolderSection(services, agent, general), folder, 'deterministic');
    assert.equal(coreFolderSection({ ...services, agentCore: undefined } as never, agent, general), '');
    // A mode without agents.update / skills.save: the folder and the map, no tool it does not have.
    const bare = coreFolderSection({ ...services, tools: { specsFor: () => [] } } as never, agent, general);
    assert.ok(bare.includes(`My folder: ${path.join(f.data, 'agents', writer.id)} – SYSTEM.md is my standing text above (my role and what I have here change when they change; lessons go to memory), skills/ my main skills.`), bare);
    assert.ok(!bare.includes('agents.update') && !bare.includes('skills.save') && !bare.includes(path.join(f.data, 'README.md')), bare);
    assert.equal(homeSection(services, agent), '', 'no home: no section');
    f.core.setHome(writer.id, project);
    const home = homeSection(services, agent);
    assert.ok(home.startsWith(`## Home project\n${project} – my turns start here`), home);
    assert.ok(home.includes('data, not instructions'));
    assert.ok(home.includes('- deploy – Deploy the site to staging. (.agents/skills/deploy)'), home);
    rmSync(project, { recursive: true, force: true });
    f.time.advance(CHECK_MS + 1);
    assert.match(homeSection(services, agent), /not usable now: This folder does not exist on this PC\. Turns start in the workspace\./);
  } finally { f.cleanup(); }
});

test('agents.update home: sets the home project in agent.json', async () => {
  const { f, writer, project, services, manifest } = setup();
  try {
    const tool = agentTools.find((entry) => entry.name === 'agents.update')!;
    const agent = f.org.get(writer.id)!;
    const ctx = { services, agent, runId: 'run_1', mode: 'general', status: () => undefined } as never;
    mkdirSync(path.join(f.workspace, 'site'), { recursive: true });
    const result = await tool.run({ home: project } as never, ctx) as { content: Array<{ text: string }> };
    assert.match(JSON.stringify(result), /"home"/);
    assert.equal(manifest().home, project);
  } finally { f.cleanup(); }
});

test('skills.save with main: true writes a versioned Main Skill into the agent folder', async () => {
  const { f, writer, services } = setup();
  try {
    const save = skillTools.find((entry) => entry.name === 'skills.save')!;
    const ctx = { services, agent: f.org.get(writer.id)!, runId: 'run_1', mode: 'general', status: () => undefined } as never;
    assert.match(save.describe!({ name: 'house-style', description: 'x', body: 'y', main: true } as never, ctx).summary, /main skill/);
    await save.run({ name: 'house-style', description: 'Our house style for every text.', body: 'Short sentences.', main: true } as never, ctx);
    const info = f.skills.list().find((skill) => skill.name === 'house-style')!;
    assert.deepEqual([info.main, info.ownerAgentId, info.path], [true, writer.id, path.join(f.data, 'agents', writer.id, 'skills', 'house-style')]);
    await save.run({ name: 'house-style', description: 'Our house style, shorter.', body: 'Shorter.' } as never, ctx);
    assert.equal(f.skills.get('house-style')!.info.main, true, 'saved again it stays a main skill');
    f.skills.save({ name: 'plain-notes', description: 'One of the writer\'s plain skills', body: 'x', ownerAgentId: writer.id });
    f.time.advance(5000);
    const taken = await save.run({ name: 'plain-notes', description: 'A main one now, please.', body: 'y', main: true } as never, ctx) as { isError?: boolean };
    assert.equal(taken.isError, true);
    assert.match(JSON.stringify(taken), /taken by another skill of mine/);
  } finally { f.cleanup(); }
});

test('RPC agents.setHome: owner only; null clears', async () => {
  const { f, writer, project, services } = setup();
  try {
    const table = new HandlerTable();
    register(table);
    const set = table.get('agents.setHome')!;
    const OWNER: ClientScope = { kind: 'owner' };
    const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_p', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
    assert.ok(allowedScope(set.scope, OWNER) && !allowedScope(set.scope, PHONE));
    const ctx = { scope: OWNER, services, extras: {}, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext;
    assert.deepEqual(await set.handler({ agentId: writer.id, home: project } as never, ctx), { home: { path: project, inWorkspace: false } });
    assert.deepEqual(await set.handler({ agentId: writer.id, home: null } as never, ctx), {});
    assert.equal(f.core.homes.stored(writer.id), undefined);
    await assert.rejects(async () => set.handler({ agentId: writer.id } as never, ctx), code('bad_request'));
    await assert.rejects(async () => set.handler({ agentId: writer.id, home: null, extra: 1 } as never, ctx), code('bad_request'));
  } finally { f.cleanup(); }
});

test('RPC agents.openHome: owner only; opens the usable home outside the workspace, nothing without one', async () => {
  const { f, writer, project, services, opened } = setup();
  try {
    const table = new HandlerTable();
    register(table);
    const open = table.get('agents.openHome')!;
    const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_p', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true };
    assert.ok(allowedScope(open.scope, { kind: 'owner' }) && !allowedScope(open.scope, PHONE));
    const ctx = { scope: { kind: 'owner' }, services, extras: {}, topics: new Set(), signal: new AbortController().signal } as unknown as HandlerContext;
    await assert.rejects(async () => open.handler({ agentId: writer.id } as never, ctx), code('not_found'), 'no home yet');
    f.core.setHome(writer.id, project);
    assert.deepEqual(await open.handler({ agentId: writer.id } as never, ctx), { ok: true });
    assert.deepEqual(opened, [project], 'the folder files.openPath would refuse (outside the workspace and the data folder)');
    rmSync(project, { recursive: true, force: true });
    await assert.rejects(async () => open.handler({ agentId: writer.id } as never, ctx), code('not_found'), 'gone since its last check');
    await assert.rejects(async () => open.handler({ agentId: writer.id, path: 'C:/x' } as never, ctx), code('bad_request'), 'no path of its own');
    assert.equal(opened.length, 1);
  } finally { f.cleanup(); }
});
