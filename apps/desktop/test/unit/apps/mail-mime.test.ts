// B-053 track D: reading and writing mail (runtime/apps/mail/mime*.ts) against fixtures – multipart/alternative with
// quoted-printable and soft breaks, encoded words split across lines and charsets, base64 UTF-8 in nested multipart,
// attachments listed with RFC 2231 names (never their bytes), HTML-only Windows-1252 mail as plain text (no script,
// links kept, entities decoded), a truncated message, address lists; building (encoded subject and names, QP with
// long lines and trailing spaces, Bcc never in headers, folded References) and reply fields.
// Owns: checks of mime.ts, mime-text.ts and mime-build.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMessage, snippet } from '../../../src/runtime/apps/mail/mime.ts';
import { decodeQuotedPrintable, decodeWords, headerParams, htmlToText, parseAddressList } from '../../../src/runtime/apps/mail/mime-text.ts';
import { buildMessage, encodeQuotedPrintable, encodeWords, formatMailbox, quoteOriginal, replyRecipients, replySubject, replyThreading } from '../../../src/runtime/apps/mail/mime-build.ts';

const fixture = (name: string, crlf = true): Buffer => {
  const text = readFileSync(new URL(`../../fixtures/apps/${name}`, import.meta.url), 'latin1').replace(/\r\n/g, '\n');
  return Buffer.from(crlf ? text.replace(/\n/g, '\r\n') : text, 'latin1');
};

test('multipart/alternative: text/plain preferred, QP soft breaks joined, encoded words across lines and charsets', () => {
  for (const crlf of [true, false]) {
    const mail = parseMessage(fixture('mail-alternative.eml', crlf));
    assert.equal(mail.subject, 'Grüße aus München and more');
    assert.deepEqual(mail.from, [{ name: 'Anna Müller', address: 'anna@example.org' }]);
    assert.deepEqual(mail.to, [{ name: 'Doe, John', address: 'john@example.com' }, { address: 'bob@example.net' }]);
    assert.deepEqual(mail.cc, [{ name: 'Jörg', address: 'joerg@example.de' }]);
    assert.equal(mail.messageId, '<abc.123@example.org>');
    assert.equal(mail.inReplyTo, '<second@example.org>');
    assert.deepEqual(mail.references, ['<first@example.org>', '<second@example.org>']);
    assert.equal(mail.fromHtml, false);
    assert.match(mail.text, /^Hallo John,\n\ndie Straße ist gesperrt\. Dieser Satz ist sehr lang und wird deshalb mit einem weichen Umbruch fortgesetzt\.\nGrüße\nAnna/);
    assert.deepEqual(mail.attachments, []);
  }
});

test('nested multipart/mixed: base64 UTF-8 text, attachments listed by name, type and size – content never returned', () => {
  const mail = parseMessage(fixture('mail-attachment.eml'));
  assert.equal(mail.text.trim(), 'Hier ist Ihre Rechnung über 12 €.');
  assert.deepEqual(mail.attachments, [
    { name: 'invoice.pdf', type: 'application/pdf', size: 52 },
    { name: 'Rechnungsübersicht.txt', type: 'text/plain', size: 5 },
  ]);
  assert.ok(!JSON.stringify(mail).includes('JVBERi0'), 'no attachment bytes in the parse');
});

test('HTML-only Windows-1252 mail becomes plain text: no head, style or script; links and entities kept readable', () => {
  const mail = parseMessage(fixture('mail-html-only.eml'));
  assert.equal(mail.subject, 'Café – news');
  assert.deepEqual(mail.from, [{ name: 'News, Weekly', address: 'news@letter.example' }]);
  assert.equal(mail.fromHtml, true);
  assert.equal(mail.text, 'Café & more\n\nRead the article (https://letter.example/a) today.\n\n- One\n- Two € ☺');
  assert.ok(!/alert|color:red|<|title/.test(mail.text));
});

test('a truncated message (size-limited fetch) parses as far as it goes', () => {
  const full = fixture('mail-alternative.eml');
  const cut = full.subarray(0, full.indexOf('Anna\r\n--b1') - 10);
  const mail = parseMessage(cut);
  assert.equal(mail.subject, 'Grüße aus München and more');
  assert.match(mail.text, /die Straße ist gesperrt/);
  assert.equal(snippet('> quoted\nHello   there\n\nfriend', 12), 'Hello there…');
});

test('text helpers: QP, encoded words (Q underscores, B split mid-character), RFC 2231 continuations, address lists', () => {
  assert.equal(decodeQuotedPrintable('a=3Db  \r\nc=\r\nd').toString(), 'a=b\r\ncd');
  assert.equal(decodeWords('=?utf-8?q?hello_w=C3=B6rld?= plain'), 'hello wörld plain');
  const euro = Buffer.from('€', 'utf8');
  const split = `=?UTF-8?B?${euro.subarray(0, 2).toString('base64')}?= =?UTF-8?B?${euro.subarray(2).toString('base64')}?=`;
  assert.equal(decodeWords(split), '€');
  assert.equal(decodeWords('no words here'), 'no words here');
  const params = headerParams("attachment; filename*0*=UTF-8''Gr%C3%BC; filename*1=sse.txt; size=3");
  assert.deepEqual(params, { value: 'attachment', params: { filename: 'Grüsse.txt', size: '3' } });
  assert.deepEqual(parseAddressList('a@x.org (Alice), "B \\"Q\\" C" <b@y.org>, team: c@z.org, d@z.org;, =?UTF-8?Q?J=C3=B6?= <j@q.de>'), [
    { name: 'Alice', address: 'a@x.org' }, { name: 'B "Q" C', address: 'b@y.org' }, { address: 'c@z.org' }, { address: 'd@z.org' }, { name: 'Jö', address: 'j@q.de' },
  ]);
  assert.equal(htmlToText('<div>a</div><div>b<br>c</div><table><tr><td>x</td><td>y</td></tr></table>'), 'a\n\nb\nc\n\nx y');
});

test('build: encoded subject and names, QP body (long lines, trailing space, "=", umlauts), no Bcc header, parses back', () => {
  const { raw, messageId } = buildMessage({
    from: { name: 'Agent Ünal', address: 'me@example.com' },
    to: [{ name: 'Doe, John', address: 'john@example.com' }, { address: 'bob@example.net' }],
    cc: [{ name: 'Plain Name', address: 'c@example.org' }],
    subject: 'Grüße zum Fest – ein ziemlich langer Betreff, der mehrere encoded words braucht',
    text: `Hallo John, \nLine with = sign.\n${'x'.repeat(200)}\n.dot line\nÄÖÜ ß`,
    inReplyTo: '<a@b>', references: Array.from({ length: 6 }, (_, i) => `<ref-${i}-${'r'.repeat(20)}@example.org>`),
    date: new Date('2026-10-29T10:00:00Z'),
  });
  const wire = raw.toString('latin1');
  assert.match(messageId, /^<[a-z0-9]+\.[0-9a-f]{18}@example\.com>$/);
  assert.ok(wire.split('\r\n').every((line) => line.length <= 998));
  assert.ok(!/[\x80-\xff]/.test(wire), 'all 7-bit on the wire');
  assert.ok(wire.split('\r\n\r\n')[1].split('\r\n').every((line) => line.length <= 76), 'QP lines ≤ 76');
  assert.match(wire, /^From: =\?UTF-8\?B\?[^?]+\?= <me@example\.com>\r\n/);
  assert.match(wire, /\r\nTo: "Doe, John" <john@example\.com>, bob@example\.net\r\n/);
  assert.match(wire, /\r\nDate: Thu, 29 Oct 2026 10:00:00 \+0000\r\n/);
  assert.match(wire, /\r\nReferences: <ref-0-r+@example\.org>\r\n <ref-1/);
  assert.match(wire, /Hallo John,=20\r\nLine with =3D sign\./);
  assert.ok(!/^Bcc:/im.test(wire));
  const back = parseMessage(raw);
  assert.equal(back.subject, 'Grüße zum Fest – ein ziemlich langer Betreff, der mehrere encoded words braucht');
  assert.deepEqual(back.from, [{ name: 'Agent Ünal', address: 'me@example.com' }]);
  assert.equal(back.text, `Hallo John, \nLine with = sign.\n${'x'.repeat(200)}\n.dot line\nÄÖÜ ß\n`);
  assert.equal(back.references.length, 6);
  assert.equal(back.inReplyTo, '<a@b>');
  assert.equal(encodeWords('plain ascii'), 'plain ascii');
  assert.equal(formatMailbox({ name: 'Evil\r\nBcc: x@y', address: 'a@b.c' }), '"Evil Bcc: x@y" <a@b.c>');
  assert.equal(encodeQuotedPrintable('tab\t'), 'tab=09');
});

test('html alternative builds as multipart/alternative and the plain part wins on reading', () => {
  const { raw } = buildMessage({ from: { address: 'me@example.com' }, to: [{ address: 'a@b.cd' }], subject: 'Hi', text: 'plain', html: '<b>bold</b>' });
  assert.match(raw.toString(), /Content-Type: multipart\/alternative; boundary="=_wf_[0-9a-f]+"/);
  const back = parseMessage(raw);
  assert.equal(back.text.trim(), 'plain');
});

test('reply: Re: once, Reply-To first, reply-all without the own address, threading ids, quoted original', () => {
  const original = parseMessage(fixture('mail-alternative.eml'));
  assert.equal(replySubject(original.subject), 'Re: Grüße aus München and more');
  assert.equal(replySubject('AW: Hallo'), 'AW: Hallo');
  assert.deepEqual(replyRecipients(original, 'john@example.com', false), { to: [{ name: 'Anna Müller', address: 'anna@example.org' }], cc: [] });
  assert.deepEqual(replyRecipients(original, 'JOHN@example.com', true).cc.map((a) => a.address), ['bob@example.net', 'joerg@example.de']);
  const withReplyTo = parseMessage(Buffer.from('From: a@x.org\r\nReply-To: list@x.org\r\nTo: me@example.com\r\nSubject: s\r\n\r\nbody'));
  assert.deepEqual(replyRecipients(withReplyTo, 'me@example.com', false).to, [{ address: 'list@x.org' }]);
  assert.deepEqual(replyThreading(original), { inReplyTo: '<abc.123@example.org>', references: ['<first@example.org>', '<second@example.org>', '<abc.123@example.org>'] });
  const quoted = quoteOriginal('Danke!', original);
  assert.match(quoted, /^Danke!\n\nOn Tue, 27 Oct 2026 09:15:00 \+0100, Anna Müller wrote:\n> Hallo John,\n>\n> die Straße/);
});
