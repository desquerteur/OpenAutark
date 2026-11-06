// SkillLibrary (discovery, precedence, cache invalidation, mode index, save/remove) and
// ModeLibrary (front matter parsing, general fallback). Uses a temp directory as the fake fs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import { GENERAL_MODE, ModeLibrary } from '../../../src/runtime/modes/service.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

function writeSkill(dir: string, name: string, front: string, body = 'Steps.') {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`);
}

function agent(id: string, skills: string[] = []): Agent {
  return { id, name: id, role: '', avatar: { kind: 'initials', value: 'A' }, instructions: '', mode: 'general', skills,
    modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0 };
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-skills-'));
  const resources = path.join(root, 'resources');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  writeSkill(path.join(resources, 'skills'), 'remotion', 'name: remotion\ndescription: >\n  Build videos with Remotion.\n  Use for animation.\nmodes: [video]');
  writeSkill(path.join(resources, 'skills'), 'writing-style', 'name: writing-style\ndescription: "House style: short sentences"');
  writeSkill(path.join(workspace, 'skills'), 'writing-style', 'name: writing-style\ndescription: User override');
  writeSkill(path.join(home, '.codex', 'skills'), 'codex-helper', 'name: codex-helper\ndescription: Imported\nmodes:\n  - web\n  - general');
  writeSkill(path.join(workspace, 'agents', 'ag_a', 'skills'), 'my-trick', 'name: my-trick\ndescription: Only for agent a');
  const clock = new ManualClock();
  const skills = new SkillLibrary({ paths: { workspace, resources }, clock, home });
  return { root, resources, workspace, clock, skills };
}

test('front matter subset: block scalars, lists, quotes', () => {
  const parsed = parseFrontMatter('---\nname: x\ndescription: |\n  line one\n  line two\ntools:\n  - a.*\n  - b\nn: 3\nok: true\n---\nBody here');
  assert.equal(parsed.data.description, 'line one\nline two');
  assert.deepEqual(parsed.data.tools, ['a.*', 'b']);
  assert.equal(parsed.data.n, 3);
  assert.equal(parsed.data.ok, true);
  assert.equal(parsed.body, 'Body here');
  assert.deepEqual(parseFrontMatter('no front matter').data, {});
});

test('skills: precedence user > imported > builtin, read-only sources', () => {
  const { root, skills } = fixture();
  try {
    const list = skills.list();
    assert.deepEqual(list.map(info => info.name), ['codex-helper', 'my-trick', 'remotion', 'writing-style']);
    assert.equal(skills.get('writing-style')!.info.description, 'User override');
    assert.equal(skills.get('remotion')!.info.description, 'Build videos with Remotion. Use for animation.');
    assert.equal(skills.get('remotion')!.body, 'Steps.');
    assert.equal(skills.get('my-trick')!.info.ownerAgentId, 'ag_a');
    assert.throws(() => skills.remove('remotion'), /built in or imported/);
    assert.throws(() => skills.remove('codex-helper'), /built in or imported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skills: indexFor filters by mode and owner, explicit skills first', () => {
  const { root, skills } = fixture();
  try {
    const video = { ...GENERAL_MODE, key: 'video', skills: [] };
    assert.deepEqual(skills.indexFor(agent('ag_a'), video).map(info => info.name), ['my-trick', 'remotion', 'writing-style']);
    assert.deepEqual(skills.indexFor(agent('ag_b'), GENERAL_MODE).map(info => info.name), ['codex-helper', 'writing-style']);
    // agent.skills pulls a mode-restricted skill in, and it sorts first
    assert.deepEqual(skills.indexFor(agent('ag_b', ['remotion']), GENERAL_MODE).map(info => info.name), ['remotion', 'codex-helper', 'writing-style']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skills: save/remove and cache invalidation on external edits', () => {
  const { root, workspace, clock, skills } = fixture();
  try {
    const saved = skills.save({ name: 'upload-flow', description: 'Upload: YouTube steps', body: '1. Open studio', ownerAgentId: 'ag_a' });
    assert.equal(saved.source, 'agent');
    assert.equal(skills.get('upload-flow')!.body, '1. Open studio');
    const updated = skills.save({ name: 'upload-flow', description: 'Upload: YouTube steps v2', body: '1. Open studio', ownerAgentId: 'ag_b' });
    assert.equal(updated.ownerAgentId, 'ag_b', 'B-066 routes: another agent\'s name becomes an own copy');
    assert.equal(skills.get('upload-flow', 'ag_a')!.info.description, 'Upload: YouTube steps', 'the first agent keeps its own');
    rmSync(path.join(workspace, 'agents', 'ag_b', 'skills', 'upload-flow'), { recursive: true, force: true });
    skills.invalidate();
    assert.throws(() => skills.save({ name: 'Bad Name', description: 'x', body: 'y' }), /lowercase/);
    skills.remove('upload-flow');
    assert.equal(skills.get('upload-flow'), undefined);

    // external edit: picked up after the cache window via mtime signature
    const file = path.join(workspace, 'skills', 'writing-style', 'SKILL.md');
    writeFileSync(file, '---\nname: writing-style\ndescription: Edited outside\n---\nNew');
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    clock.advance(5000);
    assert.equal(skills.get('writing-style')!.info.description, 'Edited outside');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('modes: loads files, falls back to general', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-modes-'));
  try {
    const clock = new ManualClock();
    const empty = new ModeLibrary({ resources: root, clock });
    assert.equal(empty.get('video').key, 'general');
    assert.deepEqual(empty.list().map(mode => mode.key), ['general']);

    mkdirSync(path.join(root, 'modes'));
    writeFileSync(path.join(root, 'modes', 'video.md'),
      '---\nname: Video\ndescription: Edit and animate videos\nskills: [remotion]\ntools: [files.*, video.*]\ncategory: video-animation\nworkspace: video\nminTier: strong\nverifier: Render plays\n---\nYou edit videos.');
    writeFileSync(path.join(root, 'modes', 'broken.md'), '---\nkey: "Bad Key!"\n---\nx');
    const modes = new ModeLibrary({ resources: root, clock });
    const video = modes.get('video');
    assert.equal(video.category, 'video-animation');
    assert.deepEqual(video.tools, ['files.*', 'video.*']);
    assert.equal(video.workspace, 'video');
    assert.equal(video.minTier, 'strong');
    assert.equal(video.instructions, 'You edit videos.');
    assert.deepEqual(modes.list().map(mode => mode.key), ['general', 'video']);
    assert.equal(modes.get('nope').key, 'general');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agentskills metadata.modes is read; real resources parse', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-meta-'));
  try {
    writeSkill(path.join(root, 'skills'), 'books', 'name: books\ndescription: Keep books.\nmetadata:\n  modes:\n    - finance\n    - secretary');
    const skills = new SkillLibrary({ paths: { workspace: path.join(root, 'ws'), resources: root }, clock: new ManualClock(), home: '' });
    assert.deepEqual(skills.get('books')!.info.modes, ['finance', 'secretary']);
    assert.deepEqual(parseFrontMatter('---\nmetadata:\n  modes: [a, b]\n  x: 1\n---\n').data.metadata, { modes: ['a', 'b'], x: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }

  const resources = path.resolve('resources');
  const real = new SkillLibrary({ paths: { workspace: path.join(os.tmpdir(), 'wf-none'), resources }, clock: new ManualClock(), home: '' });
  const list = real.list();
  assert.ok(list.length > 0);
  assert.ok(list.every(info => info.description.length > 10), 'every shipped skill has a description');
  const modes = new ModeLibrary({ resources, clock: new ManualClock() });
  const keys = modes.list().map(mode => mode.key);
  assert.ok(keys.includes('video') && keys.includes('general'));
  assert.equal(modes.get('video').category, 'video-animation');
  assert.ok(modes.get('video').skills.includes('remotion-video'));
  assert.ok(list.find(info => info.name === 'remotion-video')!.modes.includes('video'));
});

test('G1: the app\'s own skills are in no mode\'s index – a query still finds them, no mode offers them as its own', () => {
  const resources = path.resolve('resources');
  const real = new SkillLibrary({ paths: { workspace: path.join(os.tmpdir(), 'wf-none'), resources }, clock: new ManualClock(), home: '' });
  const modes = new ModeLibrary({ resources, clock: new ManualClock() });
  const app = ['app-settings', 'app-look', 'app-guide', 'phone-access', 'whatsapp-bridge'];
  for (const name of app) assert.ok(real.get(name), `${name} stays a shipped skill`);
  for (const mode of modes.list()) {
    const own = [...real.indexFor(agent('ag_x'), mode).map(info => info.name), ...mode.skills];
    assert.deepEqual(own.filter(name => app.includes(name)), [], `mode ${mode.key}`);
  }
  for (const key of ['manager', 'general', 'secretary']) {
    assert.ok(!real.indexFor(agent('ag_x'), modes.get(key)).some(info => info.name === 'telegram-setup'), `telegram-setup in ${key}`);
  }
});
