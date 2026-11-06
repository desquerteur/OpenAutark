// B-053 track D: the IMAP side of mail (runtime/apps/mail/{imap-parse,imap,mailbox,actions,idle,index}.ts) against
// the fake IMAP server over plain TCP (TLS seam): response grammar (literals, quoted escapes, NIL, sections, codes),
// modified UTF-7; login (SASL-IR, AUTHENTICATE continuation, LOGIN, refusal → ReconnectNeeded), STARTTLS, special-use
// folders (attributes beat name guesses), search/read with literals in ENVELOPE and BODY[], UTF-8 search, stale ids,
// MOVE and its COPY fallback, APPEND with a synchronizing literal, delete to Trash then for good, flags, create,
// a silent server (timeout), and the IDLE watcher (new mail, renewal, reconnect after a drop, close).
// Owns: checks of the IMAP half of runtime/apps/mail/*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { readFileSync } from 'node:fs';
import { connectMail, LOGIN_REFUSED } from '../../../src/runtime/apps/mail/index.ts';
import { ImapClient } from '../../../src/runtime/apps/mail/imap.ts';
import { decodeMailboxName, encodeMailboxName, fetchMap, parseEnvelope, parseResponse } from '../../../src/runtime/apps/mail/imap-parse.ts';
import { McpTransportError, ReconnectNeeded, type MailTarget, type McpCallResult, type McpConnection } from '../../../src/runtime/apps/types.ts';
import { FakeImap, type FakeImapOptions } from '../../fixtures/apps/mail-fake-imap.ts';

const CLIENT = { clientInfo: { name: 'workforce', version: '0.2.0' } };
const tls = (o: { host: string; port: number; socket?: net.Socket }) => o.socket ?? net.connect({ host: o.host, port: o.port });
const plain = (o: { host: string; port: number }) => net.connect({ host: o.host, port: o.port });
const SEAMS = { tls, net: plain };
const eml = (name: string) => readFileSync(new URL(`../../fixtures/apps/${name}`, import.meta.url), 'utf8');

function target(port: number, extra: Partial<MailTarget> = {}): MailTarget {
  return {
    kind: 'mail', address: 'me@example.com',
    imap: { host: '127.0.0.1', port, tls: 'implicit' }, smtp: { host: '127.0.0.1', port: 1, tls: 'implicit' },
    login: async () => ({ user: 'me@example.com', password: 'app-pass' }), ...extra,
  };
}

async function withFake(opts: FakeImapOptions, run: (fake: FakeImap, open: (extra?: Partial<MailTarget>) => Promise<McpConnection>) => Promise<void>): Promise<void> {
  const fake = await new FakeImap(opts).start();
  const opened: McpConnection[] = [];
  try {
    await run(fake, async (extra) => { const c = await connectMail(target(fake.port, extra), { ...CLIENT, ...SEAMS, timeoutMs: 3_000 }); opened.push(c); return c; });
  } finally {
    for (const c of opened) await c.close();
    await fake.stop();
  }
}

const textOf = (r: McpCallResult) => (r.content[0] as { text: string }).text;
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > ms) throw new Error('condition not reached'); await new Promise((r) => setTimeout(r, 10)); }
}

test('response grammar: literals, quoted escapes, NIL, nested lists, [section] atoms, status codes; modified UTF-7', () => {
  const fetch = parseResponse(['* 12 FETCH (UID 7 FLAGS (\\Seen $Label) BODY[HEADER.FIELDS (FROM TO)] {5}', Buffer.from('a\r\nb!'), ' ENVELOPE (NIL "Sub \\"q\\" \\\\" NIL NIL NIL NIL NIL NIL NIL NIL))']);
  assert.equal(fetch.kind, 'untagged');
  if (fetch.kind !== 'untagged') return;
  assert.equal(fetch.num, 12);
  assert.equal(fetch.type, 'FETCH');
  const row = fetchMap(fetch.values);
  assert.equal(row.get('UID'), '7');
  assert.deepEqual(row.get('FLAGS'), ['\\Seen', '$Label']);
  assert.deepEqual(row.get('BODY[HEADER.FIELDS (FROM TO)]'), Buffer.from('a\r\nb!'));
  assert.equal(parseEnvelope(row.get('ENVELOPE')).subject, 'Sub "q" \\');
  assert.deepEqual(parseResponse(['W3 NO [TRYCREATE] no such mailbox']), { kind: 'tagged', tag: 'W3', status: 'NO', code: 'TRYCREATE', text: 'no such mailbox' });
  assert.deepEqual(parseResponse(['* OK [UIDVALIDITY 42] fine']), { kind: 'untagged', type: 'OK', values: [], code: 'UIDVALIDITY 42', text: 'fine' });
  assert.deepEqual(parseResponse(['+ idling']), { kind: 'cont', text: 'idling' });
  const list = parseResponse(['* LIST (\\HasNoChildren \\Trash) "/" {11}', Buffer.from('Gel&APY-scht'.slice(0, 11)), '']);
  assert.ok(list.kind === 'untagged' && Buffer.isBuffer(list.values[2]));
  for (const [plainName, wire] of [['Entwürfe', 'Entw&APw-rfe'], ['a&b', 'a&-b'], ['日本語', '&ZeVnLIqe-'], ['INBOX', 'INBOX']]) {
    assert.equal(encodeMailboxName(plainName), wire);
    assert.equal(decodeMailboxName(wire), plainName);
  }
});

test('folders: special-use attributes, a name guess only where no attribute has the role, containers, decoded names', async () => {
  await withFake({}, async (_fake, open) => {
    const mail = await open();
    assert.deepEqual((await mail.listTools()).map((t) => t.name), ['search', 'read', 'folders', 'draft', 'send', 'reply', 'move', 'mark', 'create_folder', 'delete']);
    const result = await mail.callTool('folders', {});
    const rows = (result.structuredContent as { folders: Array<{ name: string; role?: string; selectable: boolean }> }).folders;
    const role = (name: string) => rows.find((r) => r.name === name)?.role;
    assert.equal(role('INBOX'), 'inbox');
    assert.equal(role('Drafts'), 'drafts');
    assert.equal(role('Sent Items'), 'sent');
    assert.equal(role('Papierkorb'), 'trash');
    assert.equal(role('Spam'), 'junk');
    assert.equal(role('Archiv'), 'archive');
    assert.equal(role('Entwürfe'), undefined, 'Drafts has the role by attribute');
    assert.equal(rows.find((r) => r.name === 'Projekte')?.selectable, false);
    assert.match(textOf(result), /Projekte – container only/);
  });
});

test('search and read: newest first, filters, Gmail-less TEXT, UTF-8 search as a literal, attachments listed, stale ids refused', async () => {
  await withFake({}, async (fake, open) => {
    fake.add('INBOX', eml('mail-alternative.eml'), [], new Date('2026-10-27T08:15:00Z'));
    fake.add('INBOX', eml('mail-attachment.eml'), ['\\Seen', '\\Flagged'], new Date('2026-10-28T18:00:00Z'));
    fake.add('INBOX', eml('mail-html-only.eml'), ['\\Seen'], new Date('2026-10-29T07:00:00Z'));
    const mail = await open();
    const all = await mail.callTool('search', {});
    const found = (all.structuredContent as { total: number; messages: Array<{ id: string; subject: string; from: string; unread: boolean; flagged: boolean; snippet: string; date: string }> });
    assert.equal(found.total, 3);
    assert.deepEqual(found.messages.map((m) => m.subject), ['Café – news', 'Your invoice', 'Grüße aus München and more']);
    assert.equal(found.messages[2].from, 'Anna Müller <anna@example.org>');
    assert.equal(found.messages[2].unread, true);
    assert.equal(found.messages[1].flagged, true);
    assert.equal(found.messages[2].date, '2026-10-27T08:15:00.000Z');
    assert.match(found.messages[2].snippet, /^Hallo John, die Straße ist gesperrt/);
    assert.match(textOf(all), /^3 messages in INBOX:\n1\. 2026-10-29 07:00 · News, Weekly <news@letter\.example> → me@example\.com · "Café – news"/);
    const byFrom = (await mail.callTool('search', { from: 'billing', limit: 5 })).structuredContent as { messages: Array<{ subject: string }> };
    assert.deepEqual(byFrom.messages.map((m) => m.subject), ['Your invoice']);
    const unread = (await mail.callTool('search', { unread: true })).structuredContent as { total: number };
    assert.equal(unread.total, 1);
    const text = (await mail.callTool('search', { query: 'gesperrt', since: '2026-10-01' })).structuredContent as { total: number };
    assert.equal(text.total, 1);
    await mail.callTool('search', { subject: 'Grüße' });
    assert.ok(fake.log.some((l) => /^UID SEARCH CHARSET UTF-8 SUBJECT Grüße$/.test(l)), fake.log.join('\n'));
    const none = await mail.callTool('search', { folder: 'spam' });
    assert.equal(textOf(none), 'No messages in Spam match.');

    const invoice = found.messages[1].id;
    assert.match(invoice, /^INBOX\/7000\/2$/);
    const read = await mail.callTool('read', { id: invoice });
    assert.match(textOf(read), /^From: Billing <billing@shop\.example>\nTo: me@example\.com\nDate: 2026-10-28T18:00:00\.000Z\nSubject: Your invoice\n\nHier ist Ihre Rechnung über 12 €\./);
    assert.match(textOf(read), /Attachments \(2\): invoice\.pdf \(application\/pdf, 52 bytes\); Rechnungsübersicht\.txt \(text\/plain, 5 bytes\)/);
    assert.ok(!textOf(read).includes('JVBERi0'));
    const bad = await mail.callTool('read', { id: 'nonsense' });
    assert.equal(bad.isError, true);
    const stale = await mail.callTool('read', { id: 'INBOX/1/2' });
    assert.match(textOf(stale), /out of date/);
    const gone = await mail.callTool('read', { id: 'INBOX/7000/99' });
    assert.match(textOf(gone), /gone/);
    assert.equal(fake.folders.get('INBOX')!.messages[0].flags.has('\\Seen'), false, 'reading uses BODY.PEEK');
  });
});

test('login: AUTHENTICATE continuation without SASL-IR, LOGIN without AUTH=PLAIN, a refusal is ReconnectNeeded', async () => {
  await withFake({ caps: ['IMAP4rev1', 'AUTH=PLAIN', 'UIDPLUS'], quietGreeting: true }, async (fake, open) => {
    await open();
    assert.ok(fake.log.includes('CAPABILITY') && fake.log.includes('AUTHENTICATE <hidden>'));
  });
  await withFake({ caps: ['IMAP4rev1'] }, async (fake, open) => {
    await open({ login: async () => ({ user: 'me@example.com', password: 'app-pass' }) });
    assert.ok(fake.log.includes('LOGIN <hidden>'));
    await assert.rejects(open({ login: async () => ({ user: 'me@example.com', password: 'wrong' }) }), (e: unknown) => e instanceof ReconnectNeeded && e.message === LOGIN_REFUSED);
  });
  await withFake({ password: 'pässwörd' }, async (_fake, open) => {
    await open({ login: async () => ({ user: 'me@example.com', password: 'pässwörd' }) }); // UTF-8 in SASL PLAIN
  });
});

test('STARTTLS: the plain socket is handed to the TLS seam before anything else is said', async () => {
  const fake = await new FakeImap({ caps: ['IMAP4rev1', 'STARTTLS', 'AUTH=PLAIN', 'SASL-IR'] }).start();
  const wrapped: boolean[] = [];
  try {
    const conn = await connectMail({ ...target(fake.port), imap: { host: '127.0.0.1', port: fake.port, tls: 'starttls' } }, {
      ...CLIENT, net: plain, tls: (o) => { wrapped.push(!!o.socket); return tls(o); }, timeoutMs: 3_000,
    });
    assert.deepEqual(wrapped, [true]);
    assert.deepEqual(fake.log.slice(0, 3), ['STARTTLS', 'CAPABILITY', 'AUTHENTICATE <hidden>']);
    await conn.close();
  } finally { await fake.stop(); }
});

test('move with MOVE, and the COPY + \\Deleted + UID EXPUNGE fallback; mark; create a nested folder', async () => {
  await withFake({}, async (fake, open) => {
    fake.add('INBOX', eml('mail-attachment.eml'));
    const mail = await open();
    const moved = await mail.callTool('move', { id: 'INBOX/7000/1', folder: 'archive' });
    assert.deepEqual(moved.structuredContent, { folder: 'Archiv', id: 'Archiv/7005/1' });
    assert.ok(fake.log.includes('UID MOVE 1 Archiv'));
  });
  await withFake({ caps: ['IMAP4rev1', 'LITERAL+', 'SASL-IR', 'AUTH=PLAIN', 'UIDPLUS'] }, async (fake, open) => {
    fake.add('INBOX', eml('mail-attachment.eml'));
    const mail = await open();
    const moved = await mail.callTool('move', { id: 'INBOX/7000/1', folder: 'Spam' });
    assert.equal((moved.structuredContent as { id: string }).id, 'Spam/7004/1');
    assert.deepEqual(fake.log.filter((l) => l.startsWith('UID')).slice(-3), ['UID COPY 1 Spam', 'UID STORE 1 +FLAGS.SILENT (\\Deleted)', 'UID EXPUNGE 1']);
    assert.equal(fake.folders.get('INBOX')!.messages.length, 0);
    const marked = await mail.callTool('mark', { id: 'Spam/7004/1', read: true, flagged: true });
    assert.equal(textOf(marked), 'Marked read and flagged.');
    assert.deepEqual([...fake.folders.get('Spam')!.messages[0].flags].sort(), ['\\Flagged', '\\Seen']);
    assert.equal((await mail.callTool('mark', { id: 'Spam/7004/1' })).isError, true);
    const created = await mail.callTool('create_folder', { name: 'Kunden/Acme' });
    assert.equal(textOf(created), 'Created the folder Kunden/Acme.');
    assert.ok(fake.folders.has('Kunden/Acme'));
    assert.equal((await mail.callTool('create_folder', { name: 'kunden/acme' })).isError, true);
    assert.equal((await mail.callTool('move', { id: 'Spam/7004/1', folder: 'Nowhere' })).isError, true);
  });
});

test('draft with a synchronizing literal (no LITERAL+); delete moves to Trash, then deletes for good', async () => {
  await withFake({ caps: ['IMAP4rev1', 'SASL-IR', 'AUTH=PLAIN', 'MOVE', 'UIDPLUS', 'SPECIAL-USE'] }, async (fake, open) => {
    const mail = await open();
    const draft = await mail.callTool('draft', { to: 'Bob <bob@example.net>', subject: 'Plan für Montag', text: 'Hallo Bob,\n.\nbis dann' });
    assert.match(textOf(draft), /^Draft saved in Drafts: "Plan für Montag" to Bob <bob@example\.net>\. id: Drafts\/7001\/1$/);
    const saved = fake.folders.get('Drafts')!.messages[0];
    assert.deepEqual([...saved.flags], ['\\Draft', '\\Seen']);
    assert.match(saved.raw.toString(), /Subject: =\?UTF-8\?B\?/);
    assert.equal((await mail.callTool('draft', { to: 'not an address', subject: 's', text: 't' })).isError, true);
    const del = await mail.callTool('delete', { id: 'Drafts/7001/1' });
    assert.deepEqual(del.structuredContent, { folder: 'Papierkorb', id: 'Papierkorb/7003/1', permanent: false });
    const forGood = await mail.callTool('delete', { id: 'Papierkorb/7003/1' });
    assert.equal(textOf(forGood), 'Deleted for good (it was in Trash).');
    assert.equal(fake.folders.get('Papierkorb')!.messages.length, 0);
  });
});

test('a server that stops answering: the command times out as McpTransportError(sent: true)', async () => {
  const server = net.createServer((s) => { s.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] hi\r\n'); s.on('error', () => undefined); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const client = await ImapClient.open({ host: '127.0.0.1', port, tls: 'implicit' }, { sockets: SEAMS, timeoutMs: 200 });
    await assert.rejects(client.command(['NOOP']), (e: unknown) => e instanceof McpTransportError && e.sent && /did not answer in time/.test(e.message));
    assert.equal(client.isOpen, false);
  } finally { server.close(); }
});

test('IDLE watcher: new mail wakes onNewMail with sender and subject, IDLE is renewed, a drop reconnects, close ends it', async () => {
  const seen: Array<{ count: number; from?: string; subject?: string }> = [];
  const fake = await new FakeImap({}).start();
  try {
    const conn = await connectMail(target(fake.port, { onNewMail: (info) => seen.push(info) }), { ...CLIENT, ...SEAMS, timeoutMs: 3_000, watcher: { reidleMs: 150, backoffMinMs: 30 } });
    await until(() => fake.idling() === 1);
    fake.deliver('INBOX', eml('mail-alternative.eml'));
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], { count: 1, from: 'Anna Müller <anna@example.org>', subject: 'Grüße aus München and more' });
    await until(() => fake.log.filter((l) => l === 'IDLE').length >= 3);
    for (const s of [...fake.sockets]) s.destroy(); // the server drops everyone
    await until(() => fake.idling() === 1 && fake.log.filter((l) => l === 'EXAMINE INBOX').length >= 2);
    fake.deliver('INBOX', eml('mail-html-only.eml'));
    await until(() => seen.length === 2);
    assert.equal(seen[1].subject, 'Café – news');
    await conn.close();
    await until(() => fake.idling() === 0 && fake.sockets.size === 0); // B-059: an IDLE still in flight is counted first
    const idles = fake.log.filter((l) => l === 'IDLE').length;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(fake.log.filter((l) => l === 'IDLE').length, idles, 'nothing after close');
  } finally { await fake.stop(); }
});
