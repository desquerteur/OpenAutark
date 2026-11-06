// FIND: one find/open path over skills, memory notes and references – a lexical score with its reason, main skills
// first among equals, skills opened page by page with their version, notes with the day they were saved, another
// agent's own note not opened, and the tool's wording (a description with the title, never the text).
// Owns: these assertions. Never: a real database (the knowledge service is a fake over three notes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FindService } from '../../../src/runtime/find/service.ts';
import { PAGE_CHARS } from '../../../src/runtime/find/open.ts';
import { findTools } from '../../../src/runtime/tools/builtin/find.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { KnowledgeItem, ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const tom = { id: 'ag_tom', name: 'Tom', mode: 'general', skills: [] } as unknown as Agent;
const mode = { key: 'general', name: 'General', description: '', skills: [], tools: ['*'], category: 'general' } as unknown as ModeInfo;

function note(id: string, title: string, body: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return { id, scope: 'global', kind: 'fact', title, body, tags: [], source: { kind: 'agent' }, confidence: 1, pinned: false, recordedAt: Date.UTC(2026, 9, 1), createdBy: 'ag_ana', uses: 0, ...extra } as unknown as KnowledgeItem;
}

function world() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wf-find-'));
  const workspace = path.join(root, 'workspace');
  const write = (name: string, description: string, body: string) => {
    mkdirSync(path.join(workspace, 'skills', name), { recursive: true });
    writeFileSync(path.join(workspace, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  };
  write('invoice-check', 'Check open invoices and payment reminders', 'Look at every invoice.');
  write('trip-plan', 'Plan team trips', `# Trip\n${'Book flights first.\n'.repeat(800)}`);
  const clock = new ManualClock(Date.UTC(2026, 9, 31));
  const notes = [
    note('k1', 'Invoice rule', 'Invoices over 1000 EUR need two reminders.', { description: 'When a customer pays late.' }), note('k2', 'Ana private', 'Invoice draft notes', { scope: 'agent', scopeId: 'ag_ana' }),
    note('k3', 'Supplier', 'Pays within ten days.', { description: 'When the Kessler gearbox order is due.' }),
  ];
  const services = {
    skills: new SkillLibrary({ paths: { workspace, resources: path.join(root, 'resources') }, clock, home: '' }),
    knowledge: {
      search: async () => notes.filter((item) => item.scope === 'global').map((item) => ({ item, score: 1, why: '' })),
      get: (id: string) => notes.find((item) => item.id === id),
    },
    clock, modes: { get: () => mode, list: () => [mode] }, settings: { get: () => ({ profile: { timezone: 'UTC' } }) },
    log: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as RuntimeServices;
  return { services, find: new FindService(() => services), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const caller = { agent: tom, via: 'agent' as const, mode: 'general' };

test('find: skills and notes that carry the words, each with its reason; opening a skill pages it with its version', async () => {
  const w = world();
  try {
    const found = await w.find.find(caller, { query: 'open invoice reminders' });
    assert.deepEqual(found.map((entry) => entry.id), ['skill:invoice-check', 'note:k1']);
    assert.match(found[0].why, /matches/);
    assert.match(found[1].why, /saved/);
    const page = await w.find.open(caller, { id: 'skill:trip-plan', page: 2 });
    assert.equal(page.page, 2);
    assert.ok(page.pages >= 2 && page.text.length <= PAGE_CHARS);
    const again = await w.find.open(caller, { id: 'skill:invoice-check', version: 'old' });
    assert.match(again.changed ?? '', /changed since you found it/);
    assert.match((await w.find.open(caller, { id: 'note:k1' })).text, /two reminders/);
    await assert.rejects(w.find.open(caller, { id: 'note:k2' }), /does not exist/, 'another agent\'s own note');
  } finally { w.cleanup(); }
});

test('the tool lists candidates without their text', async () => {
  const w = world();
  try {
    const tool = findTools.find((entry) => entry.name === 'knowledge.find')!;
    const ctx = { agent: tom, runId: 'r', mode: 'general', services: w.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
    const output = await tool.run({ query: 'invoice reminders' }, ctx);
    const text = output.content[0].type === 'text' ? output.content[0].text : '';
    assert.match(text, /\[skill:invoice-check\]/);
    assert.doesNotMatch(text, /Look at every invoice/);
  } finally { w.cleanup(); }
});

test('a description stands with the title, the text never; a word only in the description finds the note; opening shows it', async () => {
  const w = world();
  try {
    const tool = findTools.find((entry) => entry.name === 'knowledge.find')!;
    const ctx = { agent: tom, runId: 'r', mode: 'general', services: w.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
    const output = await tool.run({ query: 'invoice reminders' }, ctx);
    const text = output.content[0].type === 'text' ? output.content[0].text : '';
    assert.match(text, /^- \[note:k1\] memory note "Invoice rule" \(When a customer pays late\.\) – memory · global @/m);
    assert.match(text, /^- \[skill:invoice-check\] skill "invoice-check" \(Check open invoices and payment reminders\) – skills\/invoice-check\/SKILL\.md @/m);
    assert.doesNotMatch(text, /two reminders|Look at every invoice/, 'the text still never appears');
    assert.deepEqual((await w.find.find(caller, { query: 'Kessler gearbox' })).map((entry) => entry.id), ['note:k3']);
    assert.match((await w.find.open(caller, { id: 'note:k1' })).text, /^Invoice rule \(.+\)\nWhen a customer pays late\.\nInvoices over 1000 EUR/, 'opening the note: the description between the title line and the text');
  } finally { w.cleanup(); }
});
