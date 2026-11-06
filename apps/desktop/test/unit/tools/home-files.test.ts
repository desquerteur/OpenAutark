// B-044 integration: files.read / files.list in the agent's approved home project outside the workspace
// (tools/builtin/files.ts readPath, agent-core/home-read.ts homeReadRoot):
//  - by absolute path the agent reads and lists its own usable home; relative paths stay in the workspace;
//  - agents read anywhere on this PC (no home guard any more);
//  - the "Home project" prompt section says so only for a home outside the workspace and when files.read is offered.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeSection } from '../../../src/runtime/agent-core/prompt.ts';
import { fileTools } from '../../../src/runtime/tools/builtin/files.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolOutput } from '../../../src/runtime/tools/types.ts';
import { coreFixture } from '../agent-core/fixture.ts';

function world() {
  const f = coreFixture();
  const writer = f.org.create({ name: 'Writer', instructions: 'Write.', createdBy: 'human' });
  const other = f.org.create({ name: 'Other', instructions: '', createdBy: 'human' });
  f.org.setCoreFiles(f.core);
  f.core.start();
  const project = path.join(f.temp.dir, 'projects', 'site');
  mkdirSync(path.join(project, 'docs'), { recursive: true });
  writeFileSync(path.join(project, 'README.md'), '# Site\nThe home project.\n');
  writeFileSync(path.join(project, 'docs', 'deploy.md'), 'Deploy with the script.\n');
  const elsewhere = path.join(f.temp.dir, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, 'private.txt'), 'Not in the home.\n');
  f.core.setHome(writer.id, project);
  const offered = { names: ['files.read', 'files.list'] };
  const modes = { general: { key: 'general', tools: ['*'] } };
  const services = {
    org: f.org, agentCore: f.core, paths: f.paths, db: f.db, clock: f.time, modes: { get: (key: string) => modes[key as 'general'], list: () => [] },
    tools: { specsFor: () => offered.names.map((name) => ({ name })) },
  } as unknown as RuntimeServices;
  const tools = fileTools();
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const ctx = (agentId: string, extra: Record<string, unknown> = {}) => ({ services, agent: f.org.get(agentId)!, runId: 'run_1', mode: 'general', status: () => undefined, ...extra }) as never;
  const run = async (name: string, agentId: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const out = await tool(name).run(args as never, ctx(agentId, extra)) as ToolOutput;
    return { error: out.isError === true, text: out.content.map((part) => ('text' in part ? part.text : '')).join('') };
  };
  return { f, writer, other, project, elsewhere, services, offered, run };
}

test('files.read / files.list read the own home outside the workspace by absolute path; relative paths stay in the workspace', async () => {
  const { f, writer, project, run } = world();
  try {
    const read = await run('files.read', writer.id, { path: path.join(project, 'README.md') });
    assert.equal(read.error, false, read.text);
    assert.match(read.text, /The home project\./);
    assert.match((await run('files.read', writer.id, { path: path.join(project, 'docs', '..', 'docs', 'deploy.md') })).text, /Deploy with the script/);
    const list = await run('files.list', writer.id, { path: project });
    assert.deepEqual(list.text.split('\n').sort(), ['dir  docs', 'file README.md'].sort(), list.text);
    const relative = await run('files.read', writer.id, { path: 'README.md' });
    assert.equal(relative.error, true);
    assert.match(relative.text, /No file at README\.md/, 'a relative path is the workspace\'s');
  } finally { f.cleanup(); }
});

test('the "Home project" section names the file tools for a home outside the workspace when the mode offers them', () => {
  const { f, writer, offered, services } = world();
  try {
    const agent = f.org.get(writer.id)!;
    assert.ok(homeSection(services, agent, 'general').includes('files.read and files.list read it by absolute path (read-only).'));
    assert.ok(!homeSection(services, agent).includes('files.read'), 'no mode: no tool named');
    offered.names = [];
    assert.ok(!homeSection(services, agent, 'general').includes('files.read'));
    offered.names = ['files.read'];
    const inside = path.join(f.workspace, 'notes');
    mkdirSync(inside, { recursive: true });
    f.core.setHome(writer.id, inside);
    assert.ok(!homeSection(services, agent, 'general').includes('files.read'), 'a home in the workspace needs no word');
  } finally { f.cleanup(); }
});
