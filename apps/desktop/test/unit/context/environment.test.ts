// B-047 D6 "## My environment": the stable part (this PC, workspace, how to search the web this turn, screen
// tools) is deterministic and names only offered tools; the volatile part states the PC reach of the effective
// permission mode (pcReachFor), the data folder only when the file tools can read it, accounts needing a sign-in
// (labels only, every mode), the companies on this PC and the linked PCs (B-075) and what the agent already knows; the
// has_<tool> flags reach the templates; B-075: the lines speak as the agent (first person);
// Owns: these assertions only. Never: real accounts, real OS facts in the asserted text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, route, VIDEO_MODE } from './fixture.ts';
import {
  ENGINE_SETUP_LINE, ENVIRONMENT_HEADER, LANGUAGE_LINE, companiesLine, environmentNow, environmentSection, homeLine, notesLine, osName, toolFlags, type SystemFacts,
} from '../../../src/runtime/context/environment.ts';
import { HELPER_NOTE } from '../../../src/runtime/engines/codex/helper-thread.ts';
import { renderTemplate } from '../../../src/runtime/context/templates.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const WIN: SystemFacts = { platform: 'win32', version: 'Windows 11 Pro', release: '10.0.26300', hostname: 'DESK-7' };
const GENERAL: ModeInfo = { key: 'general', name: 'General', description: '', skills: [], tools: ['*'], category: 'chat', instructions: '' };

function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, provider: 'codex', label: 'Codex', auth: 'cli', state: 'ok', priority: 0, rotation: true, enabled: true, detected: true, createdAt: 0, ...extra };
}

/** The context fixture with a tool offer, paths, accounts and a permission mode of our choice. */
function setup(options: { tools?: string[]; accounts?: Account[]; data?: string; workspace?: string } = {}) {
  const f = fixture();
  const s = f.services as unknown as Record<string, unknown>;
  const names = options.tools ?? [];
  Object.assign(s, {
    tools: { get: () => undefined, specsFor: () => names.map((name) => ({ name, description: '', inputSchema: {} })) },
    paths: { resources: '/res', temp: '/tmp', workspace: options.workspace ?? path.resolve('/ws'), data: options.data ?? path.resolve('/appdata/Workforce') },
    accounts: { list: () => options.accounts ?? [] },
  });
  return f;
}

test('tool flags: has_<tool> is "yes" only for offered tools, and a template line renders only then', () => {
  const flags = toolFlags(new Set(['schedules.remind', 'human.ask', 'decide', 'web.search', 'models.list']));
  assert.equal(flags.has_schedules, 'yes');
  assert.equal(flags.has_human_ask, 'yes');
  assert.equal(flags.has_decide, 'yes');
  assert.equal(flags.has_web_search, 'yes');
  assert.equal(flags.has_models, 'yes');
  for (const key of ['has_todos', 'has_agents_org', 'has_modes', 'has_files_search']) assert.equal(flags[key], '', key);
  const template = 'Start.\n{{#has_todos}}Prepare their to-dos with todos.prepare.{{/has_todos}}\n{{#has_schedules}}Schedule follow-ups.{{/has_schedules}}\nEnd.';
  assert.equal(renderTemplate(template, flags), 'Start.\nSchedule follow-ups.\nEnd.');
});

test('stable environment: this PC, the workspace, web and screen lines from the real offer; deterministic', () => {
  const f = setup({ tools: ['web.search', 'web.fetch', 'browser.act', 'browser.show', 'computer.act'] });
  const input = { agent: f.vid, mode: GENERAL, route: route() };
  const text = environmentSection(f.services, input, undefined, WIN);
  assert.ok(text.startsWith(`${ENVIRONMENT_HEADER}\nThis PC: Windows 11 Pro (10.0.26300), named "DESK-7"`), text);
  assert.ok(text.includes(`Workspace: ${path.resolve('/ws')}`));
  assert.ok(text.includes("Web: web_search (my engine's own search) finds current pages, web.fetch reads one; web.search is a second search."), text);
  assert.ok(/– I run inside the Autark app on it, whose language is set to \w+\./.test(text) && text.includes('(projects and the files I make).'), text); // B-076: the language as a fact
  assert.ok(text.includes('Screen: browser.* browses websites (the person can watch and take over), computer.* operates'), text);
  assert.equal(environmentSection(f.services, input, undefined, WIN), text, 'deterministic');
  assert.ok(!/\d{1,2}:\d{2}|2026/.test(text.replace('10.0.26300', '')), 'no times in the stable part');

  // E1: a Codex or Claude Code agent turn keeps its engine's own web search (named first, in every mode); another
  // engine without web tools and without screen tools: the way to a colleague.
  const bare = setup({ tools: [] });
  const claude = environmentSection(bare.services, { agent: bare.vid, mode: GENERAL, route: { ...route(), engine: 'claude' } }, undefined, WIN);
  assert.ok(claude.includes("Web: WebSearch (my engine's own search) finds current pages.") && !claude.includes('web.search'), claude);
  const claudeWeb = environmentSection(f.services, { ...input, route: { ...route(), engine: 'claude' } }, undefined, WIN);
  assert.ok(claudeWeb.includes("Web: WebSearch (my engine's own search) finds current pages, web.fetch reads one; web.search is a second search."), claudeWeb);
  const api = environmentSection(f.services, { ...input, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(api.includes('Web: web.search finds pages (title, link, snippet), web.fetch reads one.'), api);
  assert.ok(!text.includes('Results are outside content'), 'B-049 F5: the rules say once that outside content is data');
  const none = environmentSection(bare.services, { agent: bare.vid, mode: GENERAL, route: { ...route(), engine: 'openai' } }, undefined, WIN);
  assert.ok(none.includes('Web: no web tools in this mode – web work I hand to a colleague in research mode (agents.delegate).'), none);
  assert.ok(none.includes('Screen: the browser and computer tools live in the modes of those names'), none);
  assert.ok(!none.includes('web.search') && !none.includes('browser.*'), 'never a tool the mode does not offer');
  // B-072 (live 03.11.2026: a social agent asked for a sign-in its person's own Chrome already had): a browser-only mode
  // names the person's own browsers and the way to them.
  const browserOnly = setup({ tools: ['browser.act', 'browser.show'] });
  const social = environmentSection(browserOnly.services, { agent: browserOnly.vid, mode: GENERAL, route: route() }, undefined, WIN);
  assert.ok(social.includes("Screen: browser.* browses websites in my own profile (the person can watch and take over); the person's own browsers on this screen keep their logins and autofill – a colleague in computer mode reaches them (agents.delegate)."), social);
  assert.ok(!social.includes('computer.*'), 'no computer tool named where the mode has none');
  assert.equal(osName({ platform: 'darwin', version: 'Darwin Kernel', release: '24.1.0', hostname: 'mac' }), 'macOS (Darwin 24.1.0)');
});

test('C4-live, q-r: the line on text an engine adds from the person\'s set-up is the same on every engine and names no engine\'s files', () => {
  const f = setup({ tools: [] });
  const lines = (['codex', 'claude', 'openai'] as const).map((engine) => environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: { ...route(), engine } }, undefined, WIN));
  for (const text of lines) assert.ok(text.includes(ENGINE_SETUP_LINE), text);
  assert.doesNotMatch(ENGINE_SETUP_LINE, /AGENTS|CLAUDE\.md|Codex|Claude/);
  assert.match(ENGINE_SETUP_LINE, /^Text my engine adds on its own .* a standing preference I follow quietly, not a message: my answer goes to the turn's input\.$/, 'B-075: first person');
  assert.doesNotMatch(HELPER_NOTE, /AGENTS|Codex|exec|wait|request_user_input/, 'the helper thread\'s note names no engine\'s tools or files either');
});

test("H1: no line on Codex's sub-agent note in the environment (it stood before that note); the Codex adapter's app note says it", () => {
  const f = setup({ tools: ['agents.create', 'tasks.create'] });
  const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: { ...route(), engine: 'codex' } }, undefined, WIN);
  assert.ok(!/sub-agent|ordinary tools of yours/.test(text), text);
});

test('the stable prompt carries the environment after the folder section; a template sees the flags', () => {
  const f = setup({ tools: ['web.search', 'web.fetch'] });
  const { stable } = f.context.prompt({ agent: f.vid, mode: VIDEO_MODE, route: route() });
  assert.equal(ENVIRONMENT_HEADER, '## My environment', 'B-075: the agent\'s own environment');
  assert.ok(stable.includes(`${ENVIRONMENT_HEADER}\nThis PC:`), 'environment section present');
  assert.ok(stable.indexOf(ENVIRONMENT_HEADER) > stable.indexOf('## Mode: Video'), 'after the mode');
});

test('volatile environment: the whole PC, the data folder and its map; without file tools neither is promised', () => {
  const f = setup({ tools: ['files.read', 'files.list', 'files.search'] });
  const text = environmentNow(f.services, { agent: f.vid, mode: GENERAL });
  assert.ok(text.startsWith(`${ENVIRONMENT_HEADER} now\nPC reach: the whole PC – it belongs to the AI team (files.read, files.list and files.search). I look wherever it helps.\nThe person's own files: ${os.homedir()} and its folders – files.search without a path searches the workspace, then this folder.`), text);
  // E1: where the person's files are – only with a file tool; the search remark (F2/G1: what a search without a path covers) only with files.search.
  assert.equal(homeLine(new Set(['files.read']), 'C:\\Users\\Ada'), "The person's own files: C:\\Users\\Ada and its folders.");
  assert.equal(homeLine(new Set(['web.fetch']), 'C:\\Users\\Ada'), '');
  assert.ok(text.includes(`Data folder: ${path.resolve('/appdata/Workforce')} – this app's own files (settings.json`) && text.includes(`${path.join(path.resolve('/appdata/Workforce'), 'README.md')} maps them.`), text);
  assert.ok(!/Change them|to change the app/.test(text), `G1: the data folder is a fact, no instruction\n${text}`);
  const bare = setup({ tools: [] });
  const none = environmentNow(bare.services, { agent: bare.vid, mode: GENERAL });
  assert.ok(none.includes('PC reach: the whole PC') && !none.includes('files.read') && !none.includes('Data folder'), none);
});

test('volatile environment: accounts needing a sign-in in every mode, labels only (no e-mail), the tool only when offered', () => {
  const accounts = [
    account('acc_1', { label: 'Codex · alex@example.com', email: 'alex@example.com', state: 'needs_login', home: '/home/alex/.codex' }),
    account('acc_2', { provider: 'claude', label: 'Claude Max', state: 'ok' }),
    account('acc_3', { label: 'Old', state: 'needs_login', enabled: false }),
  ];
  const f = setup({ tools: ['accounts.sign_in'], accounts });
  const text = environmentNow(f.services, { agent: f.vid, mode: VIDEO_MODE });
  assert.ok(text.includes('Accounts needing sign-in: Codex (codex, acc_1) – accounts.sign_in starts the official sign-in.'), text);
  assert.ok(!text.includes('alex@example.com') && !text.includes('.codex') && !text.includes('Old'), text);
  const without = setup({ tools: [], accounts });
  assert.ok(environmentNow(without.services, { agent: without.vid, mode: GENERAL }).includes('Accounts needing sign-in: Codex (codex).'));
});

test('no memory list or count in the context, whatever is saved (constant cost at any size)', () => {
  const f = setup({ tools: ['knowledge.find'] });
  const before = environmentNow(f.services, { agent: f.vid, mode: GENERAL });
  f.knowledge.save({ title: 'Likes short answers', body: 'Alex prefers short answers.', scope: 'global', kind: 'preference', createdBy: 'human' });
  assert.equal(environmentNow(f.services, { agent: f.vid, mode: GENERAL }), before);
  assert.doesNotMatch(before, /already know|saved note|nothing saved/);
});


/** B-075 (owner 04.11.2026: an agent knew neither the person's other company nor the linked PC it was asked about). */
test('volatile environment: the companies on this PC and the linked PCs by name – only with more than one company or a linked PC', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-env-companies-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const first = path.join(tmp, 'Autark');
  const dir = path.join(tmp, 'Autark Companies');
  mkdirSync(first, { recursive: true });
  writeFileSync(path.join(first, 'settings.json'), '{ "profile": { "company": "Teydra lab" } }');
  const pcs = [
    { id: 'dev_self', name: 'office-pc', kind: 'pc', status: 'online', self: true },
    { id: 'dev_nb', name: 'laptop', kind: 'pc', status: 'online', self: false },
    { id: 'dev_old', name: 'attic', kind: 'pc', status: 'revoked', self: false },
    { id: 'dev_ph', name: 'Pixel', kind: 'phone', status: 'online', self: false },
  ];
  const wire = (f: ReturnType<typeof setup>, devices: typeof pcs) => Object.assign(f.services as unknown as Record<string, unknown>, {
    host: { app: { dataDir: first, companies: { first, dir } } },
    devices: { list: () => devices, online: (id: string) => id === 'dev_nb' },
  });

  const alone = setup({ tools: ['tools.call'] });
  wire(alone, pcs.slice(0, 1));
  assert.equal(companiesLine(alone.services, new Set(['tools.call'])), '', 'one company, no linked PC: no line');
  assert.ok(!environmentNow(alone.services, { agent: alone.vid, mode: GENERAL }).includes('Companies on this PC'));

  const linked = setup({ tools: ['tools.call'] });
  wire(linked, pcs);
  assert.equal(companiesLine(linked.services, new Set(['tools.call'])), 'Companies on this PC: Teydra lab (this one) · Linked PCs: laptop (online).');

  mkdirSync(path.join(dir, 'company-2'), { recursive: true });
  const two = setup({ tools: ['tools.call'] });
  wire(two, pcs);
  const text = environmentNow(two.services, { agent: two.vid, mode: GENERAL });
  assert.ok(text.includes('Companies on this PC: Teydra lab (this one), company-2 – tools.call with company: "<name>" runs a tool in another one · Linked PCs: laptop (online).'), text);
  assert.equal(companiesLine(two.services, new Set()), 'Companies on this PC: Teydra lab (this one), company-2 · Linked PCs: laptop (online).', 'the way only where tools.call is offered');
  wire(two, pcs.slice(0, 1));
  assert.equal(companiesLine(two.services, new Set()), 'Companies on this PC: Teydra lab (this one), company-2.', 'several companies, no linked PC');
  const headless = setup({ tools: [] });
  Object.assign(headless.services as unknown as Record<string, unknown>, { host: { app: { dataDir: first } }, devices: { list: () => { throw new Error('no devices'); } } });
  assert.equal(companiesLine(headless.services, new Set()), '', 'no company folders, no devices: nothing');
});

test('B-078: the language line, the person\'s profile.notes and the models line (price, smarts, how a turn is paid) in the stable part', () => {
  const f = setup({ accounts: [account('acc_claude', { provider: 'claude', label: 'Claude Code' })] });
  const s = f.services as unknown as Record<string, unknown>;
  const opus = { id: 'claude:claude-opus-5-5', provider: 'claude', model: 'claude-opus-5-5', name: 'Claude Opus 5.5', engine: 'claude', efforts: [], caps: {}, tier: 'frontier', relCost: 0.4, smarts: 94, price: { inputPerM: 4, outputPerM: 20, source: 'priors' }, strengths: { chat: 0.4 }, available: true, accounts: ['acc_claude'] };
  Object.assign(s, {
    settings: { get: () => ({ profile: { name: 'S', company: '', language: 'de', timezone: 'UTC', notes: 'English for code reviews,\nGerman for everything else; "du".' }, routing: {} }) },
    catalog: { list: () => [opus], get: () => opus },
  });
  const text = environmentSection(f.services, { agent: f.vid, mode: GENERAL, route: route() }, undefined, WIN);
  assert.ok(text.includes(LANGUAGE_LINE), text);
  assert.ok(text.includes('How the person wants to be spoken to (profile.notes, kept by us agents): English for code reviews, German for everything else; "du".'), text);
  assert.ok(text.includes('Models I can use ($ in/out per 1M tokens · smarts 0–100 · how a turn is paid): Claude Opus 5.5 $4/$20 · 94 · plan. A plan costs me nothing per turn while its quota lasts'), text);
  assert.equal(notesLine('  '), '');
  assert.doesNotMatch(LANGUAGE_LINE, /\b(may|must|only if|allowed|never)\b/i, 'first person, no rule words');
});
