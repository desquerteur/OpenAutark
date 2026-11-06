// B-053 track D: finding mail servers (runtime/apps/mail/autoconfig.ts) with a fake fetch and a fake MX resolver –
// presets (Gmail, iCloud STARTTLS, GMX, Proton Bridge on loopback), Outlook.com / Microsoft 365 reported honestly,
// ISPDB XML (the first encrypted password server; plain and OAuth2-only entries skipped; %EMAILLOCALPART%; the
// domain placeholder), the domain's own autoconfig file, Google Workspace and Microsoft 365 by MX, an MX provider's
// ISPDB entry, nothing found, not an address; only the domain is ever sent.
// Owns: checks of autoconfig.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailAutoconfig, parseAutoconfigXml, MICROSOFT_UNSUPPORTED } from '../../../src/runtime/apps/mail/index.ts';
import { baseDomain } from '../../../src/runtime/apps/mail/autoconfig.ts';

const ISPDB = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.net">
    <domain>example.net</domain>
    <incomingServer type="pop3"><hostname>pop.example.net</hostname><port>995</port><socketType>SSL</socketType><authentication>password-cleartext</authentication></incomingServer>
    <incomingServer type="imap"><hostname>plain.example.net</hostname><port>143</port><socketType>plain</socketType><authentication>password-cleartext</authentication></incomingServer>
    <incomingServer type="imap"><hostname>oauth.example.net</hostname><port>993</port><socketType>SSL</socketType><authentication>OAuth2</authentication></incomingServer>
    <incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username><authentication>OAuth2</authentication><authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.net</hostname><port>587</port><socketType>STARTTLS</socketType><authentication>password-encrypted</authentication></outgoingServer>
  </emailProvider>
</clientConfig>`;

function fakeFetch(pages: Record<string, string>, seen: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = pages[url];
    return new Response(body ?? 'not found', { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
}
const noMx = async () => { throw Object.assign(new Error('none'), { code: 'ENODATA' }); };

test('presets: Gmail with the app-password note, iCloud STARTTLS, GMX, Proton Bridge on loopback – no network', async () => {
  const seen: string[] = [];
  const f = fakeFetch({}, seen);
  const gmail = await mailAutoconfig('Someone@GoogleMail.com', f, noMx);
  assert.ok(!('unsupported' in gmail));
  if ('unsupported' in gmail) return;
  assert.deepEqual([gmail.imap, gmail.smtp], [{ host: 'imap.gmail.com', port: 993, tls: 'implicit' }, { host: 'smtp.gmail.com', port: 465, tls: 'implicit' }]);
  assert.match(gmail.note ?? '', /app password.*2-Step Verification/);
  const icloud = await mailAutoconfig('a@me.com', f, noMx);
  assert.deepEqual('smtp' in icloud && icloud.smtp, { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' });
  const gmx = await mailAutoconfig('a@gmx.at', f, noMx);
  assert.deepEqual('imap' in gmx && [gmx.imap, gmx.smtp], [{ host: 'imap.gmx.net', port: 993, tls: 'implicit' }, { host: 'mail.gmx.net', port: 587, tls: 'starttls' }]);
  const proton = await mailAutoconfig('a@proton.me', f, noMx);
  assert.deepEqual('imap' in proton && [proton.imap, proton.smtp], [{ host: '127.0.0.1', port: 1143, tls: 'starttls' }, { host: '127.0.0.1', port: 1025, tls: 'starttls' }]);
  assert.deepEqual(seen, []);
});

test('Outlook.com and Microsoft 365 are reported as not yet possible (by domain and by MX)', async () => {
  for (const address of ['a@outlook.com', 'b@hotmail.de', 'c@live.com', 'd@msn.com', 'e@hotmail.co.uk']) {
    assert.deepEqual(await mailAutoconfig(address, fakeFetch({}, []), noMx), { unsupported: MICROSOFT_UNSUPPORTED });
  }
  const m365 = await mailAutoconfig('ceo@contoso.example', fakeFetch({}, []), async () => [{ exchange: 'contoso-example.mail.protection.outlook.com', priority: 0 }]);
  assert.deepEqual(m365, { unsupported: MICROSOFT_UNSUPPORTED });
});

test('ISPDB XML: first encrypted password server, plain / OAuth2-only skipped, placeholders, local-part login', () => {
  assert.deepEqual(parseAutoconfigXml(ISPDB, 'jane@example.net'), {
    imap: { host: 'imap.example.net', port: 993, tls: 'implicit' },
    smtp: { host: 'smtp.example.net', port: 587, tls: 'starttls' },
    user: 'jane',
  });
  assert.equal(parseAutoconfigXml('<clientConfig><incomingServer type="imap"><hostname>x.y</hostname><port>143</port><socketType>plain</socketType></incomingServer></clientConfig>', 'a@y.z'), undefined);
  assert.equal(parseAutoconfigXml('<incomingServer type="imap"><hostname>bad host!</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>s.y</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>', 'a@y.z'), undefined);
});

test('lookup order: ISPDB, then the domain\'s own file; MX for Google Workspace and for a hosting provider; nothing found', async () => {
  const seen: string[] = [];
  const viaIspdb = await mailAutoconfig('jane@example.net', fakeFetch({ 'https://autoconfig.thunderbird.net/v1.1/example.net': ISPDB }, seen), noMx);
  assert.equal('imap' in viaIspdb && viaIspdb.imap.host, 'imap.example.net');
  assert.ok(seen.every((u) => !u.includes('jane')), 'the address itself is never sent');

  const own = ISPDB.replace(/example\.net/g, 'own.example');
  const viaOwn = await mailAutoconfig('a@own.example', fakeFetch({ 'https://autoconfig.own.example/mail/config-v1.1.xml': own }, []), noMx);
  assert.equal('imap' in viaOwn && viaOwn.imap.host, 'imap.own.example');

  const workspace = await mailAutoconfig('team@startup.example', fakeFetch({}, []), async () => [{ exchange: 'alt1.aspmx.l.google.com', priority: 5 }, { exchange: 'aspmx.l.google.com.', priority: 1 }]);
  assert.equal('imap' in workspace && workspace.imap.host, 'imap.gmail.com');
  assert.match('note' in workspace ? workspace.note ?? '' : '', /Google Workspace/);

  const hosted = ISPDB.replace('imap.%EMAILDOMAIN%', 'imap.host.example').replace(/example\.net/g, 'host.example');
  const byMx = await mailAutoconfig('me@shop.example', fakeFetch({ 'https://autoconfig.thunderbird.net/v1.1/host.example': hosted }, []), async () => [{ exchange: 'mx01.mail.host.example', priority: 10 }]);
  assert.equal('imap' in byMx && byMx.imap.host, 'imap.host.example');

  const nothing = await mailAutoconfig('me@nowhere.example', fakeFetch({}, []), noMx);
  assert.deepEqual(nothing, { unsupported: 'No mail server settings were found for nowhere.example – enter the IMAP and SMTP servers yourself.' });
  assert.deepEqual(await mailAutoconfig('not an address', fakeFetch({}, []), noMx), { unsupported: 'That is not an email address.' });
  assert.equal(baseDomain('mx.example.co.uk'), 'example.co.uk');
  assert.equal(baseDomain('mx-ha03.web.de'), 'web.de', 'a short provider label under a country code is no public suffix');
  const atGmx = await mailAutoconfig('me@shop.example', fakeFetch({}, []), async () => [{ exchange: 'mx00.gmx.net', priority: 10 }]);
  assert.equal('imap' in atGmx && atGmx.imap.host, 'imap.gmx.net', 'a custom domain hosted at GMX finds the preset through its MX');
});
