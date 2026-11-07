// AF-007: installing skills from a link (every download is a fake fetch – nothing reaches the network): a GitHub folder
// link → preview → install into each place (shared, an agent's own, an agent's home project), found by skills.find; the
// SKILL.md stays byte for byte a Claude Code skill; scripts are saved, never run; a taken name refuses the whole install;
// several skills of a repository to choose from; a SKILL.md address; an uploaded ZIP; previews expire.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { SkillLinks, PREVIEW_MS, type SkillLinksDeps } from '../../../src/runtime/skills/links/service.ts';
import { readRecord } from '../../../src/runtime/skills/links/install.ts';
import { discoverSkills } from '../../../src/runtime/skills/discover.ts';
import { findSkills } from '../../../src/runtime/tools/builtin/skills-find.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { COMMIT, fakeFetch, githubZip, library, skillMd, zip } from './links-fixture.ts';

const agent = (id: string, name = id): Agent => ({ id, name, role: '', avatar: { kind: 'initials', value: 'A' }, instructions: '', mode: 'general', skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0 });
const PDF_MD = skillMd('pdf', 'Fill and read PDF forms. Use when a task involves PDF files.');
const MARKER = 'ran.txt';

/** anthropics/skills as a GitHub archive: two skills under skills/, one with a script that would leave a marker if it ran. */
function anthropicsArchive(pdf = PDF_MD, extra: Record<string, string> = {}) {
  return githubZip('skills-main', {
    'README.md': '# Skills',
    'skills/pdf/SKILL.md': pdf,
    'skills/pdf/forms.md': '# Forms\nStep one.\nStep two.\n',
    'skills/pdf/scripts/fill.py': `open(${JSON.stringify(MARKER)}, "w").write("ran")\n`,
    'skills/docx/SKILL.md': skillMd('docx', 'Create Word documents.'),
    ...extra,
  });
}

const ARCHIVE = 'https://github.com/anthropics/skills/archive/main.zip';

function setup(table: Record<string, Buffer | number> = { [ARCHIVE]: anthropicsArchive() }) {
  const lib = library();
  const home = path.join(lib.root, 'project');
  mkdirSync(home, { recursive: true });
  const agents = [agent('ada', 'Ada'), agent('ben', 'Ben')];
  const uploads = new Map<string, { ref: FileRef; bytes: Buffer }>();
  const changed: string[] = [];
  const fetch = fakeFetch(table);
  let ids = 0;
  const deps: SkillLinksDeps = {
    fetch, clock: lib.clock, skills: lib.skills, agents: () => agents,
    home: (id) => (id === 'ada' ? home : undefined),
    files: { get: (id) => uploads.get(id)?.ref, read: async (id) => uploads.get(id)!.bytes },
    changed: ({ name }) => { lib.skills.invalidate(); changed.push(name); },
    id: () => `p${++ids}`,
  };
  const upload = (name: string, bytes: Buffer): string => {
    const id = String(uploads.size + 1).padStart(64, '0');
    uploads.set(id, { ref: { id, name, mime: 'application/zip', size: bytes.byteLength, createdAt: 0 }, bytes });
    return id;
  };
  return { ...lib, home, agents, links: new SkillLinks(deps), fetch, changed, upload, done: () => rmSync(lib.root, { recursive: true, force: true }) };
}

test('a GitHub folder link is previewed, installed into the shared library and found by skills.find', async () => {
  const t = setup();
  try {
    const preview = await t.links.preview({ url: 'https://github.com/anthropics/skills/tree/main/skills/pdf' });
    assert.deepEqual(t.fetch.calls, [ARCHIVE], 'one download: the first split of /tree/ is the branch');
    assert.equal(preview.source.kind, 'github');
    assert.deepEqual({ repo: preview.source.repo, ref: preview.source.ref, folder: preview.source.folder }, { repo: 'anthropics/skills', ref: 'main', folder: 'skills/pdf' });
    assert.equal(preview.skills.length, 1);
    const [pdf] = preview.skills;
    assert.equal(pdf!.name, 'pdf');
    assert.equal(pdf!.description, 'Fill and read PDF forms. Use when a task involves PDF files.');
    assert.deepEqual(pdf!.files.map((file) => file.path), ['SKILL.md', 'forms.md', 'scripts/fill.py']);
    assert.deepEqual(pdf!.scripts, ['scripts/fill.py']);
    assert.equal(readdirSync(t.root).includes('workspace'), false, 'a preview writes nothing');

    const { installed } = await t.links.install({ previewId: preview.id, routes: [''], target: { kind: 'shared' } });
    const dir = path.join(t.workspace, 'skills', 'pdf');
    assert.deepEqual(installed.map((skill) => [skill.name, skill.path, skill.place]), [['pdf', dir, 'Shared']]);
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), PDF_MD, 'SKILL.md stays byte for byte (license, allowed-tools kept)');
    assert.equal(readFileSync(path.join(dir, 'scripts', 'fill.py'), 'utf8'), `open(${JSON.stringify(MARKER)}, "w").write("ran")\n`);
    assert.equal(existsSync(path.join(dir, MARKER)) || existsSync(MARKER) || existsSync(path.join(t.root, MARKER)), false, 'the script was saved, not run');
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'scripts', 'fill.py')).mode & 0o111, 0, 'no executable bit');
    assert.equal(existsSync(path.join(t.workspace, 'skills', '.installing')), false, 'the staging folder is gone');
    const record = readRecord(dir)!;
    assert.equal(record.source.url, 'https://github.com/anthropics/skills/tree/main/skills/pdf');
    assert.equal(record.commit, COMMIT);
    assert.deepEqual(Object.keys(record.files).sort(), ['SKILL.md', 'forms.md', 'scripts/fill.py']);
    assert.deepEqual(t.changed, ['pdf']);

    const services = { skills: t.skills } as unknown as RuntimeServices;
    const hits = findSkills(services, t.agents[0]!, GENERAL_MODE, 'fill a pdf form');
    assert.equal(hits[0]?.info.name, 'pdf', 'skills.find finds the installed skill');
    assert.equal(t.skills.get('pdf', 'ben')?.info.path, dir, 'shared: every agent');
    assert.deepEqual(t.links.linked().map((skill) => [skill.name, skill.place, skill.source.repo]), [['pdf', 'Shared', 'anthropics/skills']]);
  } finally { t.done(); }
});

test('a repository with several skills lists them to choose from; only the chosen ones are installed, into an agent\'s own skills', async () => {
  const t = setup({ 'https://github.com/anthropics/skills/archive/HEAD.zip': anthropicsArchive() });
  try {
    const preview = await t.links.preview({ url: 'https://github.com/anthropics/skills' });
    assert.deepEqual(preview.skills.map((skill) => [skill.route, skill.name]), [['skills/docx', 'docx'], ['skills/pdf', 'pdf']]);
    assert.equal(preview.source.ref, undefined, 'the default branch');
    await t.links.install({ previewId: preview.id, routes: ['skills/docx'], target: { kind: 'agent', agentId: 'ben' } });
    const dir = path.join(t.workspace, 'agents', 'ben', 'skills', 'docx');
    assert.ok(existsSync(path.join(dir, 'SKILL.md')));
    assert.equal(existsSync(path.join(t.workspace, 'agents', 'ben', 'skills', 'pdf')), false);
    assert.equal(t.skills.get('docx', 'ben')?.info.path, dir, 'ben\'s own');
    assert.equal(t.skills.get('docx', 'ada')?.info.ownerAgentId, 'ben', 'another agent\'s skill stays loadable by name, not routed');
    assert.equal(findSkills({ skills: t.skills } as unknown as RuntimeServices, t.agents[1]!, GENERAL_MODE, 'word documents')[0]?.info.name, 'docx');
    assert.deepEqual(t.links.linked().map((skill) => skill.place), ['Own · Ben']);
    await assert.rejects(t.links.install({ previewId: preview.id, routes: ['skills/none'], target: { kind: 'shared' } }), /no skill in skills\/none/);
    await assert.rejects(t.links.install({ previewId: preview.id, routes: ['skills/pdf'], target: { kind: 'agent', agentId: 'nobody' } }), /no such agent/);
  } finally { t.done(); }
});

test('an agent\'s home project gets the skill in .claude/skills, where Claude Code and the home discovery find it', async () => {
  const t = setup();
  try {
    const targets = t.links.targets();
    assert.deepEqual(targets.map((entry) => entry.target), [{ kind: 'shared' }, { kind: 'agent', agentId: 'ada' }, { kind: 'agent', agentId: 'ben' }, { kind: 'project', agentId: 'ada' }]);
    assert.equal(targets[3]!.folder, path.join(t.home, '.claude', 'skills'));
    const preview = await t.links.preview({ url: 'https://github.com/anthropics/skills/tree/main/skills/pdf' });
    await t.links.install({ previewId: preview.id, routes: [''], target: { kind: 'project', agentId: 'ada' } });
    const found = discoverSkills(t.home, { authority: 'external', describe: true });
    assert.deepEqual(found.skills.map((skill) => [skill.name, skill.route]), [['pdf', '.claude/skills/pdf']]);
    assert.deepEqual(t.links.linked().map((skill) => [skill.name, skill.place]), [['pdf', 'Project · Ada']]);
    await assert.rejects(t.links.install({ previewId: preview.id, routes: [''], target: { kind: 'project', agentId: 'ben' } }), /no home project/);
  } finally { t.done(); }
});

test('a taken name in the place refuses the whole install and changes nothing', async () => {
  const t = setup({ 'https://github.com/anthropics/skills/archive/HEAD.zip': anthropicsArchive() });
  try {
    const preview = await t.links.preview({ url: 'anthropics/skills' });
    await t.links.install({ previewId: preview.id, routes: ['skills/pdf'], target: { kind: 'shared' } });
    const before = readFileSync(path.join(t.workspace, 'skills', 'pdf', 'SKILL.md'), 'utf8');
    await assert.rejects(t.links.install({ previewId: preview.id, routes: ['skills/docx', 'skills/pdf'], target: { kind: 'shared' } }), (error: Error & { code?: string }) => error.code === 'conflict' && /pdf is already installed/.test(error.message));
    assert.equal(existsSync(path.join(t.workspace, 'skills', 'docx')), false, 'nothing of the refused install is written');
    assert.equal(readFileSync(path.join(t.workspace, 'skills', 'pdf', 'SKILL.md'), 'utf8'), before);
  } finally { t.done(); }
});

test('a /tree/ link whose first split is no branch tries the next; a missing repository or folder says so', async () => {
  const t = setup({
    'https://github.com/o/r/archive/feature.zip': githubZip('r-feature', { 'other/SKILL.md': skillMd('other', 'Other') }),
    'https://github.com/o/r/archive/feature/x.zip': githubZip('r-feature-x', { 'skills/pdf/SKILL.md': PDF_MD }),
  });
  try {
    const preview = await t.links.preview({ url: 'https://github.com/o/r/tree/feature/x/skills/pdf' });
    assert.deepEqual(t.fetch.calls, ['https://github.com/o/r/archive/feature.zip', 'https://github.com/o/r/archive/feature/x.zip']);
    assert.equal(preview.source.ref, 'feature/x');
    assert.equal(preview.source.folder, 'skills/pdf');
    await assert.rejects(t.links.preview({ url: 'https://github.com/o/missing' }), (error: Error & { code?: string }) => error.code === 'not_found' && /no such repository/.test(error.message));
    await assert.rejects(t.links.preview({ url: 'https://github.com/o/r/tree/feature/nothing-here' }), /no such folder/);
  } finally { t.done(); }
});

test('a SKILL.md address installs that file; an uploaded ZIP installs its skill; a link without a skill says so', async () => {
  const t = setup({
    'https://example.com/skills/notes/SKILL.md': Buffer.from('---\ndescription: Keep meeting notes.\n---\n# Notes\n'),
    'https://example.com/empty.zip': zip([{ name: 'README.md', data: '# nothing' }]),
    'https://example.com/limited/SKILL.md': 429,
  });
  try {
    const file = await t.links.preview({ url: 'https://example.com/skills/notes/SKILL.md' });
    assert.deepEqual(file.skills.map((skill) => [skill.name, skill.files.length]), [['notes', 1]]);
    await t.links.install({ previewId: file.id, routes: [''], target: { kind: 'shared' } });
    assert.match(readFileSync(path.join(t.workspace, 'skills', 'notes', 'SKILL.md'), 'utf8'), /Keep meeting notes/);

    const fileId = t.upload('report-writer.zip', zip([{ name: 'report-writer/SKILL.md', data: skillMd('report-writer', 'Write reports.') }, { name: 'report-writer/run.ps1', data: 'Remove-Item C:\\' }]));
    const uploaded = await t.links.preview({ fileId });
    assert.equal(uploaded.source.kind, 'upload');
    assert.deepEqual(uploaded.skills[0]!.scripts, ['run.ps1']);
    await t.links.install({ previewId: uploaded.id, routes: ['report-writer'], target: { kind: 'shared' } });
    assert.equal(readFileSync(path.join(t.workspace, 'skills', 'report-writer', 'run.ps1'), 'utf8'), 'Remove-Item C:\\');

    await assert.rejects(t.links.preview({ url: 'https://example.com/empty.zip' }), /holds no skill/);
    await assert.rejects(t.links.preview({ url: 'https://example.com/limited/SKILL.md' }), (error: Error & { code?: string }) => error.code === 'rate_limited');
    await assert.rejects(t.links.preview({ url: 'https://example.com/a', fileId }), /not both/);
    await assert.rejects(t.links.preview({ fileId: 'f'.repeat(64) }), /upload it again/);
  } finally { t.done(); }
});

test('a preview expires; the oldest goes beyond four', async () => {
  const t = setup();
  try {
    const url = 'https://github.com/anthropics/skills/tree/main/skills/pdf';
    const first = await t.links.preview({ url });
    t.clock.advance(PREVIEW_MS + 1);
    await assert.rejects(t.links.install({ previewId: first.id, routes: [''], target: { kind: 'shared' } }), /expired/);
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push((await t.links.preview({ url })).id);
    await assert.rejects(t.links.install({ previewId: ids[0]!, routes: [''], target: { kind: 'shared' } }), /expired/);
    await t.links.install({ previewId: ids[4]!, routes: [''], target: { kind: 'shared' } });
  } finally { t.done(); }
});
