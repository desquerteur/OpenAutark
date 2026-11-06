// Wave 3: agent core folders travel like the rest of the data.
// - a backup carries <data>/agents (SYSTEM.md, agent.json, Main Skills with every file) and a restore brings it back
//   with the database, keeping the replaced folders in the fallback copy; the next start finds both in step;
// - a backup made before (no agents/) restores every agent's instructions from its database: the start writes them;
// - an agent file carries the folder's texts (SYSTEM.md, agent.json, Main Skills) without paths;
// - a home folder belongs to its PC: restored on the same PC it stays; an agent file never carries it.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AgentCore } from '../../../src/runtime/agent-core/service.ts';
import { mainSkillRoots, mainSkillsDir } from '../../../src/runtime/agent-core/layout.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { applyPendingRestore } from '../../../src/runtime/portability/restore.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { RESOURCES, recordingBus } from '../store/helpers.ts';
import { portabilityFixture, SECRET_VALUE, type PortabilityFixture } from '../portability/fixture.ts';

function withCore(f: PortabilityFixture, org: Org = f.org) {
  const library = new SkillLibrary({
    paths: { workspace: f.paths.workspace, resources: RESOURCES }, clock: f.time, home: '',
    mainRoots: () => mainSkillRoots(f.paths.data, (id) => org.get(id) !== undefined), mainDir: (id) => mainSkillsDir(f.paths.data, id),
  });
  Object.assign(f.s, { skills: library });
  const core = new AgentCore({ dataDir: f.paths.data, org: () => org, skills: () => library, bus: recordingBus().bus, clock: f.time, log: new MemoryLogger(), defer: () => {} });
  org.setCoreFiles(core);
  Object.assign(f.s, { agentCore: core });
  core.start();
  return { library, core };
}

const text = (...parts: string[]) => readFileSync(path.join(...parts), 'utf8');

test('backup carries the agent folders; restore brings them back with the database, the replaced ones kept', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const { library, core } = withCore(f);
    const agent = f.org.create({ name: 'Writer', instructions: 'Backed up.', createdBy: 'human' });
    library.save({ name: 'house-style', description: 'Our house style.', body: 'Short.', ownerAgentId: agent.id, main: true });
    const skillDir = path.join(f.paths.data, 'agents', agent.id, 'skills', 'house-style');
    writeFileSync(path.join(skillDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    mkdirSync(path.join(skillDir, 'references'));
    writeFileSync(path.join(skillDir, 'references', 'tone.md'), '# Tone');

    const backup = await f.portability.backup();
    assert.equal(text(backup.path, 'agents', agent.id, 'SYSTEM.md'), 'Backed up.\n');
    assert.ok(existsSync(path.join(backup.path, 'agents', agent.id, 'agent.json')));
    assert.equal(text(backup.path, 'agents', agent.id, 'skills', 'house-style', 'references', 'tone.md'), '# Tone');
    assert.ok(existsSync(path.join(backup.path, 'agents', agent.id, 'skills', 'house-style', 'logo.png')), 'the whole folder travels');

    f.org.update(agent.id, { instructions: 'Changed later.' });
    rmSync(skillDir, { recursive: true, force: true });
    await f.portability.restore(backup.path);
    core.stop();
    f.db.close();
    assert.equal(applyPendingRestore(f.paths.data, new MemoryLogger(), { now: f.time.now(), workspace: f.paths.workspace }), true);
    assert.equal(text(f.paths.data, 'agents', agent.id, 'SYSTEM.md'), 'Backed up.\n');
    assert.ok(existsSync(path.join(skillDir, 'SKILL.md')), 'the Main Skill is back');
    const fallback = readdirSync(f.paths.data).find((name) => name.startsWith('before-restore-'))!;
    assert.equal(text(f.paths.data, fallback, 'agents', agent.id, 'SYSTEM.md'), 'Changed later.\n', 'the replaced folder is kept');

    // The next start: database and files agree, nothing to take over.
    const db = new Db(path.join(f.paths.data, 'workforce.db'));
    migrate(db);
    const org = new Org({ db, bus: recordingBus().bus, clock: f.time, templatesDir: path.join(RESOURCES, 'agents') });
    const again = withCore(f, org);
    assert.equal(org.get(agent.id)!.instructions, 'Backed up.');
    assert.equal(again.core.info(agent.id, false).notice, undefined);
    again.core.stop();
    db.close();
  } finally { f.cleanup(); }
});

test('a backup without agent folders (made before) restores the instructions from its database', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    const { core } = withCore(f);
    const agent = f.org.create({ name: 'Writer', instructions: 'From the old backup.', createdBy: 'human' });
    const backup = await f.portability.backup();
    rmSync(path.join(backup.path, 'agents'), { recursive: true, force: true });
    f.org.update(agent.id, { instructions: 'Newer text.' });
    await f.portability.restore(backup.path);
    core.stop();
    f.db.close();
    assert.equal(applyPendingRestore(f.paths.data, new MemoryLogger(), { now: f.time.now(), workspace: f.paths.workspace }), true);
    assert.ok(!existsSync(path.join(f.paths.data, 'agents')), 'the live folders went aside with the old database');
    const db = new Db(path.join(f.paths.data, 'workforce.db'));
    migrate(db);
    const org = new Org({ db, bus: recordingBus().bus, clock: f.time, templatesDir: path.join(RESOURCES, 'agents') });
    const again = withCore(f, org);
    assert.equal(text(f.paths.data, 'agents', agent.id, 'SYSTEM.md'), 'From the old backup.\n');
    assert.equal(again.core.info(agent.id, false).notice, undefined, 'written silently, like the first migration');
    again.core.stop();
    db.close();
  } finally { f.cleanup(); }
});

test('an agent file carries the folder texts and Main Skills, no paths and no secrets', async () => {
  const f = portabilityFixture();
  try {
    const { library } = withCore(f);
    const agent = f.org.create({ name: 'Writer', instructions: `Never share ${SECRET_VALUE}.`, createdBy: 'human' });
    library.save({ name: 'house-style', description: 'Our house style.', body: 'Short.', ownerAgentId: agent.id, main: true });
    const file = await f.portability.exportAgent(agent.id);
    const raw = new TextDecoder().decode(await f.files.read(file.id));
    const doc = JSON.parse(raw) as { format: string; agent: { name: string }; files: Record<string, string> };
    assert.equal(doc.format, 'workforce-agent');
    assert.equal(doc.agent.name, 'Writer');
    assert.ok(Object.keys(doc.files).some((rel) => rel.replace(/\\/g, '/') === 'skills/house-style/SKILL.md'), Object.keys(doc.files).join(', '));
    assert.ok(!raw.includes(SECRET_VALUE), 'the secret is redacted');
    assert.ok(!raw.includes(JSON.stringify(f.paths.data).slice(1, -1)), 'no paths');
  } finally { f.cleanup(); }
});

/** This PC's device identity and self device (what tells a restore whether the backup came from here). */
function thisPc(f: PortabilityFixture, id: string): void {
  f.db.run('DELETE FROM devices WHERE self = 1');
  f.db.run(`DELETE FROM kv WHERE ns = 'device' AND key = 'identity'`);
  f.db.run(`INSERT INTO kv (ns, key, value, updated_at) VALUES ('device', 'identity', ?, 1)`, [JSON.stringify({ tag: id })]);
  f.db.run(`INSERT INTO devices (id, name, kind, role, fingerprint, self) VALUES (?, 'PC', 'pc', 'home', ?, 1)`, [id, `fp_${id}`]);
}

/** Two agents with a home on disk (the person's edit of agent.json): one outside the workspace, one inside it. */
function withHomes(f: PortabilityFixture) {
  const outside = path.join(f.root, 'projects', 'site');
  const inside = path.join(f.paths.workspace, 'notes');
  mkdirSync(outside, { recursive: true });
  mkdirSync(inside, { recursive: true });
  const far = f.org.create({ name: 'Far', instructions: 'Outside.', createdBy: 'human' });
  const near = f.org.create({ name: 'Near', instructions: 'Inside.', createdBy: 'human' });
  const file = (id: string) => path.join(f.paths.data, 'agents', id, 'agent.json');
  for (const [id, home] of [[far.id, outside], [near.id, inside]] as const) writeFileSync(file(id), JSON.stringify({ ...JSON.parse(text(file(id))), home }, null, 2));
  const manifest = (id: string) => JSON.parse(text(file(id))) as { id: string; name: string; home?: string };
  return { far, near, outside, inside, manifest };
}

async function backupAndRestore(f: PortabilityFixture, core: AgentCore, before?: () => void): Promise<void> {
  const backup = await f.portability.backup();
  before?.();
  await f.portability.restore(backup.path);
  core.stop();
  f.db.close();
  assert.equal(applyPendingRestore(f.paths.data, new MemoryLogger(), { now: f.time.now(), workspace: f.paths.workspace }), true);
}

test('restored on the same PC the approved home stays', async () => {
  const f = portabilityFixture({ fileDb: true });
  try {
    thisPc(f, 'dev_here');
    const { core } = withCore(f);
    const { far, outside, manifest } = withHomes(f);
    await backupAndRestore(f, core);
    assert.equal(manifest(far.id).home, outside);
    assert.equal((JSON.parse(text(f.paths.data, 'restore-result.json')) as { homes?: unknown }).homes, undefined, 'nothing cleared, nothing named');
  } finally { f.cleanup(); }
});

test('an agent file never carries the home', async () => {
  const f = portabilityFixture();
  try {
    withCore(f);
    const { far, outside } = withHomes(f);
    const file = await f.portability.exportAgent(far.id);
    const raw = new TextDecoder().decode(await f.files.read(file.id));
    assert.ok(!raw.includes(JSON.stringify(outside).slice(1, -1)) && !raw.includes('\\"home\\"'), raw.slice(0, 300));
  } finally { f.cleanup(); }
});
