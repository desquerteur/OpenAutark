// B-053 track D: sending (runtime/apps/mail/smtp.ts and the send/reply tools) against the fake SMTP and IMAP servers
// over plain TCP: the submission dialogue (EHLO, AUTH PLAIN, MAIL, RCPT, DATA) with dot-stuffing, STARTTLS + AUTH
// LOGIN, a refused recipient among good ones, all refused, a refused login (ReconnectNeeded), a refused message
// (tool error, nothing claimed sent); send with Bcc (envelope only) and the Sent copy, Gmail (no copy), reply-all with
// threading headers and \Answered, and a Sent copy that fails without failing the sent message.
// Owns: checks of the SMTP half of runtime/apps/mail/*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { readFileSync } from 'node:fs';
import { connectMail } from '../../../src/runtime/apps/mail/index.ts';
import { dotStuff, sendMail, SmtpError } from '../../../src/runtime/apps/mail/smtp.ts';
import { parseMessage } from '../../../src/runtime/apps/mail/mime.ts';
import { ReconnectNeeded, type MailTarget, type McpCallResult } from '../../../src/runtime/apps/types.ts';
import { FakeImap } from '../../fixtures/apps/mail-fake-imap.ts';
import { FakeSmtp, type FakeSmtpOptions } from '../../fixtures/apps/mail-fake-smtp.ts';

const CLIENT = { clientInfo: { name: 'workforce', version: '0.2.0' } };
const tls = (o: { host: string; port: number; socket?: net.Socket }) => o.socket ?? net.connect({ host: o.host, port: o.port });
const plain = (o: { host: string; port: number }) => net.connect({ host: o.host, port: o.port });
const SOCKETS = { tls, net: plain };
const LOGIN = { user: 'me@example.com', password: 'app-pass' };
const raw = (text: string) => Buffer.from(text.replace(/\r?\n/g, '\r\n'));
const textOf = (r: McpCallResult) => (r.content[0] as { text: string }).text;

async function withSmtp(opts: FakeSmtpOptions, run: (fake: FakeSmtp) => Promise<void>): Promise<void> {
  const fake = await new FakeSmtp(opts).start();
  try { await run(fake); } finally { await fake.stop(); }
}

test('dot-stuffing: leading dots doubled, CRLF line ends, the closing dot line', () => {
  assert.equal(dotStuff(Buffer.from('.a\n..b\nc.\n.')).toString(), '..a\r\n...b\r\nc.\r\n..\r\n.\r\n');
});

test('submission: EHLO, AUTH PLAIN, MAIL, RCPT, DATA with dot-stuffing, QUIT; a refused recipient among good ones', async () => {
  await withSmtp({}, async (fake) => {
    const message = raw('Subject: hi\n\n.leading dot\nbody\n');
    const result = await sendMail({ server: { host: '127.0.0.1', port: fake.port, tls: 'implicit' }, login: LOGIN, from: 'me@example.com', to: ['a@x.org', 'reject@x.org', 'b@y.org'], raw: message, sockets: SOCKETS });
    assert.deepEqual(result, { accepted: ['a@x.org', 'b@y.org'], rejected: ['reject@x.org'] });
    assert.deepEqual(fake.dialogue.map((l) => l.replace(/\[[^\]]+\]/, '[ip]')), ['EHLO [ip]', 'AUTH PLAIN <hidden>', 'MAIL FROM:<me@example.com>', 'RCPT TO:<a@x.org>', 'RCPT TO:<reject@x.org>', 'RCPT TO:<b@y.org>', 'DATA', 'QUIT']);
    assert.equal(fake.mails[0].wire, 'Subject: hi\r\n\r\n..leading dot\r\nbody\r\n');
    assert.equal(fake.mails[0].message, 'Subject: hi\r\n\r\n.leading dot\r\nbody\r\n');
    assert.deepEqual(fake.mails[0].to, ['a@x.org', 'b@y.org']);
  });
});

test('STARTTLS then AUTH LOGIN; refusals: every recipient, the login, the message', async () => {
  await withSmtp({ starttls: true, auth: ['LOGIN'] }, async (fake) => {
    const wrapped: boolean[] = [];
    await sendMail({ server: { host: '127.0.0.1', port: fake.port, tls: 'starttls' }, login: LOGIN, from: 'me@example.com', to: ['a@x.org'], raw: raw('x'), sockets: { net: plain, tls: (o) => { wrapped.push(!!o.socket); return tls(o); } } });
    assert.deepEqual(wrapped, [true]);
    assert.deepEqual(fake.dialogue.slice(0, 6).map((l) => l.replace(/\[[^\]]+\]/, '[ip]')), ['EHLO [ip]', 'STARTTLS', 'EHLO [ip]', 'AUTH LOGIN <hidden>', '<user>', '<password>']);
    await assert.rejects(sendMail({ server: { host: '127.0.0.1', port: fake.port, tls: 'starttls' }, login: LOGIN, from: 'me@example.com', to: ['reject@x.org'], raw: raw('x'), sockets: SOCKETS }),
      (e: unknown) => e instanceof SmtpError && e.code === 550 && /refused the recipient reject@x\.org/.test(e.message) && !/no such user/.test(e.message));
    await assert.rejects(sendMail({ server: { host: '127.0.0.1', port: fake.port, tls: 'starttls' }, login: { ...LOGIN, password: 'nope' }, from: 'me@example.com', to: ['a@x.org'], raw: raw('x'), sockets: SOCKETS }),
      (e: unknown) => e instanceof ReconnectNeeded);
  });
  await withSmtp({ dataReply: '554 5.7.1 spam detected' }, async (fake) => {
    await assert.rejects(sendMail({ server: { host: '127.0.0.1', port: fake.port, tls: 'implicit' }, login: LOGIN, from: 'me@example.com', to: ['a@x.org'], raw: raw('x'), sockets: SOCKETS }),
      (e: unknown) => e instanceof SmtpError && e.code === 554 && /may look like spam/.test(e.message) && !/detected/.test(e.message));
  });
  await withSmtp({ starttls: false }, async (fake) => {
    await assert.rejects(sendMail({ server: { host: '127.0.0.1', port: fake.port, tls: 'starttls' }, login: LOGIN, from: 'me@example.com', to: ['a@x.org'], raw: raw('x'), sockets: SOCKETS }), /does not offer an encrypted connection/);
  });
});

async function mailbox(smtpHost = '127.0.0.1', smtpOpts: FakeSmtpOptions = {}) {
  const imap = await new FakeImap({}).start();
  const smtp = await new FakeSmtp(smtpOpts).start();
  const target: MailTarget = {
    kind: 'mail', address: 'me@example.com',
    imap: { host: '127.0.0.1', port: imap.port, tls: 'implicit' }, smtp: { host: smtpHost, port: smtp.port, tls: 'implicit' },
    login: async () => LOGIN,
  };
  // smtpHost may be a name (smtp.gmail.com) – the seam routes every TLS connect to the fake by port.
  const sockets = { tls: (o: { host: string; port: number; socket?: net.Socket }) => o.socket ?? net.connect({ host: '127.0.0.1', port: o.port }), net: plain };
  const conn = await connectMail(target, { ...CLIENT, ...sockets, timeoutMs: 3_000 });
  return { imap, smtp, conn, close: async () => { await conn.close(); await imap.stop(); await smtp.stop(); } };
}

test('send: To, Cc and Bcc delivered, Bcc only in the envelope, a copy in Sent; unknown address refused before sending', async () => {
  const m = await mailbox();
  try {
    const result = await m.conn.callTool('send', { to: ['Ann <ann@x.org>'], cc: 'cc@x.org', bcc: ['hidden@x.org'], subject: 'Grüße', text: 'Hallo\n.\nEnde' });
    assert.equal(textOf(result), 'Sent "Grüße" to Ann <ann@x.org>, cc cc@x.org, bcc hidden@x.org.');
    assert.deepEqual(m.smtp.mails[0].to, ['ann@x.org', 'cc@x.org', 'hidden@x.org']);
    const sent = parseMessage(Buffer.from(m.smtp.mails[0].message));
    assert.equal(sent.subject, 'Grüße');
    assert.equal(sent.text, 'Hallo\n.\nEnde\n');
    assert.ok(!/^bcc:/im.test(m.smtp.mails[0].message));
    const copy = m.imap.folders.get('Sent Items')!.messages;
    assert.equal(copy.length, 1);
    assert.deepEqual([...copy[0].flags], ['\\Seen']);
    const refused = await m.conn.callTool('send', { to: 'nobody', subject: 's', text: 't' });
    assert.equal(refused.isError, true);
    assert.equal(m.smtp.mails.length, 1);
    const allRefused = await m.conn.callTool('send', { to: 'reject@x.org', subject: 's', text: 't' });
    assert.equal(allRefused.isError, true);
    assert.match(textOf(allRefused), /^Not sent: /);
  } finally { await m.close(); }
});

test('reply-all: Re: subject, In-Reply-To / References, quoted original, \\Answered on the original; Gmail keeps no extra copy', async () => {
  const m = await mailbox('smtp.gmail.com');
  try {
    m.imap.add('INBOX', readFileSync(new URL('../../fixtures/apps/mail-alternative.eml', import.meta.url), 'utf8'));
    const result = await m.conn.callTool('reply', { id: 'INBOX/7000/1', text: 'Danke, Anna!', all: true });
    assert.equal(result.isError, undefined, textOf(result));
    const wire = m.smtp.mails[0].message;
    const reply = parseMessage(Buffer.from(wire));
    assert.equal(reply.subject, 'Re: Grüße aus München and more');
    assert.equal(reply.inReplyTo, '<abc.123@example.org>');
    assert.deepEqual(reply.references, ['<first@example.org>', '<second@example.org>', '<abc.123@example.org>']);
    assert.deepEqual(reply.to.map((a) => a.address), ['anna@example.org']);
    assert.deepEqual(reply.cc.map((a) => a.address), ['john@example.com', 'bob@example.net', 'joerg@example.de']);
    assert.match(reply.text, /^Danke, Anna!\n\nOn Tue, 27 Oct 2026 09:15:00 \+0100, Anna Müller wrote:\n> Hallo John,/);
    assert.ok(m.imap.folders.get('INBOX')!.messages[0].flags.has('\\Answered'));
    assert.equal(m.imap.folders.get('Sent Items')!.messages.length, 0, 'Gmail stores sent mail itself');
  } finally { await m.close(); }
});

test('once SMTP accepted the message, a failing Sent copy is a note, not an error', async () => {
  const m = await mailbox();
  try {
    m.imap.refuseAppend = true;
    const result = await m.conn.callTool('send', { to: 'ann@x.org', subject: 'S', text: 'T' });
    assert.equal(result.isError, undefined);
    assert.equal(m.smtp.mails.length, 1);
    assert.equal(textOf(result), 'Sent "S" to ann@x.org. Sent, but the copy in the Sent folder could not be saved.');
    assert.deepEqual((result.structuredContent as { notes: string[] }).notes, ['Sent, but the copy in the Sent folder could not be saved.']);
  } finally { await m.close(); }
});
