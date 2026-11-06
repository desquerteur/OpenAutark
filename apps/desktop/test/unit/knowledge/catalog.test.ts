// B-078 D12: one knowledge catalog (knowledge/catalog.ts, describe.ts, find.ts, always.ts): skills of every root and the
// public library as entries with a description (given, generated, else heading + first sentence); the sync embeds them as
// virtual entries and removes the gone ones; a generated description goes into an own SKILL.md's front matter, into kv for a
// read-only one; a find by meaning (two hops) or by words, each skill as the viewer's copy; skills.save without a
// description; one always set under one cap.
// Owns: these assertions only. Never: real models or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../../src/runtime/db/database.ts';
import { sql } from '../../../src/runtime/db/migrations/088-vector-chunks.ts';
import { unit, type Embedder } from '../../../src/runtime/vectors/embedders.ts';
import { VectorSystem } from '../../../src/runtime/vectors/service.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { catalogEntries, describeSome, syncCatalog } from '../../../src/runtime/knowledge/catalog.ts';
import { describedText, withDescription } from '../../../src/runtime/knowledge/describe.ts';
import { catalogLine, findInCatalog, lexicalCatalog, searchCatalog } from '../../../src/runtime/knowledge/find.ts';
import { ALWAYS_CHARS, alwaysLines } from '../../../src/runtime/knowledge/always.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { KnowledgeItem, SkillInfo } from '../../../src/shared/model/knowledge.ts';

const WORDS = ['invoice', 'video', 'deploy', 'soup', 'contract', 'caption'];

class FakeEmbedder implements Embedder {
  id = 'fake:1';
  batch = 8;
  remote = false;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => unit([...WORDS.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)), 0.01]));
  }
}

function skill(dir: string, name: string, front: string, body: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\n${front}---\n\n${body}\n`);
}

function setup(options: { embedder?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  const db = new Db(path.join(dir, 'test.db'));
  db.exec(sql);
  db.exec('CREATE TABLE kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns, key)) STRICT;');
  const workspace = path.join(dir, 'ws');
  const resources = path.join(dir, 'res');
  const data = path.join(dir, 'data');
  skill(path.join(workspace, 'skills'), 'invoices', 'description: "I use this when an invoice goes out."\n', '# Invoices\nSend on the 3rd.');
  skill(path.join(workspace, 'skills'), 'deploy-steps', '', '# Deploy steps\nRun the smoke tests before a deploy.');
  skill(path.join(resources, 'skills'), 'captions', '', '# Captions\nBurn captions into a video export.');
  // A cloned library source with one entry.
  const lib = path.join(data, 'library', 'anthropics-skills', 'skills', 'soup');
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(lib, 'SKILL.md'), '---\nname: soup\ndescription: Cooking soup for a team lunch.\n---\n# Soup\nBoil it.');
  mkdirSync(path.join(data, 'memory'), { recursive: true });
  let time = 1_000_000;
  const clock = { now: () => time };
  const skills = new SkillLibrary({ paths: { workspace, resources }, clock, home: '' });
  const vectors = new VectorSystem({ db, memoryRoot: path.join(data, 'memory'), embedder: () => (options.embedder === false ? undefined : new FakeEmbedder()), changeDelayMs: 0 });
  const services = { db, clock, skills, vectors, paths: { workspace, resources, data, temp: dir }, log: { debug() {}, info() {}, warn() {} } } as unknown as RuntimeServices;
  return { services, skills, workspace, resources, advance: (ms: number) => { time += ms; }, done: () => { vectors.stop(); db.raw.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const viewer = { id: 'ag_v', name: 'Vic' } as Agent;

test('the catalog: skills of every root and the library, each with a description – given, else heading + first sentence', () => {
  const t = setup();
  try {
    const entries = catalogEntries(t.services, viewer);
    const by = (title: string) => entries.find((entry) => entry.title === title)!;
    assert.deepEqual(entries.map((entry) => entry.title).sort(), ['captions', 'deploy-steps', 'invoices', 'soup']);
    assert.deepEqual([by('invoices').description, by('invoices').given, by('invoices').writable], ['I use this when an invoice goes out.', true, true]);
    assert.deepEqual([by('deploy-steps').description, by('deploy-steps').given], ['Deploy steps: Run the smoke tests before a deploy.', false]);
    assert.equal(by('captions').writable, false, 'a built-in skill is read-only');
    assert.deepEqual([by('soup').origin, by('soup').kind, by('soup').key], ['public', 'library', 'catalog/public/anthropics-skills/soup']);
  } finally { t.done(); }
});

test('sync embeds the catalog; a find by meaning maps hits to entries with the library marker; a gone skill leaves', async () => {
  const t = setup();
  try {
    await syncCatalog(t.services, viewer);
    const hits = await searchCatalog(t.services, viewer, 'invoice');
    assert.equal(hits?.[0].entry.title, 'invoices');
    assert.equal(hits?.[0].by, 'meaning');
    const soup = await searchCatalog(t.services, viewer, 'soup');
    assert.match(catalogLine(soup![0]), /^- soup \(public library anthropics-skills\) – Cooking soup for a team lunch\. · library\.read anthropics-skills soup$/);
    rmSync(path.join(t.workspace, 'skills', 'deploy-steps'), { recursive: true, force: true });
    t.advance(10_000);
    await syncCatalog(t.services, viewer);
    assert.ok(!(t.services.vectors.virtualKeys?.('catalog/skill') ?? []).some((key) => key.includes('deploy-steps')), 'a gone skill leaves the store');
  } finally { t.done(); }
});

test('without an embedder the find goes by words', async () => {
  const t = setup({ embedder: false });
  try {
    assert.equal(await searchCatalog(t.services, viewer, 'deploy'), undefined);
    const words = await findInCatalog(t.services, viewer, 'deploy smoke tests');
    assert.deepEqual(words.map((hit) => [hit.entry.title, hit.by]), [['deploy-steps', 'words']]);
    assert.deepEqual(lexicalCatalog(t.services, viewer, 'xyz nothing'), []);
  } finally { t.done(); }
});

test('generated descriptions: an own SKILL.md gets it in its front matter, a read-only one in kv by its sha; never asked twice', async () => {
  const t = setup({ embedder: false });
  try {
    const asked: string[] = [];
    const runner: StructuredRunner = async (call) => { asked.push(call.prompt.split('\n')[0]); return { text: '', structured: { description: `I use this when ${call.prompt.includes('Captions') ? 'video captions' : 'a deploy'} are the work.` }, by: 'fake' }; };
    const entries = catalogEntries(t.services, viewer);
    assert.equal(await describeSome(t.services, entries, runner), 2, 'deploy-steps and captions: invoices and soup have a written one');
    const own = readFileSync(path.join(t.workspace, 'skills', 'deploy-steps', 'SKILL.md'), 'utf8');
    assert.match(own, /^---\nname: deploy-steps\ndescription: "I use this when a deploy are the work\."\n---\n/);
    const captions = entries.find((entry) => entry.title === 'captions')!;
    assert.equal(describedText(t.services, captions.sha!), 'I use this when video captions are the work.');
    assert.match(readFileSync(path.join(t.resources, 'skills', 'captions', 'SKILL.md'), 'utf8'), /^---\nname: captions\n---/, 'a read-only file stays as it is');
    t.advance(10_000);
    asked.length = 0;
    assert.equal(await describeSome(t.services, catalogEntries(t.services, viewer), runner), 0, 'nothing is described twice');
    assert.equal(catalogEntries(t.services, viewer).find((entry) => entry.title === 'captions')?.description, 'I use this when video captions are the work.');
    assert.equal(withDescription('---\nname: x\ndescription: >\n  old\n  text\nmodes: [a]\n---\nBody', 'x', 'New.'), '---\nname: x\ndescription: "New."\nmodes: [a]\n---\n\nBody');
  } finally { t.done(); }
});

test('skills.save without a description: the body\'s heading and first sentence stand in', () => {
  const t = setup({ embedder: false });
  try {
    const saved = t.skills.save({ name: 'quick-notes', description: '', body: '# Quick notes\nWrite the note before the call ends.' });
    assert.equal(saved.description, 'Quick notes: Write the note before the call ends.');
  } finally { t.done(); }
});

test('one always set: always-skills and pinned notes, short ones whole, long ones by description, one cap', () => {
  const always = { name: 'money', description: 'I read this before I spend money.', source: 'builtin', path: '/s/money', modes: [], updatedAt: 0, always: true } as SkillInfo;
  const note = (title: string, body: string, description?: string): KnowledgeItem => ({ id: `company:pinned:${title}`, title, body, description, recordedAt: 0 } as unknown as KnowledgeItem);
  const services = { clock: { now: () => 0 }, skills: { get: () => ({ info: always, body: 'Above 20 EUR I check what is bought and why.' }) } } as unknown as RuntimeServices;
  const mids = [1, 2, 3, 4, 5].map((index) => note(`Mid${index}`, 'm'.repeat(1100)));
  const lines = alwaysLines(services, viewer, { skills: [always], notes: [note('Name', 'Alex Weber'), note('Long', 'y'.repeat(2000), 'The long one in a line.'), ...mids] }, 'UTC');
  assert.equal(lines[0], '- money (skill): Above 20 EUR I check what is bought and why.');
  assert.match(lines[1], /^- Name: Alex Weber \(/);
  assert.match(lines[2], /^- Long – The long one in a line\. \(memory\.read company\/pinned\/Long; /);
  assert.ok(lines.length < 8 && lines.join('\n').length <= ALWAYS_CHARS, 'what does not fit the one cap is left out');
  const huge = alwaysLines(services, viewer, { skills: [], notes: [note('Huge', 'z'.repeat(ALWAYS_CHARS * 2), 'The huge one.'), note('After', 'Still here.')] }, 'UTC');
  assert.match(huge[0], /^- Huge – The huge one\. \(memory\.read /, 'a note above the cap stands by its description');
  assert.match(huge[1], /^- After: Still here\./, 'it counts at its line\'s size, so later notes still fit');
});
