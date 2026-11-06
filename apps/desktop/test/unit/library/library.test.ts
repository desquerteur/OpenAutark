// B-078 D13: the public library (runtime/library/): index-only lists (JSON and Markdown links), sources typed as owner/repo
// or a URL, a shallow clone through a fake git, the entries of a cloned source, and publishing – off, a stored secret, a
// path of this PC, the model check, gh missing or signed out, and the GitHub calls of a pull request.
// Owns: these assertions only. Never: network, a real git or gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIndex, readIndex } from '../../../src/runtime/library/import.ts';
import { addSource, libraryEntries, listSources, sourceOf, sourceStates, syncSource, DEFAULT_SOURCES } from '../../../src/runtime/library/sources.ts';
import { publishEntry, publishedText, type PublishDeps } from '../../../src/runtime/library/publish.ts';
import type { Run, RunResult } from '../../../src/runtime/library/exec.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';

const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'library-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test('index-only lists: JSON (marketplace style) and Markdown links, each name once, no bodies', () => {
  const json = parseIndex(JSON.stringify({ plugins: [
    { name: 'PDF Tools', description: 'Fill and merge PDF forms.', source: './pdf' },
    { name: 'pdf tools', description: 'Duplicate name.' },
    { name: 'no-description' },
  ] }), 'demo', 'https://example.org/list.json');
  assert.deepEqual(json, [{ source: 'demo', name: 'pdf-tools', description: 'Fill and merge PDF forms.', url: 'https://example.org/pdf' }]);
  const markdown = parseIndex([
    '# Awesome skills', '- [Git Helper](https://github.com/a/git-helper) - Writes commit messages from the diff.',
    '* **[Data Viz](https://github.com/b/viz)** – Charts from CSV files in one call.', '- [Short](https://x.org) - tiny', 'Some prose.',
    '- [Bad](javascript:alert(1)) - A link that is no web address at all.',
  ].join('\n'), 'list', 'https://raw.githubusercontent.com/x/y/main/README.md');
  assert.deepEqual(markdown.map((entry) => [entry.name, entry.url]), [['git-helper', 'https://github.com/a/git-helper'], ['data-viz', 'https://github.com/b/viz']]);
  assert.equal(markdown[1].description, 'Charts from CSV files in one call.');
});

test('sources: the shipped ones, owner/repo and list URLs typed, an added one kept', () => {
  assert.deepEqual(DEFAULT_SOURCES.filter((source) => source.kind === 'git').map((source) => source.repo), ['teydra/OpenAutark', 'anthropics/skills', 'obra/superpowers', 'K-Dense-AI/claude-scientific-skills']);
  assert.deepEqual(sourceOf('https://github.com/Someone/niche-skills.git'), { id: 'someone-niche-skills', kind: 'git', repo: 'Someone/niche-skills' });
  assert.equal(sourceOf('owner/repo')?.repo, 'owner/repo');
  assert.equal(sourceOf('https://example.org/skills/index.json')?.kind, 'index');
  assert.equal(sourceOf('http://example.org/x.json'), undefined, 'only https lists');
  assert.equal(sourceOf('not a source'), undefined);
  const t = temp();
  try {
    addSource(t.dir, { id: 'someone-niche-skills', kind: 'git', repo: 'Someone/niche-skills' });
    assert.ok(listSources(t.dir).some((source) => source.id === 'someone-niche-skills' && !source.builtin));
  } finally { t.done(); }
});

test('sync: a shallow clone the first time, fetch + reset after; a cloned source lists its SKILL.md entries as external', async () => {
  const t = temp();
  try {
    const calls: string[][] = [];
    const run: Run = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'clone') {
        const target = args[args.length - 1];
        mkdirSync(path.join(target, '.git'), { recursive: true });
        mkdirSync(path.join(target, 'skills', 'pdf'), { recursive: true });
        writeFileSync(path.join(target, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n# PDF\nFill and merge PDF forms.');
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    let now = 1000;
    const deps = { dataDir: t.dir, git: () => '/usr/bin/git', run, now: () => now };
    const source = { id: 'anthropics-skills', kind: 'git' as const, repo: 'anthropics/skills' };
    const state = await syncSource(deps, source);
    assert.deepEqual(calls[0].slice(0, 5), ['clone', '--depth', '1', '--single-branch', '--no-tags']);
    assert.equal(calls[0][5], 'https://github.com/anthropics/skills.git');
    assert.equal(state.entries, 1);
    now = 2000;
    await syncSource(deps, source);
    assert.deepEqual(calls.slice(1).map((args) => args[2]), ['fetch', 'reset']);
    const [entry] = libraryEntries(t.dir, now).filter((item) => item.source === 'anthropics-skills');
    assert.equal(entry.name, 'pdf');
    assert.equal(entry.description, 'PDF: Fill and merge PDF forms.', 'no description: heading + first sentence');
    assert.match(entry.url ?? '', /github\.com\/anthropics\/skills\/blob\/HEAD\/skills\/pdf\/SKILL\.md$/);
    const missing = await syncSource({ ...deps, git: () => undefined }, { id: 'superpowers', kind: 'git', repo: 'obra/superpowers' });
    assert.equal(missing.problem, 'git is not installed on this PC');
    assert.ok(sourceStates(t.dir).some((item) => item.source.id === 'anthropics-skills' && item.syncedAt === 2000));
  } finally { t.done(); }
});

test('sync of a list keeps its entries in its index file', async () => {
  const t = temp();
  try {
    const fetchText = async () => ({ ok: true, status: 200, text: async () => '- [Viz](https://github.com/b/viz) - Charts from CSV files in one call.' });
    const state = await syncSource({ dataDir: t.dir, git: () => undefined, fetchText, now: () => 5 }, { id: 'list', kind: 'index', url: 'https://example.org/README.md' });
    assert.equal(state.entries, 1);
    assert.equal(readIndex(path.join(t.dir, 'library'), 'list')[0].name, 'viz');
  } finally { t.done(); }
});

const SKILL = '---\nname: git-commits\ndescription: I use this when I write commit messages.\n---\n\n# Git commits\nSay what changed and why, in the imperative.';

function publishDeps(over: Partial<PublishDeps> & { replies?: Record<string, RunResult> } = {}) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const replies = over.replies ?? {};
  const run: Run = async (_command, args, options) => {
    calls.push({ args: [...args], ...(options.input ? { input: options.input } : {}) });
    const key = Object.keys(replies).find((prefix) => args.join(' ').startsWith(prefix));
    if (key) return replies[key];
    if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
    if (args[1] === 'user') return { code: 0, stdout: 'someone\n', stderr: '' };
    if (args[1] === 'repos/teydra/OpenAutark') return { code: 0, stdout: 'main\tfalse\n', stderr: '' };
    if (args.includes('repos/teydra/OpenAutark/forks')) return { code: 0, stdout: 'someone\n', stderr: '' };
    if (args[1]?.includes('/git/ref/heads/')) return { code: 0, stdout: 'abc123\n', stderr: '' };
    if (args.includes('repos/teydra/OpenAutark/pulls')) return { code: 0, stdout: 'https://github.com/teydra/OpenAutark/pull/7\n', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const check: StructuredRunner = async () => ({ text: '', structured: { internal: false, found: [] }, by: 'fake' });
  const deps: PublishDeps = { enabled: () => true, redact: (text) => text.replace(/hunter2/g, 'secret://pw'), check, run, now: () => Date.UTC(2026, 10, 6, 15, 30), ...over };
  return { deps, calls };
}

test('publish: off, a stored secret, a path of this PC and the model check each keep the text here', async () => {
  const off = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, publishDeps({ enabled: () => false }).deps);
  assert.deepEqual([off.ok, !off.ok && off.reason], [false, 'off']);
  const secret = await publishEntry({ kind: 'skill', name: 'git-commits', text: `${SKILL}\nThe password is hunter2.` }, publishDeps().deps);
  assert.equal(!secret.ok && secret.reason, 'secret');
  const local = await publishEntry({ kind: 'skill', name: 'git-commits', text: `${SKILL}\nLogs are in C:\\Users\\alex\\logs.` }, publishDeps().deps);
  assert.equal(!local.ok && local.reason, 'internal');
  const mail = await publishEntry({ kind: 'note', name: 'contact', text: `${SKILL}\nWrite to maria@acme.de.` }, publishDeps().deps);
  assert.equal(!mail.ok && mail.reason, 'internal');
  const flagged = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, publishDeps({ check: async () => ({ text: '', structured: { internal: true, found: ['customer Müller'] }, by: 'fake' }) }).deps);
  assert.ok(!flagged.ok && flagged.reason === 'internal' && flagged.text.includes('customer Müller'));
  for (const line of ['Run `cp /home/anna/acme/keys .` first.', 'Keys sit in "~/acme/keys".', 'The share is \\\\fileserver\\team.']) {
    const quoted = await publishEntry({ kind: 'skill', name: 'git-commits', text: `${SKILL}\n${line}` }, publishDeps().deps);
    assert.equal(!quoted.ok && quoted.reason, 'internal', line);
  }
  const prompts: string[] = [];
  const named = await publishEntry({ kind: 'skill', name: 'kunde-mueller-gmbh-export', text: SKILL }, publishDeps({ check: async (input) => { prompts.push(input.prompt); return { text: '', structured: { internal: true, found: ['customer name'] }, by: 'fake' }; } }).deps);
  assert.equal(!named.ok && named.reason, 'internal');
  assert.ok(prompts[0].startsWith('kunde-mueller-gmbh-export\n'), 'the model sees the public name too');
  const nobody = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, publishDeps({ check: undefined }).deps);
  assert.equal(!nobody.ok && nobody.reason, 'no-check');
  for (const result of [off, secret, local, flagged, nobody]) assert.ok(!result.ok && !/\b(you|may|must|allowed)\b/i.test(result.text), 'first person, no permission words');
});

test('publish: without gh or signed out it says so; otherwise a fork, a branch, the file under library/ and a pull request', async () => {
  const missing = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, publishDeps({ replies: { 'auth status': { code: -1, stdout: '', stderr: '', missing: true } } }).deps);
  assert.ok(!missing.ok && missing.reason === 'no-gh' && /gh auth login/.test(missing.text));
  const out = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, publishDeps({ replies: { 'auth status': { code: 1, stdout: '', stderr: 'not logged in' } } }).deps);
  assert.equal(!out.ok && out.reason, 'signed-out');
  const { deps, calls } = publishDeps();
  const done = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL, derivedFrom: ['anthropics-skills/skill-creator'] }, deps);
  assert.deepEqual(done, { ok: true, url: 'https://github.com/teydra/OpenAutark/pull/7', branch: 'library/skill/git-commits-202611061530', path: 'library/skill/git-commits/SKILL.md' });
  const put = calls.find((call) => call.args.includes('PUT'))!;
  assert.equal(put.args[3], 'repos/someone/OpenAutark/contents/library/skill/git-commits/SKILL.md', 'the fork, only library/');
  const content = Buffer.from((JSON.parse(put.input!) as { content: string }).content, 'base64').toString('utf8');
  assert.match(content, /^---\nkind: skill\nderived-from: \["anthropics-skills\/skill-creator"\]\nname: git-commits/);
  const pr = JSON.parse(calls.find((call) => call.args.includes('repos/teydra/OpenAutark/pulls'))!.input!) as { head: string; base: string };
  assert.deepEqual([pr.head, pr.base], ['someone:library/skill/git-commits-202611061530', 'main']);
});

test('publish: a fresh fork gets a few tries for its branch; an entry already in the library is replaced with its sha', async () => {
  const { deps, calls } = publishDeps();
  const base = deps.run!;
  let refTries = 0;
  const waits: number[] = [];
  const sha = 'a'.repeat(40);
  deps.wait = async (ms) => { waits.push(ms); };
  deps.run = async (command, args, options) => {
    if (args.includes('repos/someone/OpenAutark/git/refs') && ++refTries < 3) { calls.push({ args: [...args] }); return { code: 1, stdout: '', stderr: 'Not Found' }; }
    if (args[1]?.startsWith('repos/someone/OpenAutark/contents/') && !args.includes('PUT')) { calls.push({ args: [...args] }); return { code: 0, stdout: `${sha}\n`, stderr: '' }; }
    return base(command, args, options);
  };
  const done = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, deps);
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(refTries, 3, 'the branch is created on the third try');
  assert.equal(waits.length, 2);
  const put = JSON.parse(calls.find((call) => call.args.includes('PUT'))!.input!) as { sha?: string };
  assert.equal(put.sha, sha, 'the existing file\'s sha goes with the PUT');
  const fresh = publishDeps();
  await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, fresh.deps);
  assert.equal((JSON.parse(fresh.calls.find((call) => call.args.includes('PUT'))!.input!) as { sha?: string }).sha, undefined, 'a new file goes without one');
  const never = publishDeps({ replies: { 'api -X POST repos/someone/OpenAutark/git/refs': { code: 1, stdout: '', stderr: 'Not Found' } } });
  never.deps.wait = async () => {};
  const failed = await publishEntry({ kind: 'skill', name: 'git-commits', text: SKILL }, never.deps);
  assert.ok(!failed.ok && /creating the branch/.test(failed.text));
  assert.equal(never.calls.filter((call) => call.args.includes('repos/someone/OpenAutark/git/refs')).length, 5, 'bounded tries');
});

test('publishedText: a text without front matter gets name and kind', () => {
  assert.equal(publishedText({ kind: 'note', name: 'x', text: 'Plain note.' }, 'plain-note'), '---\nname: plain-note\nkind: note\n---\n\nPlain note.\n');
});
