// TOTP core (X05, secrets/totp.ts): the RFC 4226 HOTP and RFC 6238 TOTP test vectors, base32,
// parsing otpauth links and bare keys (refusals are bad_request with a fixed text that never
// quotes the input), the stored form, the redactor's spellings and the setup keys of a page text
// (never ordinary prose next to "QR code" or a 2FA word; keys grouped with no-break, thin or double
// spaces count).
// Owns: these assertions only. Never: a real key or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import {
  base32Decode, base32Encode, findSetupKeys, has2faContext, hotp, looksLikeSetupKey, parseTotp, readTotp, seedPattern, seedVariants, serializeTotp,
  toOtpauth, totpCode,
} from '../../../src/runtime/secrets/totp.ts';

const RFC_KEY = Buffer.from('12345678901234567890');

test('RFC 4226: the HOTP vectors for counters 0–9', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  assert.deepEqual(expected.map((_, counter) => hotp(RFC_KEY, counter, 6, 'SHA1')), expected);
});

test('RFC 6238 Appendix B: 8-digit codes for SHA1, SHA256 and SHA512', () => {
  const sha1 = parseTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8');
  assert.deepEqual(sha1.key, RFC_KEY, 'the SHA1 key given as base32');
  const sha256 = { key: Buffer.from('12345678901234567890123456789012'), algorithm: 'SHA256' as const, digits: 8 as const, period: 30 };
  const sha512 = { key: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'), algorithm: 'SHA512' as const, digits: 8 as const, period: 30 };
  const at = (params: Parameters<typeof totpCode>[0], seconds: number) => totpCode(params, seconds * 1000).code;
  assert.deepEqual([at(sha1, 59), at(sha256, 59), at(sha512, 59)], ['94287082', '46119246', '90693936']);
  assert.deepEqual([at(sha1, 1111111109), at(sha256, 1111111109), at(sha512, 1111111109)], ['07081804', '68084774', '25091201']);
  assert.equal(at(sha1, 20000000000), '65353130');
  assert.equal(totpCode(sha1, 59_000).remainingMs, 1000, 'one second left in the window');
});

test('base32 round trip; the stored form and the otpauth link keep every parameter', () => {
  assert.equal(base32Encode(RFC_KEY), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd-gnbv gy3t qojq gezd gnbv gy3t qojq===='), RFC_KEY);
  const params = parseTotp('otpauth://totp/Shop:ada?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=7&period=45&issuer=Shop');
  assert.equal(serializeTotp(params), '{"k":"JBSWY3DPEHPK3PXP","a":"SHA256","d":7,"p":45}');
  assert.deepEqual(readTotp(serializeTotp(params)), params);
  assert.deepEqual(parseTotp(toOtpauth(params)), params);
  assert.doesNotMatch(toOtpauth(params), /Shop|ada/, 'issuer and account are dropped');
  assert.deepEqual(seedVariants(params), ['JBSWY3DPEHPK3PXP', 'jbswy3dpehpk3pxp', 'JBSW Y3DP EHPK 3PXP', 'jbsw y3dp ehpk 3pxp', 'JBSW-Y3DP-EHPK-3PXP', 'jbsw-y3dp-ehpk-3pxp']);
});

test('parseTotp: an otpauth link with issuer, digits and period, a lower-case space-grouped and a dash-grouped key', () => {
  const link = parseTotp('otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60');
  assert.deepEqual([link.base32, link.algorithm, link.digits, link.period], ['JBSWY3DPEHPK3PXP', 'SHA1', 8, 60]);
  const spaced = parseTotp('  jbsw y3dp ehpk 3pxp  ');
  assert.deepEqual([spaced.base32, spaced.algorithm, spaced.digits, spaced.period], ['JBSWY3DPEHPK3PXP', 'SHA1', 6, 30]);
  assert.equal(parseTotp('JBSW-Y3DP-EHPK-3PXP').base32, 'JBSWY3DPEHPK3PXP');
});

test('parseTotp refuses HOTP, short keys, 0/1/8/9, digits=5 and period=5 – bad_request without the input', () => {
  const inputs = [
    'otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=3',
    'JBSWY3DPEHPK3PX', // 15 characters
    'JBSWY3DPEHPK3PX0', 'JBSWY3DPEHPK3PX1', 'JBSWY3DPEHPK3PX8', 'JBSWY3DPEHPK3PX9',
    'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5',
    'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=5',
    'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
    'otpauth://totp/x?issuer=nokey',
    '',
  ];
  for (const input of inputs) {
    assert.throws(() => parseTotp(input), (error: unknown) => {
      assert.ok(error instanceof WorkforceError && error.code === 'bad_request', input);
      assert.ok(!input || !error.message.includes(input), `the message does not quote "${input}"`);
      assert.ok(!error.message.includes('JBSWY3DP'), 'nor any part of the key');
      return true;
    });
  }
  assert.throws(() => parseTotp(inputs[0]), /Only time-based \(TOTP\) keys are supported/);
});

test('findSetupKeys: the link and the grouped key on a 2FA setup text; nothing on a shop page', () => {
  const setup = [
    'Two-factor authentication',
    'Scan the QR code with your authenticator app, or enter this setup key manually:',
    'abcd efgh ijkl mnop qrst uvwx yz23 4567',
    'otpauth://totp/Shop:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Shop&period=30',
  ].join('\n');
  const keys = findSetupKeys(setup);
  assert.deepEqual(keys.map((key) => key.base32), ['JBSWY3DPEHPK3PXP', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'], 'the link first');
  const shop = 'Gift card ABCD EFGH JKLM NPQR – add it to your cart. Code valid until December.';
  assert.deepEqual(findSetupKeys(shop), []);
  assert.deepEqual(looksLikeSetupKey(shop), [], 'not masked either');
  // The same key as link and as text counts once, with the link's parameters.
  const same = findSetupKeys('Setup key: JBSW Y3DP EHPK 3PXP\notpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8');
  assert.deepEqual(same.map((key) => [key.base32, key.digits]), [['JBSWY3DPEHPK3PXP', 8]]);
  // Capture is strict: prose of 4-letter words is no key; a compact run needs a digit (masking also takes upper-case ones).
  assert.deepEqual(findSetupKeys('Open your authenticator and scan this code with your phone'), []);
  assert.deepEqual(findSetupKeys('2FA secret key: ABCDEFGHIJKLMNOPQRST'), []);
  assert.deepEqual(looksLikeSetupKey('2FA secret key: ABCDEFGHIJKLMNOPQRST'), ['ABCDEFGHIJKLMNOPQRST']);
  assert.deepEqual(findSetupKeys('2FA secret key: JBSWY3DPEHPK3PXP').map((key) => key.base32), ['JBSWY3DPEHPK3PXP']);
  assert.deepEqual(findSetupKeys('JBSWY3DPEHPK3PXP', 'Turn on two-factor authentication').length, 1, 'the context may come from the page');
});

test('ordinary pages are no setup pages; keys grouped with no-break, thin or double spaces are; seedPattern finds every spelling', () => {
  const ordinary = [
    'Scan the QR code at your table to order. We keep your data safe and send you news',
    'Sign in. Turn on two-factor authentication to keep your data safe',
    'MFA is on. Your last sign in was from this city with your phone',
    'Enter your address manually. Gift card ABCD EFGH JKLM NPQR',
  ];
  for (const text of ordinary) assert.deepEqual([looksLikeSetupKey(text), findSetupKeys(text)], [[], []], text);
  assert.equal(has2faContext('Scan the QR code to pay'), false, '"QR code" alone is no 2FA word');
  assert.deepEqual(looksLikeSetupKey('Two-factor authentication. Code: ABCD EFGH JKLM NPQR'), ['ABCD EFGH JKLM NPQR'], 'upper-case runs stay generous');
  for (const key of ['JBSW\u00a0Y3DP\u00a0EHPK\u00a03PXP', 'jbsw  y3dp  ehpk  3pxp', 'JBSW\u2009Y3DP\u2009EHPK\u20093PXP', 'JBSW\u202fY3DP\u202fEHPK\u202f3PXP']) {
    const text = `Set up your authenticator app. Setup key: ${key}`;
    assert.deepEqual(looksLikeSetupKey(text), [key], JSON.stringify(key));
    assert.deepEqual(findSetupKeys(text).map((found) => found.base32), ['JBSWY3DPEHPK3PXP'], JSON.stringify(key));
  }
  const pattern = seedPattern({ base32: 'JBSWY3DPEHPK3PXP' });
  const spellings = [...seedVariants({ base32: 'JBSWY3DPEHPK3PXP' }), 'JBSW\u00a0Y3DP\u00a0EHPK\u00a03PXP', 'jbsw  y3dp  ehpk  3pxp', 'JBS WY3 DPE HPK 3PX P'];
  for (const spelled of spellings) assert.equal(`x ${spelled} y`.replace(pattern, '#'), 'x # y', JSON.stringify(spelled));
  assert.equal('JBSW Y3DP EHPK 3PXQ'.replace(pattern, '#'), 'JBSW Y3DP EHPK 3PXQ', 'another key stays');
});
