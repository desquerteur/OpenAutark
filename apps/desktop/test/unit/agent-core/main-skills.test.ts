// Wave 3: Main Skills in <data>/agents/<id>/skills are part of the one skill library.
// - save with `main` creates one in the agent's folder (a taken name is refused); saving it again stays there;
// - the agent's prompt lists them in their own section (never the full text) and its index and suggestions leave
//   them out; other agents do not see them by default; skills.list names them; disabled ones are not listed;
// - an agent file import with `main` lands in the Main Skills, waiting for review;
// - RPC: agents.core ('chat'; the folder path only for the owner) and agents.saveMainSkill ('manage'); people reach neither.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mainSkillsSection } from '../../../src/runtime/agent-core/prompt.ts';
import { HandlerTable, allowedScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/agent-core.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { skillTools } from '../../../src/runtime/tools/builtin/skills.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { AgentCoreInfo } from '../../../src/shared/model/agent-core.ts';
import type { ModeInfo, SkillInfo } from '../../../src/shared/model/knowledge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { coreFixture, skillMd } from './fixture.ts';

const code = (expected: string) => (error: unknown) => error instanceof WorkforceError && error.code === expected;
const writing = { key: 'writing', skills: [], name: 'Writing', description: '', tools: ['*'], category: 'writing', instructions: '' } as unknown as ModeInfo;

function setup() {
  const f = coreFixture();
  const writer = f.org.create({ name: 'Writer', instructions: 'Write.', createdBy: 'human' });
  const other = f.org.create({ name: 'Other', instructions: '', createdBy: 'human' });
  f.org.setCoreFiles(f.core);
  f.core.start();
  const services = { org: f.org, skills: f.skills, agentCore: f.core, modes: { get: () => writing }, db: f.db, clock: f.time } as unknown as RuntimeServices;
  return { f, writer, other, services };
}

test('Main Skills: saved into the agent folder, kept there, a taken name refused', () => {
  const { f, writer, other } = setup();
  try {
    f.skills.save({ name: 'house-style', description: 'Our house style for every text.', body: 'Short sentences.', ownerAgentId: writer.id, main: true });
    const folder = path.join(f.data, 'agents', writer.id, 'skills', 'house-style');
    assert.ok(existsSync(path.join(folder, 'SKILL.md')));
    const info = f.skills.list().find((skill) => skill.name === 'house-style')!;
    assert.deepEqual([info.source, info.ownerAgentId, info.main, info.path], ['agent', writer.id, true, folder]);
    f.skills.save({ name: 'house-style', description: 'Our house style, revised.', body: 'Shorter.', ownerAgentId: writer.id });
    assert.equal(f.skills.get('house-style')!.body, 'Shorter.');
    assert.equal(f.skills.get('house-style')!.info.main, true, 'a Main Skill saved again stays one');
    assert.ok(!existsSync(path.join(f.workspace, 'agents', writer.id, 'skills', 'house-style')), 'not written into the workspace');
    f.skills.save({ name: 'notes', description: 'A plain skill of the writer', body: 'x', ownerAgentId: writer.id });
    assert.throws(() => f.skills.save({ name: 'notes', description: 'A main one now', body: 'y', ownerAgentId: writer.id, main: true }), code('conflict'));
    f.skills.save({ name: 'shared', description: 'A workspace skill', body: 'x' });
    f.skills.save({ name: 'shared', description: 'My main copy', body: 'y', ownerAgentId: writer.id, main: true });
    assert.equal(f.skills.get('shared', writer.id)!.info.main, true, 'B-066 routes: an own main copy of a shared name');
    assert.equal(f.skills.get('shared')!.info.description, 'A workspace skill', 'the shared one stays for everyone else');
    assert.throws(() => f.skills.save({ name: 'lonely', description: 'No agent', body: 'z', main: true }), code('bad_request'));
  } finally { f.cleanup(); }
});

test('the prompt lists an agent\'s Main Skills apart from its index; other agents and suggestions leave them out', async () => {
  const { f, writer, other, services } = setup();
  try {
    f.skills.save({ name: 'house-style', description: 'Our house style for every text.', body: 'SECRET BODY', ownerAgentId: writer.id, main: true });
    f.skills.save({ name: 'checklist', description: 'Final checklist before sending a text.', body: 'Check.', ownerAgentId: writer.id, main: true });
    f.skills.save({ name: 'shared-tips', description: 'Tips for every agent', body: 'Tip.' });
    const writerNow = f.org.get(writer.id)!;
    const section = mainSkillsSection(services, writerNow);
    assert.equal(section, [
      '## My main skills',
      'My own core skills, kept in my agent folder. Before one of these kinds of work I load the skill\'s full text with skills.load (argument: the skill name).',
      '- checklist – Final checklist before sending a text.',
      '- house-style – Our house style for every text.',
    ].join('\n'));
    assert.ok(!section.includes('SECRET BODY'), 'never the full text');
    assert.deepEqual(f.skills.indexFor(writerNow, writing).map((skill) => skill.name), ['shared-tips'], 'the index leaves them out');
    assert.deepEqual(f.skills.indexFor(f.org.get(other.id)!, writing).map((skill) => skill.name), ['shared-tips'], 'another agent does not see them');
    assert.equal(mainSkillsSection(services, f.org.get(other.id)!), '');
  } finally { f.cleanup(); }
});

test('a SKILL.md put into the folder by hand is a Main Skill; a folder of an unknown agent is left alone', () => {
  const { f, writer } = setup();
  try {
    const dir = path.join(f.data, 'agents', writer.id, 'skills', 'by-hand');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), skillMd('by-hand', 'Written in an editor.'));
    const ghost = path.join(f.data, 'agents', 'ag_ghost', 'skills', 'ghost-skill');
    mkdirSync(ghost, { recursive: true });
    writeFileSync(path.join(ghost, 'SKILL.md'), skillMd('ghost-skill', 'No such agent.'));
    f.time.advance(5000); // the library re-checks its folders after its short cache
    assert.deepEqual(f.library.mainFor(f.org.get(writer.id)!).map((skill) => skill.name), ['by-hand']);
    assert.ok(!f.skills.list().some((skill) => skill.name === 'ghost-skill'));
  } finally { f.cleanup(); }
});

test('RPC: agents.core (chat; folder only for the owner) and agents.saveMainSkill (manage); people reach neither', async () => {
  const { f, writer, services } = setup();
  try {
    const table = new HandlerTable();
    register(table);
    const OWNER: ClientScope = { kind: 'owner' };
    const PHONE: ClientScope = { kind: 'device', deviceId: 'dev_p', capabilities: ['todo', 'chat'] };
    const MANAGER: ClientScope = { kind: 'device', deviceId: 'dev_m', capabilities: ['todo', 'chat', 'manage'] };
    const PERSON: ClientScope = { kind: 'person', personId: 'per_1', deviceId: 'dev_x', tokenId: 'tok_1' };
    const info = table.get('agents.core')!;
    const save = table.get('agents.saveMainSkill')!;
    assert.ok(allowedScope(info.scope, PHONE) && !allowedScope(save.scope, PHONE));
    assert.ok(allowedScope(save.scope, MANAGER));
    assert.ok(!allowedScope(info.scope, PERSON) && !allowedScope(save.scope, PERSON), 'default deny for people');
    const ctx = (scope: ClientScope) => ({ scope, services, extras: {}, topics: new Set(), signal: new AbortController().signal }) as unknown as HandlerContext;
    const saved = await save.handler({ agentId: writer.id, name: 'house-style', description: 'Our house style.', body: 'Short.' } as never, ctx(MANAGER)) as SkillInfo;
    assert.equal(saved.main, true);
    const owner = await info.handler({ agentId: writer.id } as never, ctx(OWNER)) as AgentCoreInfo;
    assert.equal(owner.folder, path.join(f.data, 'agents', writer.id));
    assert.deepEqual(owner.mainSkills.map((skill) => skill.name), ['house-style']);
    assert.equal(owner.inUse, true);
    const phone = await info.handler({ agentId: writer.id } as never, ctx(PHONE)) as AgentCoreInfo;
    assert.equal(phone.folder, undefined);
    await assert.rejects(async () => save.handler({ agentId: writer.id, name: 'Bad Name', description: 'd', body: 'b' } as never, ctx(OWNER)), code('bad_request'));
    await assert.rejects(async () => info.handler({ agentId: writer.id, extra: 1 } as never, ctx(OWNER)), code('bad_request'));
    f.org.archive(writer.id);
    await assert.rejects(async () => save.handler({ agentId: writer.id, name: 'later', description: 'd', body: 'b' } as never, ctx(OWNER)), code('conflict'));
    // Registered in the whole table.
    assert.ok(createHandlerTable().get('agents.core'));
  } finally { f.cleanup(); }
});

test('a hand-written SKILL.md that needs a fix is named in agents.core; without a description it is offered by its first sentence (B-078)', () => {
  const { f, writer, services } = setup();
  try {
    const base = path.join(f.data, 'agents', writer.id, 'skills');
    mkdirSync(path.join(base, 'no-text'), { recursive: true });
    writeFileSync(path.join(base, 'no-text', 'SKILL.md'), '---\nname: no-text\n---\n\nBody only.\n');
    mkdirSync(path.join(base, 'binary'), { recursive: true });
    writeFileSync(path.join(base, 'binary', 'SKILL.md'), Buffer.from([0x2d, 0x00]));
    f.time.advance(5000);
    const info = f.core.info(writer.id, false);
    assert.deepEqual(info.skillProblems, [{ folder: 'binary', problem: 'not-text' }, { folder: 'no-text', problem: 'no-description' }]);
    assert.match(mainSkillsSection(services, f.org.get(writer.id)!), /\n- no-text – Body only\.$/, 'B-078 D12: a missing description is the body\'s first sentence until one is generated');
  } finally { f.cleanup(); }
});
