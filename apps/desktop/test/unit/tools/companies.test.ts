// B-075 (owner 04.11.2026: an agent could not find "Company 2" and asked back): agents act across the person's companies
// on this PC. tools.find finds companies.list for "companies list" / "other company" (not only the spaces); a call with
// company – through tools.call or in its own arguments – runs in that company's runtime over loopback (a fake runtime
// here, serving the real companies.tool and companies.list handlers), journaled here with the company in its summary, the
// result naming the company and that company's secret values masked, the tools there working as for an agent of that PC
// (no fromPc); this company runs it here; unknown, not running and refused companies are plain failures; a break-off
// leaves the effect unknown; tools.call's company stays apart from a tool's own `company` argument; the caller's abort
// listener goes once a call settles; a company where the person is an employee takes no calls; secrets.export /
// secrets.delete / companies.list are offered in every mode.
// Owns: these assertions only. Never: reads the real data folders or a real company's runtime.json.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setup, tool } from './helpers.ts';
import { EVERY_MODE, Registry } from '../../../src/runtime/tools/registry.ts';
import { callTarget, metaTools, rankTools } from '../../../src/runtime/tools/builtin/tools-meta.ts';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { runCompanyTool } from '../../../src/runtime/tools/builtin/companies.ts';
import { callCompany } from '../../../src/runtime/root/companies.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { toErrorData } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext, ToolOutput, ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';

const BOUNDED = { timeout: 15_000 };
const GENERAL = { key: 'general', name: 'General', description: '', skills: [], tools: ['*'], category: 'chat', instructions: '' } as unknown as ModeInfo;
const TASKS_ONLY = { ...GENERAL, key: 'tasks', tools: ['tasks.*'] } as unknown as ModeInfo;
const textOf = (output: ToolOutput) => output.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-companies-tools-'));
const first = path.join(tmp, 'Autark');
const dir = path.join(tmp, 'Autark Companies');
const second = path.join(dir, 'company-2');
mkdirSync(first, { recursive: true });
writeFileSync(path.join(first, 'settings.json'), '{ "profile": { "company": "Teydra lab" } }');
mkdirSync(second, { recursive: true });
writeFileSync(path.join(second, 'settings.json'), '{ "profile": { "company": "Side Shop" } }');
mkdirSync(path.join(dir, 'company-3'), { recursive: true }); // never started: no runtime.json

/** A jot tool that records where it ran, what it saw and who called. */
function jot(where: string, seen: Array<{ where: string; args: Record<string, unknown>; agent: string; fromPc?: string }>) {
  return tool('notes.jot', 'write_local', {
    description: 'Write a short jot.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
    run: async (args, ctx: ToolContext) => {
      seen.push({ where, args, agent: ctx.agent.name, fromPc: ctx.fromPc });
      return { content: [{ type: 'text', text: `jotted ${String(args.text)} in ${where} with b-pass-123` }] };
    },
  });
}

const seen: Array<{ where: string; args: Record<string, unknown>; agent: string; fromPc?: string }> = [];

/** A connected app's tool with its own `company` argument (a CRM's), recording where it ran and with what. */
function crm(where: string) {
  return tool('crm.add', 'write_local', {
    description: 'Add a contact.',
    inputSchema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'], additionalProperties: false },
    run: async (args, ctx: ToolContext) => { seen.push({ where, args, agent: ctx.agent.name, fromPc: ctx.fromPc }); return { content: [{ type: 'text', text: 'added' }] }; },
  });
}

/** Company B ("Side Shop", company-2): its own services and registry, behind a fake loopback runtime. */
const b = setup();
const servicesB = b.services as RuntimeServices;
const registryB = new Registry({ services: () => servicesB });
servicesB.tools = registryB;
registryB.register(jot('Side Shop', seen));
registryB.register(crm('Side Shop'));
servicesB.secrets = { redact: (text: string) => text.split('b-pass-123').join('[masked]') } as unknown as RuntimeServices['secrets'];
servicesB.host = { app: { dataDir: second, companies: { first, dir } } } as unknown as RuntimeServices['host'];
servicesB.devices = {
  self: () => ({ id: 'dev_b' }),
  list: () => [{ id: 'dev_b', name: 'notebook', kind: 'pc', status: 'online', self: true }, { id: 'dev_srv', name: 'office-pc', kind: 'pc', status: 'online', self: false }],
  online: () => true,
} as unknown as RuntimeServices['devices'];

/** Company A ("Teydra lab", the first): the caller. */
const a = setup();
const servicesA = a.services as RuntimeServices;
const registryA = new Registry({ services: () => servicesA });
servicesA.tools = registryA;
servicesA.modes = { get: () => GENERAL } as unknown as RuntimeServices['modes'];
servicesA.host = { app: { dataDir: first, companies: { first, dir } } } as unknown as RuntimeServices['host'];
for (const entry of metaTools) registryA.register(entry);
registryA.register(jot('Teydra lab', seen));
registryA.register(tool('only.here', 'read', { description: 'A tool only this company has.' }));
registryA.register(crm('Teydra lab'));
// Its describe reads this company's data and throws here (as secrets.run with that company's handles); the fake runtime
// drops the connection for it after the call arrived.
registryA.register(tool('notes.drop', 'write_local', { describe: () => { throw new Error('unknown handle'); } }));
const base = (): Omit<ToolContext, 'services'> => ({ agent: a.org.require('ag_tom'), runId: 'run_1', conversationId: a.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} });

const methods: string[] = [];
let server: Server;
before(async () => {
  const table = createHandlerTable();
  server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', async () => {
      if (req.headers.authorization !== 'Bearer tok_b') { res.writeHead(401).end(JSON.stringify({ id: 0, error: { code: 'forbidden', message: 'A valid token is required.' } })); return; }
      const frame = JSON.parse(body) as { id: number; method: string; params?: { name?: unknown } };
      methods.push(frame.method);
      if (frame.params?.name === 'notes.drop') { req.socket.destroy(); return; }
      try {
        const result = await table.get(frame.method)!.handler(frame.params as never, { scope: { kind: 'owner' }, services: servicesB, extras: {}, topics: new Set(), signal: new AbortController().signal } as never);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: frame.id, result }));
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: frame.id, error: toErrorData(error) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  writeFileSync(path.join(second, 'runtime.json'), JSON.stringify({ port, token: 'tok_b', pid: process.pid, at: new Date(0).toISOString() }));
});
after(() => { server?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('tools.find: "companies list" and "other company" find companies.list first, not only the spaces', () => {
  const specs: ToolSpec[] = builtinTools().map((entry) => ({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }));
  assert.ok(specs.some((spec) => spec.name === 'companies.list'), 'registered with the built-in tools');
  for (const query of ['companies list', 'other company', 'firma', 'which companies are on this pc']) {
    assert.equal(rankTools(specs, query, 6)[0]?.name, 'companies.list', query);
  }
  assert.ok(rankTools(specs, 'space area', 6).some((spec) => spec.name.startsWith('spaces.')), 'spaces keep their words');
});

test('secrets.export, secrets.delete and companies.list are offered in every mode and found by their words', () => {
  for (const name of ['secrets.export', 'secrets.delete', 'companies.list']) {
    assert.ok(EVERY_MODE.has(name), name);
    assert.ok(registryA.allowed(tool(name, 'read'), a.org.require('ag_tom'), TASKS_ONLY), `${name} in a tasks-only mode`);
  }
  const specs: ToolSpec[] = ['secrets.list', 'secrets.save', 'secrets.import', 'secrets.export', 'secrets.delete'].map((name) => ({ name, description: 'The secrets catalog.', inputSchema: {} }));
  assert.equal(rankTools(specs, 'download passwords file', 3)[0].name, 'secrets.export');
  assert.equal(rankTools(specs, 'remove logins', 3)[0].name, 'secrets.delete');
});

test('tools.call takes company beside name and args; other extras still go inside args', () => {
  assert.deepEqual(callTarget({ name: 'notes.jot', args: { text: 'a' }, company: 'Side Shop' }), { name: 'notes.jot', args: { text: 'a' }, company: 'Side Shop' });
  assert.deepEqual(callTarget({ name: 'notes.jot', company: 'company-2', text: 'a' }), { name: 'notes.jot', args: { company: 'company-2', text: 'a' } });
  assert.ok('error' in callTarget({ name: 'notes.jot', args: { text: 'a' }, company: 'x', extra: 1 }));
  const schema = metaTools.find((entry) => entry.name === 'tools.call')!.inputSchema as { properties: Record<string, unknown> };
  assert.ok(schema.properties.company, 'tools.call declares company');
});

test('a call with company runs in that company over loopback: journaled here, the result names it, its secret values masked', BOUNDED, async () => {
  seen.length = 0;
  a.runItems.length = 0;
  const via = await registryA.call('tools.call', { name: 'notes.jot', args: { text: 'hello' }, company: 'side shop' }, base(), 'c1');
  assert.ok(!via.isError, textOf(via));
  assert.equal(textOf(via), 'In Side Shop:\njotted hello in Side Shop with [masked]');
  assert.deepEqual(seen, [{ where: 'Side Shop', args: { text: 'hello' }, agent: 'Tom (Teydra lab)', fromPc: undefined }], 'ran there, as the calling company\'s agent on this PC (no linked-PC limits), without the company argument');
  const call = a.runItems.find((item) => item.kind === 'tool_call');
  assert.equal((call?.data as { summary?: string }).summary, 'notes.jot in Side Shop', 'journaled here with the company');

  const direct = await registryA.call('notes.jot', { text: 'again', company: 'company-2' }, base(), 'c2');
  assert.equal(textOf(direct), 'In Side Shop:\njotted again in Side Shop with [masked]', 'by folder, in the call\'s own arguments');
  for (const here of ['this', 'Teydra lab', 'first']) {
    const local = await registryA.call('notes.jot', { text: 'local', company: here }, base(), `c3-${here}`);
    assert.match(textOf(local), /^jotted local in Teydra lab/, here);
  }
  assert.deepEqual(methods.filter((method) => method === 'companies.tool').length, 2, 'only the two calls for company-2 went there');
});

test('unknown, not running and refused companies are plain failures; nothing ran there', BOUNDED, async () => {
  seen.length = 0;
  const unknown = await registryA.call('notes.jot', { text: 'x', company: 'Ernst' }, base(), 'u1');
  assert.ok(unknown.isError);
  assert.match(textOf(unknown), /No company on this PC is called "Ernst"\. Companies here: Teydra lab \(folder first, this one\), Side Shop \(folder company-2\), company-3 \(folder company-3\)\./);
  const idle = await registryA.call('notes.jot', { text: 'x', company: 'company-3' }, base(), 'u2');
  assert.ok(idle.isError && !idle.effect);
  assert.match(textOf(idle), /^company-3: That company does not run right now, so nothing ran there\./);
  const missing = await registryA.call('only.here', { company: 'Side Shop' }, base(), 'u3');
  assert.ok(missing.isError);
  assert.equal(textOf(missing), 'Side Shop: This company has no tool "only.here".');
  assert.deepEqual(seen, []);
});

test('companies.list names each company, this one, the role, whether it runs and its linked PCs; an employee company takes no calls', BOUNDED, async () => {
  const listed = JSON.parse(textOf(await registryA.call('companies.list', {}, base(), 'l1'))) as { companies: Array<Record<string, unknown>>; note: string };
  assert.deepEqual(listed.companies, [
    { name: 'Teydra lab', folder: 'first', current: true, running: true, role: 'owner' },
    { name: 'Side Shop', folder: 'company-2', running: true, role: 'owner', linkedPcs: [{ name: 'office-pc', online: true }] },
    { name: 'company-3', folder: 'company-3', running: false },
  ]);
  assert.match(listed.note, /tools\.call with company/);

  // Side Shop joins another firm's PC as an employee: its data is that firm's.
  new DevicesRepo(b.db).upsert({ id: 'dev_firm', name: 'firm-pc', kind: 'pc', role: 'home', fingerprint: 'fp_firm', addresses: [], caps: {}, status: 'online', self: false, joinedAs: 'employee' });
  seen.length = 0;
  const refused = await registryA.call('notes.jot', { text: 'x', company: 'Side Shop' }, base(), 'e1');
  assert.ok(refused.isError && !refused.effect);
  assert.match(textOf(refused), /^Side Shop: The person works in this company as an employee of another firm/);
  assert.deepEqual(seen, [], 'nothing ran there');
  const again = JSON.parse(textOf(await registryA.call('companies.list', {}, base(), 'l2'))) as { companies: Array<Record<string, unknown>> };
  assert.equal(again.companies[1].role, 'employee');
  await assert.rejects(runCompanyTool(servicesB, { name: 'notes.jot', args: { text: 'x' }, agentId: 'ag_x', runId: 'run_x' }, new AbortController().signal), /employee of another firm/);
  b.db.run('DELETE FROM devices WHERE id = ?', ['dev_firm']);
});

test('companies.tool: owner scope; it runs no meta tool and takes no other PC', BOUNDED, async () => {
  assert.equal(createHandlerTable().get('companies.tool')?.scope, 'owner');
  registryB.register(metaTools.find((entry) => entry.name === 'tools.find')!);
  await assert.rejects(runCompanyTool(servicesB, { name: 'tools.find', args: { query: 'x' }, agentId: 'ag_x', runId: 'run_x' }, new AbortController().signal), /Name the tool to run in this company/);
  await assert.rejects(runCompanyTool(servicesB, { name: 'notes.jot', args: { text: 'x', device: 'office-pc' }, agentId: 'ag_x', runId: 'run_x' }, new AbortController().signal), /runs on this PC/);
  await assert.rejects(runCompanyTool(servicesB, { name: 'notes.jot', args: {}, agentId: 'ag_x', runId: 'run_x' }, new AbortController().signal), /Invalid arguments for notes\.jot/);
});

test('tools.call\'s company places the call; a tool\'s own company argument stays its own', BOUNDED, async () => {
  seen.length = 0;
  const there = await registryA.call('tools.call', { name: 'crm.add', args: { company: 'ACME' }, company: 'Side Shop' }, base(), 'o1');
  assert.equal(textOf(there), 'In Side Shop:\nadded');
  const here = await registryA.call('crm.add', { company: 'Side Shop' }, base(), 'o2');
  assert.equal(textOf(here), 'added', 'its own argument: data, run here');
  assert.deepEqual(seen.map(({ where, args }) => ({ where, args })), [{ where: 'Side Shop', args: { company: 'ACME' } }, { where: 'Teydra lab', args: { company: 'Side Shop' } }]);
});

test('a call into another company that breaks off has an unknown effect, even where this company could not judge it', BOUNDED, async () => {
  a.runItems.length = 0;
  const dropped = await registryA.call('tools.call', { name: 'notes.drop', args: {}, company: 'Side Shop' }, base(), 'b1');
  assert.ok(dropped.isError);
  assert.equal(dropped.effect?.status, 'unknown', 'never retried blindly');
  const call = a.runItems.find((item) => item.kind === 'tool_call');
  assert.equal(call?.effectStatus, 'pending', 'journaled as an external effect');
  assert.equal((call?.data as { summary?: string }).summary, 'notes.drop in Side Shop');
});

test('callCompany takes its abort listener off the caller\'s signal once the call settles', BOUNDED, async () => {
  const controller = new AbortController();
  for (let i = 0; i < 12; i += 1) await callCompany(second, 'companies.list', undefined, { signal: controller.signal });
  await assert.rejects(callCompany(second, 'no.such.method', undefined, { signal: controller.signal }));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
