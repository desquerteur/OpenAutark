// What Settings › Apps and › Secrets hand on (B-066 J): the connector files stay what the runtime reads, nothing else in them changes,
// a key never lands in a file; a login's or card's payload keeps a stored value on an empty input and removes what was marked.
// Owner 04.11.2026: the Name | Value rows keep one empty row, a pasted .env splits into rows, Add takes the rows with a
// value; the import line counts what came in; where browsers export is the band's right-click menu, each path whole.
// Owns: these assertions. Never: a real window, runtime or file watcher.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readConnectors } from '../../../src/runtime/apps/connectors.ts';
import { APP_CATALOG, catalogConnected, searchCatalog } from '../../../src/ui/settings/apps-catalog.ts';
import { appAction, appLine, freeKey, mailEntry, nameFromAddress, patchedEntry, splitCommand, switchPatch, tokenHeaders, withEntry, withoutEntry, withToken } from '../../../src/ui/settings/apps-files.ts';
import { lastRestoreText, reportLine, sendable } from '../../../src/ui/settings/feedback-text.ts';
import {
  BAND_HINT, deleteGroupText, draftFields, EXPORT_SOURCES, exportMenu, fieldsOf, groupBlocked, groupPayload, importLine, normalizeFieldName, pastedRows, readyRows, withEmptyRow,
  type GroupDraft, type KvRow,
} from '../../../src/ui/settings/secret-groups.ts';
import type { SecretInfo } from '../../../src/shared/model/security.ts';

/** What the runtime makes of these two file texts. */
function read(mcp: string, mail = '') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apps-files-'));
  try {
    mkdirSync(path.join(dir, 'connectors'));
    writeFileSync(path.join(dir, 'connectors', 'mcp.json'), mcp);
    if (mail) writeFileSync(path.join(dir, 'connectors', 'mail.json'), mail);
    return readConnectors(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('connector files: an added server is what the runtime reads, the others stay, a name is never reused', () => {
  const start = JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['x'], env: { A: 'secret://a' } } }, other: 1 });
  const text = withEntry('mcp.json', start, 'Notion', { url: 'https://mcp.notion.com/mcp' });
  const again = withEntry('mcp.json', text, 'Notion', { url: 'https://example.com/mcp', headers: tokenHeaders('sec_1') });
  assert.equal(JSON.parse(again).other, 1, 'what the app does not know stays');
  const { connectors, problems } = read(again);
  assert.deepEqual(problems, []);
  assert.deepEqual(connectors.map((entry) => entry.name), ['files', 'Notion', 'Notion 2']);
  assert.deepEqual(connectors[0].env, { A: 'secret://a' });
  assert.equal(connectors[2].headers?.Authorization, 'Bearer secret://sec_1');
  assert.equal(freeKey('a', { a: 1, 'a 2': 1 }), 'a 3');
});

test('connector files: off, on and remove', () => {
  const text = withEntry('mcp.json', '', 'x', { url: 'https://x.example/mcp', enabled: false });
  const off = patchedEntry('mcp.json', text, 'x', switchPatch(false));
  assert.equal(read(off).connectors[0].enabled, false);
  const on = patchedEntry('mcp.json', off, 'x', switchPatch(true));
  assert.equal(read(on).connectors[0].enabled, true, 'neither "disabled" nor another tool\'s "enabled": false stays');
  assert.deepEqual(read(withoutEntry('mcp.json', on, 'x')).connectors, []);
  assert.throws(() => patchedEntry('mcp.json', on, 'gone', {}), /no longer/);
});

test('connector files: a token replaces Authorization in any spelling, the other headers stay', () => {
  const text = withEntry('mcp.json', '', 'x', { url: 'https://x.example/mcp', headers: { authorization: 'Bearer old', 'X-Team': 'a' } });
  const [app] = read(withToken('mcp.json', text, 'x', 'sec_9')).connectors;
  assert.deepEqual(app.headers, { 'X-Team': 'a', Authorization: 'Bearer secret://sec_9' });
  assert.throws(() => withToken('mcp.json', text, 'gone', 'sec_9'), /no longer/);
});

test('connector files: a broken file stays untouched and says so', () => {
  assert.throws(() => withEntry('mcp.json', '{ broken', 'x', {}), /not valid JSON/);
  assert.throws(() => withEntry('mcp.json', '{"mcpServers": []}', 'x', {}), /must be an object/);
});

test('mailbox: the runtime reads the entry; servers both or none', () => {
  const none = { address: '', password: '', imapHost: '', imapPort: '', smtpHost: '', smtpPort: '' };
  assert.match(mailEntry(none).blocked, /email address/);
  assert.match(mailEntry({ ...none, address: 'me@x.de' }).blocked, /password/);
  const plain = mailEntry({ ...none, address: ' me@x.de ', password: 'p' });
  assert.deepEqual(plain, { blocked: '', entry: { address: 'me@x.de' } });
  assert.match(mailEntry({ ...none, address: 'me@x.de', password: 'p', imapHost: 'imap.x.de' }).blocked, /both servers/);
  assert.match(mailEntry({ ...none, address: 'me@x.de', password: 'p', imapHost: 'imap.x.de', smtpHost: 'smtp.x.de', smtpPort: 'abc' }).blocked, /port/);
  const own = mailEntry({ ...none, address: 'me@x.de', password: 'p', imapHost: 'imap.x.de', smtpHost: 'smtp.x.de', smtpPort: '587' });
  const text = withEntry('mail.json', '', 'me@x.de', { ...own.entry, password: 'secret://sec_2' });
  const [box] = read('{}', text).connectors;
  assert.equal(box.transport, 'mail');
  assert.equal(box.mail?.password, 'secret://sec_2');
  assert.deepEqual(box.mail?.smtp, { host: 'smtp.x.de', port: 587, tls: 'starttls' });
  assert.deepEqual(box.mail?.imap, { host: 'imap.x.de', port: 993, tls: 'implicit' });
});

test('add by address: a command line and a name from it', () => {
  assert.deepEqual(splitCommand('npx -y "my server" C:/Docs'), { command: 'npx', args: ['-y', 'my server', 'C:/Docs'] });
  assert.equal(nameFromAddress('https://mcp.notion.com/mcp'), 'notion');
  assert.equal(nameFromAddress('C:/tools/server.exe'), 'server');
});

test('catalog: search and what is connected already', () => {
  assert.deepEqual(searchCatalog('jira issues').map((entry) => entry.name), ['Jira & Confluence']);
  assert.equal(searchCatalog('').length, APP_CATALOG.length);
  assert.deepEqual(searchCatalog('no such app'), []);
  assert.equal(catalogConnected({ url: 'https://mcp.notion.com/mcp' }, ['mcp.notion.com']), true);
  assert.equal(catalogConnected({ url: 'https://mcp.notion.com/mcp' }, ['mcp.linear.app']), false);
  for (const entry of APP_CATALOG) if (entry.auth === 'token') assert.ok(entry.tokenHint, `${entry.name} says where its token comes from`);
});

test('an app row: its line and its one action', () => {
  assert.equal(appLine({ address: 'a.example', status: 'ok', tools: 1 }), 'a.example · Connected · 1 tool'); // AF-005: the status in words
  assert.equal(appLine({ address: 'a.example', status: 'error', tools: 0, error: 'refused' }), 'a.example · refused');
  assert.equal(appAction({ status: 'ok' })?.label, 'Test');
  assert.equal(appAction({ status: 'signin' })?.label, 'Connect again');
  assert.equal(appAction({ status: 'waiting', signInUrl: 'https://x' })?.kind, 'page');
  assert.equal(appAction({ status: 'connecting' })?.wait, true);
  assert.equal(appAction({ status: 'off' }), undefined);
});

const stored = (field: string, kind: SecretInfo['kind'], id: string): SecretInfo => ({ id, label: 'L', kind, field, createdAt: 1, group: { id: 'g', label: 'L', kind: 'login' } });

test('a login: empty keeps the stored value, a marked field goes, the optional 2FA key is not created', () => {
  const fields = draftFields('login', [stored('password', 'password', 'p1'), stored('note', 'note', 'n1')]);
  assert.deepEqual(fields.map((field) => [field.field, field.id]), [['username', undefined], ['password', 'p1'], ['totp', undefined], ['note', 'n1']]);
  const draft: GroupDraft = {
    kind: 'login', label: ' Site ', description: ' why ', removed: ['n1'],
    fields: fields.map((field) => (field.field === 'username' ? { ...field, value: 'me' } : field)),
  };
  assert.deepEqual(groupPayload(draft, { id: 'g', stored: true }), {
    id: 'g', label: 'Site', description: 'why', fields: [{ field: 'username', kind: 'text', value: 'me' }], remove: ['n1'],
  });
  assert.equal(groupBlocked(draft, true), '');
});

test('a new card and a file entry without a value', () => {
  const fields = draftFields('card').map((field) => (field.field === 'number' ? { ...field, value: '4242' } : field));
  const draft: GroupDraft = { kind: 'card', label: 'Visa', description: '', fields, removed: [] };
  assert.deepEqual(groupPayload(draft), { kind: 'card', label: 'Visa', description: '', fields: [{ field: 'number', kind: 'card', value: '4242' }] });
  const file = groupPayload(draft, { id: 'from-file', stored: false, route: 'payment' });
  assert.equal(file.id, 'from-file');
  assert.equal(file.kind, 'card', 'it does not exist yet, so it needs its kind');
  assert.equal(file.route, 'payment', 'it keeps its place in the catalog');
  assert.match(groupBlocked({ ...draft, fields: draftFields('card') }, false), /value/);
  assert.match(groupBlocked({ ...draft, label: ' ' }, false), /name/);
});

test('free fields: names as the vault takes them, a row without a name is not sent', () => {
  assert.equal(normalizeFieldName(' 2 Recovery Code! '), 'recovery_code');
  const fields = draftFields('other');
  assert.equal(fields.length, 1, 'a new group starts with one row');
  const draft: GroupDraft = { kind: 'other', label: 'x', description: '', removed: [], fields: [{ ...fields[0], value: 'v' }, { field: 'Pin Code', kind: 'password', value: '1' }] };
  assert.deepEqual(groupPayload(draft).fields, [{ field: 'pin_code', kind: 'password', value: '1' }]);
  assert.match(groupBlocked({ ...draft, fields: [{ ...fields[0], value: 'v' }] }, false), /value/);
  assert.match(groupBlocked(draft, false), /Name each field/, 'a value without a name is not lost silently');
  assert.match(groupBlocked(draft, true), /Name each field/, 'on an edit too');
});

test('a group lists its own fields in the template order', () => {
  const list = [stored('totp', 'totp', 't'), stored('password', 'password', 'p'), { ...stored('username', 'text', 'u'), group: { id: 'other', label: 'L', kind: 'login' as const } }];
  assert.deepEqual(fieldsOf({ id: 'g', kind: 'login' }, list).map((info) => info.id), ['p', 't']);
  assert.match(deleteGroupText(1), /Its 1 field goes/);
  assert.match(deleteGroupText(3), /Its 3 fields go/);
});

/** Rows with ids r1, r2 … in the order they are made. */
function rowMaker() {
  let count = 0;
  return () => ({ id: `r${++count}`, name: '', value: '' });
}

test('Name | Value rows: always one empty row at the end, never two', () => {
  const fresh = rowMaker();
  assert.deepEqual(withEmptyRow([], fresh), [{ id: 'r1', name: '', value: '' }]);
  const typed: KvRow[] = [{ id: 'a', name: 'KEY', value: '' }];
  assert.deepEqual(withEmptyRow(typed, fresh).map((row) => row.id), ['a', 'r2'], 'typing into the empty row brings a new one');
  const emptied: KvRow[] = [{ id: 'a', name: '', value: '' }, { id: 'b', name: '', value: '' }];
  assert.deepEqual(withEmptyRow(emptied, fresh).map((row) => row.id), ['a'], 'the row being cleared stays, the extra one goes');
  assert.deepEqual(withEmptyRow([{ id: 'x', name: '', value: '' }, { id: 'y', name: 'B', value: '2' }], fresh).map((row) => row.id), ['x', 'y', 'r3'], 'an empty row in the middle stays');
});

test('a pasted .env or JSON splits into rows; a single value with "=" pasted into Value stays a value', () => {
  const fresh = rowMaker();
  const rows: KvRow[] = [{ id: 'a', name: 'FIRST', value: '1' }, { id: 'e', name: '', value: '' }];
  const env = pastedRows(rows, 1, 'name', 'A=1\nB="two words"\n# note\nC=3', fresh)!;
  assert.deepEqual(env.map((row) => [row.name, row.value]), [['FIRST', '1'], ['A', '1'], ['B', 'two words'], ['C', '3'], ['', '']], 'three rows replace the empty one');
  const after = pastedRows(rows, 0, 'name', '{"X":"y"}', fresh)!;
  assert.deepEqual(after.map((row) => row.name), ['FIRST', 'X', ''], 'a filled row stays, the new rows follow it');
  assert.deepEqual(pastedRows(rows, 1, 'name', 'TOKEN=abc', fresh)!.map((row) => [row.name, row.value]), [['FIRST', '1'], ['TOKEN', 'abc'], ['', '']], 'one KEY=value splits in Name');
  assert.equal(pastedRows(rows, 1, 'value', 'dGVzdA==', fresh), undefined, 'a base64 value pasted into Value stays as it is');
  assert.equal(pastedRows(rows, 1, 'value', 'A=1', fresh), undefined);
  assert.equal(pastedRows(rows, 1, 'value', 'A=1\nB=2', fresh)?.length, 4, 'two pairs pasted into Value split too');
  assert.equal(pastedRows(rows, 1, 'name', 'sk-plain-key', fresh), undefined, 'a bare value is pasted as it is');
});

test('Add takes the rows with a value and waits for a name; Attach needs only the value', () => {
  const rows: KvRow[] = [{ id: 'a', name: 'KEY', value: 'v' }, { id: 'b', name: 'ONLY_NAME', value: '' }, { id: 'c', name: '', value: '' }];
  assert.deepEqual(readyRows(rows, true), { ready: [rows[0]], blocked: '' });
  assert.match(readyRows([...rows, { id: 'd', name: ' ', value: 'w' }], true).blocked, /Give every value a name/);
  assert.equal(readyRows([...rows, { id: 'd', name: '', value: 'w' }], false).blocked, '', 'a chat secret may go without a name');
  assert.match(readyRows([rows[1], rows[2]], true).blocked, /Enter a name and a value/);
});

test('the import line counts what came in; a password export may go afterwards, a .env stays', () => {
  const base = { format: 'Chrome', added: 2, cards: 0, keys: 0, unchanged: 1, differing: 0, skipped: 0, failed: 0, tag: 't' };
  assert.equal(importLine({ ...base, reviewer: 'Ava' }), '2 logins added · 1 already stored (Chrome). Ava now names, describes and checks them. The export file can go now: it holds every password in plain text.');
  assert.equal(importLine({ ...base, format: '.env file', added: 0, keys: 3, unchanged: 0 }), '3 secrets added (.env file).');
  assert.equal(importLine({ ...base, format: 'JSON file', added: 0, unchanged: 0 }), 'Nothing new (JSON file).');
  assert.match(BAND_HINT, /^Paste a \.env into Name to split it, or drop a \.env, a JSON or a password export here\. Right-click: where each browser exports\.$/);
  assert.ok(BAND_HINT.length <= 126, 'two 18 px lines at phone width (343 px, measured)');
});

test('the band\'s right-click menu shows every export path whole and copies the address one starts at', () => {
  const copied: string[] = [];
  const [section] = exportMenu((address) => copied.push(address));
  assert.equal(section.title, 'Where to export passwords');
  assert.deepEqual(section.items.map((item) => [item.label, item.description]), EXPORT_SOURCES.map(([from, where]) => [from, where]), 'text only, the whole path under each name');
  assert.ok(section.items.every((item) => !item.icon));
  for (const item of section.items) item.onSelect();
  assert.deepEqual(copied, ['chrome://password-manager/settings', 'edge://wallet/passwords', 'about:logins'], 'Safari and the managers have no address to copy');
  assert.deepEqual(section.items.map((item) => item.hint ?? ''), ['Copy', 'Copy', 'Copy', '', '']);
  assert.ok(EXPORT_SOURCES.some(([, where]) => where.includes('Bitwarden, 1Password, KeePass, LastPass, Dashlane, Proton Pass, NordPass')));
});

test('feedback and restore lines', () => {
  const when = () => 'then';
  const base = { kind: 'bug' as const, author: 'human', status: 'local' as const, createdAt: 1 };
  assert.equal(reportLine(base, () => 'Ada', when), 'Bug · Saved on this PC · then');
  assert.equal(reportLine({ ...base, author: 'a1', count: 3, status: 'sent' }, () => 'Ada', when), 'Bug · Ada · Unverified · Reported 3 times · Sent to the team · then');
  assert.equal(reportLine(base, () => 'Ada', when, 'your PC'), 'Bug · Saved on your PC · then');
  assert.equal(reportLine({ ...base, status: 'sent', url: 'https://x' }, () => 'Ada', when), 'Bug · Published on GitHub · then');
  assert.equal(sendable({ status: 'local' }, true), true);
  assert.equal(sendable({ status: 'local' }, false), false);
  assert.equal(sendable({ status: 'local', receiptId: 'r' }, true), false, 'a report already handed over is never sent twice');
  assert.equal(lastRestoreText({ ok: false, at: 1, from: 'x', error: 'no' }, when), 'Last restore was not applied (then): no');
  assert.equal(lastRestoreText({ ok: true, at: 1, from: 'x', reentry: { accounts: 2, secrets: 0, devices: 1, homes: 0 } }, when), 'Restored then from x · to set up again: 2 sign-ins, 1 link to pair');
});
