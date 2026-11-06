// B-072 several companies on one PC, the runtime's side: companies.list reads the data folders (the first one and every
// "<first> Companies/<id>") and names each from its settings.json profile (JSONC; company, else the person's name, else
// the folder), the current one is ticked, folders that are no company id are skipped; without AppInfo.companies (a test
// profile, headless) the list is empty. Another company's workspace is its own <data>/workspace. The RPC methods are
// owner scope; companies.open checks the id and hands over to the host (unavailable without one).
// Owns: these assertions only. Never: starts a company or reads the real data folders.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { companyWorkspace, listCompanies } from '../../../src/runtime/root/companies.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { companyLabel, isCompanyId } from '../../../src/shared/model/companies.ts';
import type { WorkforceError } from '../../../src/shared/errors.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'wf-root-companies-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const first = path.join(tmp, 'Autark');
const dir = path.join(tmp, 'Autark Companies');
const settingsIn = (folder: string, text: string) => { mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, 'settings.json'), text); };

settingsIn(first, '// Autark settings\n{\n  "profile": {\n    // Your company\'s name\n    "company": "Teydra Lab",\n    "name": "Ann",\n  },\n}\n');
settingsIn(path.join(dir, 'company-10'), '{ "profile": { "company": "", "name": "Ann B." } }');
settingsIn(path.join(dir, 'company-2'), '{ "profile": { "company": "  Side Shop  " } }');
mkdirSync(path.join(dir, 'company-3'), { recursive: true }); // new: no settings yet
settingsIn(path.join(dir, 'broken'), 'not json');
mkdirSync(path.join(dir, 'Not An Id'), { recursive: true });
writeFileSync(path.join(dir, 'notes.txt'), 'a file, no company');

test('the list: the first company first, the others by id, each named from its profile, the current one ticked', () => {
  const companies = { first, dir };
  assert.deepEqual(listCompanies({ dataDir: first, companies }), [
    { id: null, label: 'Teydra Lab', current: true },
    { id: 'broken', label: 'broken', current: false },
    { id: 'company-2', label: 'Side Shop', current: false },
    { id: 'company-3', label: 'company-3', current: false },
    { id: 'company-10', label: 'Ann B.', current: false },
  ]);
  const fromThird = listCompanies({ dataDir: path.join(dir, 'company-3'), companies });
  assert.deepEqual(fromThird.filter((entry) => entry.current).map((entry) => entry.id), ['company-3']);
  assert.deepEqual(listCompanies({ dataDir: first, companies: { first, dir: path.join(tmp, 'none yet') } }), [{ id: null, label: 'Teydra Lab', current: true }]);
  assert.deepEqual(listCompanies({ dataDir: first }), [], 'a test profile or headless: no companies');
});

test('labels and ids: company, else the name, else the folder; ids are short lower-case folder names', () => {
  assert.equal(companyLabel({ company: 'X', name: 'Y' }, 'c'), 'X');
  assert.equal(companyLabel({ company: ' ', name: 'Y' }, 'c'), 'Y');
  assert.equal(companyLabel(undefined, 'company-2'), 'company-2');
  assert.equal(companyLabel(null, null), 'First company');
  assert.equal(companyLabel({ company: 'x'.repeat(200) }, null).length, 80);
  for (const id of ['company-2', 'teydra', 'a', '9x']) assert.ok(isCompanyId(id), id);
  for (const id of ['', '-a', 'A', 'a b', '../a', 'a/b', 'a\\b', 'a.b', 'a'.repeat(41), 7, null, 'con', 'nul', 'com1', 'lpt9']) assert.ok(!isCompanyId(id), String(id));
});

test("another company's workspace is its own folder; the first keeps the default", () => {
  const companies = { first, dir };
  assert.equal(companyWorkspace({ dataDir: first, companies }), undefined);
  assert.equal(companyWorkspace({ dataDir: path.join(dir, 'company-2'), companies }), path.join(dir, 'company-2', 'workspace'));
  assert.equal(companyWorkspace({ dataDir: first }), undefined);
});

test('companies.list / companies.open: owner scope; open checks the id and hands over to the host', async () => {
  const table = createHandlerTable();
  const list = table.get('companies.list')!;
  const open = table.get('companies.open')!;
  assert.equal(list.scope, 'owner');
  assert.equal(open.scope, 'owner');
  const asked: unknown[] = [];
  const host = {
    app: { dataDir: first, companies: { first, dir } },
    openCompany: async (input: unknown) => { asked.push(input); return { ok: true, id: 'company-2' }; },
  };
  const ctx = (h: unknown) => ({ scope: { kind: 'owner' }, services: { host: h }, extras: {}, topics: new Set(), signal: new AbortController().signal }) as never;
  const listed = await list.handler(undefined as never, ctx(host)) as { companies: unknown[] };
  assert.equal(listed.companies.length, 5);
  assert.deepEqual(await open.handler({ create: true } as never, ctx(host)), { ok: true, id: 'company-2' });
  await open.handler({ id: 'company-2' } as never, ctx(host));
  await open.handler(undefined as never, ctx(host));
  assert.deepEqual(asked, [{ id: null, create: true }, { id: 'company-2' }, { id: null }]);
  const code = async (params: unknown, h: unknown = host) => { try { await open.handler(params as never, ctx(h)); return 'none'; } catch (error) { return (error as WorkforceError).code; } };
  assert.equal(await code({ id: '../x' }), 'bad_request');
  assert.equal(await code({ id: 'a', extra: 1 }), 'bad_request');
  assert.equal(await code({ create: 'yes' }), 'bad_request');
  assert.equal(await code({}, { app: { dataDir: first } }), 'unavailable', 'headless or a test profile');
  assert.equal(asked.length, 3, 'nothing refused reached the host');
});
