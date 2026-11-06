// Settings › Secrets – the catalog's selection (owner 04.11.2026, ui/settings/secret-catalog.ts): every entry starts
// selected, a new one too; None deselects all, All selects all again, a box toggles one; Export takes the selected entries
// that hold a value; Delete removes each selected one with secrets.delete or (a login or card) secrets.deleteGroup and goes
// on after a failure; a login shows its username where the mask was, a card its last digits; the export's toast names the
// file and counts. Owns: these assertions. Never: a real window or runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecretFileEntry, SecretGroup, SecretInfo } from '../../../src/shared/model/security.ts';
import {
  catalogEntries, deleteEntries, deleteQuestion, entryLine, exportIds, exportNote, noneSelected, selectedEntries, shownHint, toggled,
} from '../../../src/ui/settings/secret-catalog.ts';

const group = (id: string, label: string, kind: SecretGroup['kind'], route: string): SecretGroup => ({ id, label, kind, route, createdAt: 1 });
const field = (id: string, groupOf: SecretGroup, name: string, kind: SecretInfo['kind'], hint?: string): SecretInfo => ({
  id, label: `${groupOf.label} · ${name}`, kind, field: name, createdAt: 1, group: { id: groupOf.id, label: groupOf.label, kind: groupOf.kind }, ...(hint ? { hint } : {}),
});
const login = group('g_login', 'OpenAI - max@firma.de', 'login', 'logins');
const card = group('g_card', 'Company Visa', 'card', 'payment');
const secrets: SecretInfo[] = [
  field('f_user', login, 'username', 'text', 'max@firma.de'), field('f_pass', login, 'password', 'password'),
  field('f_num', card, 'number', 'card', '•••• 1111'),
  { id: 'sec_key', label: 'Deploy key', kind: 'api_key', route: 'keys', createdAt: 1 },
  { id: 'sec_own', label: 'Calendar link', kind: 'token', route: 'keys', createdAt: 1, createdBy: 'system' },
];
const missing: SecretFileEntry[] = [{ id: 'sec_file', name: 'From a file', kind: 'api_key', route: 'keys' }];
const entries = catalogEntries(secrets, [login, card], missing);

test('the catalog lists the person\'s entries by route; a login shows its username, a card its last digits', () => {
  assert.deepEqual(entries.map((entry) => entry.id), ['g_login', 'g_card', 'sec_key', 'sec_file'], 'the app\'s own calendar link is not listed');
  assert.deepEqual(entries.map((entry) => shownHint(entry, secrets)), ['max@firma.de', '•••• 1111', undefined, undefined]);
});

test('everything starts selected, a new entry too; None, All and one box', () => {
  assert.equal(selectedEntries(entries, new Set()).length, 4, 'nothing deselected: all selected');
  const none = noneSelected(entries);
  assert.equal(selectedEntries(entries, none).length, 0);
  const one = toggled(none, 'sec_key');
  assert.deepEqual(selectedEntries(entries, one).map((entry) => entry.id), ['sec_key']);
  assert.deepEqual([...toggled(one, 'sec_key')].sort(), [...none].sort(), 'a second click deselects it again');
  assert.ok(!one.has('sec_key') && none.has('sec_key'), 'the set given is never changed');
  const later = catalogEntries([...secrets, { id: 'sec_new', label: 'New key', kind: 'api_key', route: 'keys', createdAt: 2 }], [login, card], missing);
  assert.ok(selectedEntries(later, toggled(new Set(), 'sec_key')).some((entry) => entry.id === 'sec_new'), 'an entry that came later is selected');
});

test('an entry the app works with starts unselected, says so, and only its own box selects it (B-075)', () => {
  const appKey: SecretInfo = { id: 'sec_app', label: 'OpenAI key (account)', kind: 'api_key', route: 'keys', createdAt: 1, usedByApp: true };
  const list = catalogEntries([...secrets, appKey], [login, card], missing);
  const app = list.find((entry) => entry.id === 'sec_app')!;
  assert.match(entryLine(app), /Used by the app/);
  assert.ok(!selectedEntries(list, new Set()).some((entry) => entry.id === 'sec_app'), 'All leaves it out');
  assert.ok(!noneSelected(list).has('sec_app'), 'None does not touch it');
  assert.ok(selectedEntries(list, toggled(new Set(), 'sec_app')).some((entry) => entry.id === 'sec_app'), 'its own box selects it');
  assert.ok(!selectedEntries(list, toggled(toggled(new Set(), 'sec_app'), 'sec_app')).some((entry) => entry.id === 'sec_app'), 'a second click unselects it');
});

test('Export takes the selected entries with a value; its toast names the file and the counts', () => {
  assert.deepEqual(exportIds(entries), ['g_login', 'g_card', 'sec_key'], 'a file without a value has nothing to export');
  assert.deepEqual(exportIds(selectedEntries(entries, toggled(new Set(), 'g_card'))), ['g_login', 'sec_key']);
  assert.deepEqual(exportNote({ file: 'C:/Users/me/Downloads/autark-secrets-2026-11-04.csv', count: 3, skipped: 0 }), {
    title: '3 entries exported', body: 'C:/Users/me/Downloads/autark-secrets-2026-11-04.csv – it holds every value in plain text.',
  });
  assert.match(exportNote({ file: 'f.csv', count: 1, skipped: 2 }).body, /^f\.csv – it holds every value in plain text\. 2 skipped/);
  assert.equal(exportNote({ file: 'f.csv', count: 1, skipped: 0 }).title, '1 entry exported');
});

test('Delete asks once, then removes each selected entry with its method and goes on after a failure', async () => {
  assert.deepEqual(deleteQuestion(4), { title: 'Delete 4 entries?', body: 'Agents using them lose access; your linked PCs remove them too.' });
  assert.equal(deleteQuestion(1).title, 'Delete 1 entry?');
  const calls: string[] = [];
  const result = await deleteEntries(entries, async (method, id) => {
    calls.push(`${method} ${id}`);
    if (id === 'sec_key') throw new Error('gone already');
  }, (error) => (error as Error).message);
  assert.deepEqual(calls, ['secrets.deleteGroup g_login', 'secrets.deleteGroup g_card', 'secrets.delete sec_key', 'secrets.delete sec_file']);
  assert.deepEqual(result, { deleted: 3, failure: 'gone already' });
});
