// B-059 (runtime/apps/mail/loops.ts and its users): mail never loops and is never lost. automaticMail (each rule, and
// a person's mail stays real); withMailRun (only a mailbox's call in a run a mail started) and "Auto-Submitted:
// auto-replied" on what it sends (never on a draft); search / read marking automatic mail; the IDLE watcher:
// automatic, bulk and already-read (\Seen) mail never wakes, mail that came while it was away (drop, restart) wakes
// exactly once, the first connect and a new UIDVALIDITY only set the mark; the mark kept by the service (no
// apps.changed, read back after a restart); apps/tools.ts passing the argument only in a run a mail started.
// Fake IMAP / SMTP over plain TCP (TLS seam).
// Owns: checks of B-059 mail loop and catch-up behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { connectMail, MAIL_TOOLS } from '../../../src/runtime/apps/mail/index.ts';
import { Apps } from '../../../src/runtime/apps/service.ts';
import { appsFixture } from './service-fakes.ts';
import { buildMessage } from '../../../src/runtime/apps/mail/mime-build.ts';
import { parseMessage } from '../../../src/runtime/apps/mail/mime.ts';
import { AUTO_REPLY_ARG, automaticMail, withMailRun } from '../../../src/runtime/apps/mail/loops.ts';
import { appToolDefs, appToolName } from '../../../src/runtime/apps/tools.ts';
import type { AppToolHost, Connector, MailMark, MailTarget, McpCallResult } from '../../../src/runtime/apps/types.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { FakeImap } from '../../fixtures/apps/mail-fake-imap.ts';
import { FakeSmtp } from '../../fixtures/apps/mail-fake-smtp.ts';

const CLIENT = { clientInfo: { name: 'workforce', version: '0.2.0' } };
const plain = (o: { host: string; port: number }) => net.connect({ host: '127.0.0.1', port: o.port });
const SEAMS = { tls: (o: { host: string; port: number; socket?: net.Socket }) => o.socket ?? plain(o), net: plain };
const LOGIN = { user: 'me@example.com', password: 'app-pass' };
const textOf = (r: McpCallResult) => (r.content[0] as { text: string }).text;
const h = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, [v]]));
let seq = 0;
const mail = (from: string, subject: string, extra = '') =>
  `From: ${from}\nTo: me@example.com\nSubject: ${subject}\nDate: Thu, 29 Oct 2026 07:00:00 +0000\nMessage-ID: <m${++seq}@x.example>\n${extra}MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nHello there\n`;
const PERSON = () => mail('Maria Lopez <maria@client.example>', 'Offer please');
const NEWSLETTER = () => mail('Shop <news@shop.example>', 'Weekly deals', 'List-Unsubscribe: <mailto:unsub@shop.example>\n');
const OOO = () => mail('Bob <bob@client.example>', 'Out of office', 'Auto-Submitted: auto-replied\n');

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > ms) throw new Error('condition not reached'); await new Promise((r) => setTimeout(r, 10)); }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('automaticMail: auto-replies, bulk, lists, bounces and no-reply senders; a person\'s mail stays real', () => {
  assert.equal(automaticMail(h({ 'auto-submitted': 'auto-replied' }), 'bob@x.example'), 'auto-reply');
  assert.equal(automaticMail(h({ 'auto-submitted': 'auto-generated; owner-email="a@b"' }), 'bob@x.example'), 'auto-reply');
  assert.equal(automaticMail(h({ 'auto-submitted': 'No' }), 'bob@x.example'), undefined, 'Auto-Submitted: no is a person');
  assert.equal(automaticMail(h({ 'x-autoreply': 'yes' }), 'bob@x.example'), 'auto-reply');
  assert.equal(automaticMail(h({ 'x-autorespond': 'x' }), 'bob@x.example'), 'auto-reply');
  for (const p of ['bulk', 'List', 'junk']) assert.equal(automaticMail(h({ precedence: p }), 'bob@x.example'), 'bulk mail', p);
  assert.equal(automaticMail(h({ precedence: 'first-class' }), 'bob@x.example'), undefined);
  assert.equal(automaticMail(h({ 'list-id': '<team.lists.example>' }), 'bob@x.example'), 'newsletter or mailing list');
  assert.equal(automaticMail(h({ 'list-unsubscribe': '<mailto:u@x>' }), 'bob@x.example'), 'newsletter or mailing list');
  assert.equal(automaticMail(h({ 'return-path': '< >' }), 'bob@x.example'), 'delivery report');
  assert.equal(automaticMail(h({ 'return-path': '<bob@x.example>' }), 'bob@x.example'), undefined);
  for (const from of ['MAILER-DAEMON@mx.example', 'postmaster@x.example', 'no-reply@x.example', 'noreply@x.example', 'do-not-reply@x.example', 'donotreply@x.example', 'noreply+abc@x.example', 'no-reply.billing@x.example']) {
    assert.equal(automaticMail(new Map(), from), 'no-reply sender', from);
  }
  for (const from of ['noreplyx@x.example', 'reply@x.example', 'maria@client.example', undefined]) assert.equal(automaticMail(new Map(), from), undefined, String(from));
});

test('withMailRun: only a mailbox call in a run a mail started gets the auto-reply argument', () => {
  const records: Record<string, { transport: string }> = { box: { transport: 'mail' }, notion: { transport: 'http' } };
  const lookup = (id: string) => records[id];
  const args = { id: 'INBOX/1/2', text: 'Thanks' };
  assert.deepEqual(withMailRun({ transport: 'mail' }, args, { source: 'app:box' }, lookup), { ...args, [AUTO_REPLY_ARG]: true });
  assert.equal(withMailRun({ transport: 'mail' }, args, { source: 'app:notion' }, lookup), args, 'a run another app started');
  assert.equal(withMailRun({ transport: 'mail' }, args, { source: 'schedule:s1' }, lookup), args, 'a routine');
  assert.equal(withMailRun({ transport: 'mail' }, args, undefined, lookup), args, 'a chat run');
  assert.equal(withMailRun({ transport: 'http' }, args, { source: 'app:box' }, lookup), args, 'another app\'s call');
  const built = (autoReplied?: boolean) => parseMessage(buildMessage({ from: { address: 'me@example.com' }, to: [{ address: 'a@x.example' }], subject: 's', text: 't', ...(autoReplied ? { autoReplied } : {}) }).raw).headers.get('auto-submitted');
  assert.deepEqual(built(true), ['auto-replied']);
  assert.equal(built(), undefined);
});

test('apps/tools.ts: a mailbox call in a run its mail started reaches the connection with the argument; other runs do not', async () => {
  const box: Connector = { id: 'box', name: 'box', transport: 'mail', enabled: true, fingerprint: 'f', mail: { address: 'me@example.com', password: 'secret://pw' } };
  const calls: Array<Record<string, unknown>> = [];
  const host: AppToolHost = { state: (id) => (id === box.id ? { connector: box, status: 'ok' } : undefined), call: async (_id, _tool, args) => { calls.push(args); return { content: [{ type: 'text', text: 'Sent.' }] }; } };
  const send = appToolDefs(box, MAIL_TOOLS, host).find((def) => def.name === appToolName('box', 'send'))!;
  const ctx = (origin?: { source: string; label: string }): ToolContext =>
    ({ agent: { id: 'ag_sec', name: 'Sec' }, runId: 'run_1', mode: 'full', services: {}, signal: new AbortController().signal, status() {}, ...(origin ? { origin } : {}) }) as unknown as ToolContext;
  const args = { to: 'maria@client.example', subject: 'Re: Offer', text: 'Here it is.' };
  await send.run(args, ctx({ source: 'app:box', label: 'New mail in me@example.com' }));
  await send.run(args, ctx({ source: 'schedule:s1', label: 'Morning' }));
  await send.run(args, ctx());
  assert.deepEqual(calls, [{ ...args, [AUTO_REPLY_ARG]: true }, args, args]);
});

async function mailbox(extra: Partial<MailTarget> = {}) {
  const imap = await new FakeImap({}).start();
  const smtp = await new FakeSmtp({}).start();
  const target: MailTarget = {
    kind: 'mail', address: 'me@example.com', imap: { host: '127.0.0.1', port: imap.port, tls: 'implicit' }, smtp: { host: '127.0.0.1', port: smtp.port, tls: 'implicit' },
    login: async () => LOGIN, ...extra,
  };
  const conn = await connectMail(target, { ...CLIENT, ...SEAMS, timeoutMs: 3_000, watcher: { reidleMs: 5_000, backoffMinMs: 30 } });
  return { imap, smtp, conn, close: async () => { await conn.close(); await imap.stop(); await smtp.stop(); } };
}

test('sending: a run a mail started sends with Auto-Submitted (reply and send, not a draft)', async () => {
  const m = await mailbox();
  const auto = { [AUTO_REPLY_ARG]: true };
  try {
    m.imap.add('INBOX', PERSON());
    const reply = await m.conn.callTool('reply', { id: 'INBOX/7000/1', text: 'Here it is.', ...auto });
    assert.equal(reply.isError, undefined, textOf(reply));
    assert.deepEqual(parseMessage(Buffer.from(m.smtp.mails[0].message)).headers.get('auto-submitted'), ['auto-replied']);
    await m.conn.callTool('send', { to: 'maria@client.example', subject: 'Plain', text: 'x' });
    assert.equal(parseMessage(Buffer.from(m.smtp.mails[1].message)).headers.get('auto-submitted'), undefined, 'a call without it');
    await m.conn.callTool('draft', { to: 'maria@client.example', subject: 'Draft', text: 'x', ...auto });
    const draft = m.imap.folders.get('Drafts')!.messages[0];
    assert.equal(parseMessage(draft.raw).headers.get('auto-submitted'), undefined, 'a draft is the person\'s to send');
    for (let i = 0; i < 6; i++) assert.equal((await m.conn.callTool('send', { to: 'Maria@client.example', subject: `n${i}`, text: 'x', ...auto })).isError, undefined);
    assert.equal(m.smtp.mails.length, 8, 'nothing is capped');
  } finally { await m.close(); }
});

test('search and read say when a message was sent automatically', async () => {
  const m = await mailbox();
  try {
    m.imap.add('INBOX', NEWSLETTER());
    m.imap.add('INBOX', PERSON());
    const found = await m.conn.callTool('search', {});
    const lines = textOf(found).split('\n');
    assert.match(lines.find((l) => l.includes('Weekly deals')) ?? '', / · automatic \(newsletter or mailing list\)$/);
    assert.doesNotMatch(lines.find((l) => l.includes('Offer please')) ?? '', /automatic/);
    const messages = (found.structuredContent as { messages: Array<{ subject: string; automatic?: string }> }).messages;
    assert.equal(messages.find((s) => s.subject === 'Weekly deals')?.automatic, 'newsletter or mailing list');
    const read = await m.conn.callTool('read', { id: 'INBOX/7000/1' });
    assert.match(textOf(read), /^Sent automatically \(newsletter or mailing list\) – it needs no reply\.$/m);
    assert.doesNotMatch(textOf(await m.conn.callTool('read', { id: 'INBOX/7000/2' })), /Sent automatically/);
  } finally { await m.close(); }
});

test('IDLE: automatic and bulk mail never wakes; real mail wakes with its own sender, not the newsletter\'s', async () => {
  const seen: Array<{ count: number; from?: string; subject?: string }> = [];
  const m = await mailbox({ onNewMail: (info) => seen.push(info) });
  try {
    await until(() => m.imap.idling() === 1);
    m.imap.deliver('INBOX', NEWSLETTER());
    m.imap.deliver('INBOX', OOO());
    m.imap.deliver('INBOX', mail('Mail Delivery <MAILER-DAEMON@mx.example>', 'Undelivered', 'Return-Path: <>\n'));
    await until(() => m.imap.log.filter((l) => l.startsWith('UID FETCH')).length >= 1 && m.imap.idling() === 1);
    await pause(150);
    assert.deepEqual(seen, [], 'no wake for automatic mail');
    m.imap.deliver('INBOX', PERSON());
    m.imap.deliver('INBOX', NEWSLETTER());
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], { count: 1, from: 'Maria Lopez <maria@client.example>', subject: 'Offer please' });
    assert.ok(m.imap.folders.get('INBOX')!.messages.every((x) => !x.flags.has('\\Seen')), 'automatic mail stays unread in the mailbox');
  } finally { await m.close(); }
});

test('IDLE: mail that came while the connection was down wakes exactly once on reconnect; nothing new, no wake', async () => {
  const seen: Array<{ count: number; from?: string }> = [];
  const m = await mailbox({ onNewMail: (info) => seen.push(info) });
  try {
    await until(() => m.imap.idling() === 1);
    for (const s of [...m.imap.sockets]) s.destroy(); // the PC sleeps / the Wi-Fi drops
    m.imap.add('INBOX', PERSON());
    m.imap.add('INBOX', NEWSLETTER());
    m.imap.add('INBOX', mail('Tom <tom@client.example>', 'Question'));
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], { count: 2, from: 'Tom <tom@client.example>', subject: 'Question' });
    const examined = m.imap.log.filter((l) => l === 'EXAMINE INBOX').length;
    for (const s of [...m.imap.sockets]) s.destroy();
    await until(() => m.imap.log.filter((l) => l === 'EXAMINE INBOX').length > examined && m.imap.idling() === 1);
    await pause(150);
    assert.equal(seen.length, 1, 'already reported: no second wake');
    m.imap.deliver('INBOX', PERSON());
    await until(() => seen.length === 2);
    assert.equal(seen[1].count, 1);
  } finally { await m.close(); }
});

test('IDLE: mail read elsewhere while the PC slept (\\Seen) does not wake; the mark still moves past it', async () => {
  let stored: MailMark | undefined;
  const seen: Array<{ count: number; from?: string; subject?: string }> = [];
  const m = await mailbox({ onNewMail: (info) => seen.push(info), mark: { get: () => stored, set: (x: MailMark) => { stored = x; } } });
  const examined = () => m.imap.log.filter((l) => l === 'EXAMINE INBOX').length;
  try {
    await until(() => m.imap.idling() === 1);
    assert.deepEqual(stored, { validity: 7000, next: 1 });
    for (const s of [...m.imap.sockets]) s.destroy(); // the lid closes for the night
    m.imap.add('INBOX', mail('Tom <tom@client.example>', 'Question'));
    m.imap.add('INBOX', mail('Ann <ann@client.example>', 'Invoice'));
    m.imap.add('INBOX', PERSON(), ['\\Seen']); // read on the phone at 06:50
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], { count: 2, from: 'Ann <ann@client.example>', subject: 'Invoice' }, 'only the unread ones; the newest unread names the sender');
    assert.deepEqual(stored, { validity: 7000, next: 4 });
    const before = examined();
    for (const s of [...m.imap.sockets]) s.destroy();
    m.imap.add('INBOX', PERSON(), ['\\Seen']);
    m.imap.add('INBOX', mail('Tom <tom@client.example>', 'Thanks'), ['\\Seen', '\\Answered']);
    await until(() => examined() > before && m.imap.idling() === 1 && stored?.next === 6);
    await pause(150);
    assert.equal(seen.length, 1, 'everything was read elsewhere: no wake');
    assert.deepEqual(stored, { validity: 7000, next: 6 }, 'the mark moved past them – they are not looked at again');
  } finally { await m.close(); }
});

test('IDLE: a failed header read still wakes (fail open) and moves the mark – that mail is not reported again', async () => {
  const seen: Array<{ count: number; from?: string; subject?: string }> = [];
  const m = await mailbox({ onNewMail: (info) => seen.push(info) });
  try {
    await until(() => m.imap.idling() === 1);
    m.imap.refuseHeaderFetch = true;
    m.imap.deliver('INBOX', NEWSLETTER());
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], { count: 1 }, 'woken without details rather than a lost mail');
    m.imap.refuseHeaderFetch = false;
    const examined = m.imap.log.filter((l) => l === 'EXAMINE INBOX').length;
    for (const s of [...m.imap.sockets]) s.destroy();
    await until(() => m.imap.log.filter((l) => l === 'EXAMINE INBOX').length > examined && m.imap.idling() === 1);
    await pause(150);
    assert.equal(seen.length, 1);
  } finally { await m.close(); }
});

test('the mark is kept by the service: written without an apps.changed event, never shown, read back after a restart', async () => {
  const f = appsFixture({ onNewMail: () => undefined }); // a mailbox is held open only with a wake listener
  f.servers.add('me@example.test', MAIL_TOOLS);
  f.data.write('mail.json', { mailboxes: { box: { address: 'me@example.test', password: 'app-pass-1', imap: { host: 'imap.example.test', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.example.test', port: 465, tls: 'implicit' } } } });
  f.apps.start();
  await f.apps.idle();
  const target = f.servers.opened.at(-1) as MailTarget;
  assert.equal(target.mark?.get(), undefined, 'no mark before the first connect of the watcher');
  const changed = f.changed().length;
  target.mark?.set({ validity: 7, next: 42 });
  assert.deepEqual(target.mark?.get(), { validity: 7, next: 42 });
  assert.equal(f.changed().length, changed, 'no apps.changed per mail');
  assert.ok(!JSON.stringify(f.apps.list()).includes('"mark"'), 'the list does not carry it');
  await f.apps.stop();
  const again = new Apps(f.deps);
  again.start();
  await again.idle();
  const reopened = f.servers.opened.at(-1) as MailTarget;
  assert.notEqual(reopened, target);
  assert.deepEqual(reopened.mark?.get(), { validity: 7, next: 42 }, 'mail that came during the restart is found from it');
  assert.equal(again.list().find((app) => app.id === 'box')?.status, 'ok');
  await again.stop();
});

test('IDLE: the mark survives a restart (target.mark); old mail and a new UIDVALIDITY only set it', async () => {
  let stored: MailMark | undefined;
  const mark = { get: () => stored, set: (m: MailMark) => { stored = m; } };
  const seen: number[] = [];
  const imap = await new FakeImap({}).start();
  const open = () => connectMail({
    kind: 'mail', address: 'me@example.com', imap: { host: '127.0.0.1', port: imap.port, tls: 'implicit' }, smtp: { host: '127.0.0.1', port: 1, tls: 'implicit' },
    login: async () => LOGIN, onNewMail: (info) => seen.push(info.count), mark,
  }, { ...CLIENT, ...SEAMS, timeoutMs: 3_000, watcher: { reidleMs: 5_000, backoffMinMs: 30 } });
  try {
    imap.add('INBOX', PERSON()); // old unread mail before the first connect
    let conn = await open();
    await until(() => imap.idling() === 1);
    assert.deepEqual(stored, { validity: 7000, next: 2 }, 'the first connect only sets the mark');
    await conn.close();
    await until(() => imap.idling() === 0);
    imap.add('INBOX', PERSON()); // the app is closed (restart, update)
    imap.add('INBOX', OOO());
    imap.add('INBOX', PERSON());
    conn = await open();
    await until(() => seen.length === 1);
    assert.deepEqual(seen, [2]);
    assert.deepEqual(stored, { validity: 7000, next: 5 });
    await conn.close();
    await until(() => imap.idling() === 0);
    conn = await open();
    await until(() => imap.idling() === 1);
    await pause(150);
    assert.deepEqual(seen, [2], 'nothing new: no wake');
    await conn.close();
    await until(() => imap.idling() === 0);
    imap.folders.get('INBOX')!.uidValidity = 9100; // the server renumbered the mailbox
    imap.add('INBOX', PERSON());
    conn = await open();
    await until(() => imap.idling() === 1);
    await pause(150);
    assert.deepEqual(seen, [2], 'a new UIDVALIDITY only sets the mark');
    assert.deepEqual(stored, { validity: 9100, next: 6 });
    await conn.close();
  } finally { await imap.stop(); }
});
