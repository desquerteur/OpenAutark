// The pure DE/EN text extractors of to-do widgets (F05, src/runtime/subconscious/widget-text.ts):
// the first link without trailing punctuation, lists (bullets, after a colon), options ending a
// question, a teleprompter script, how a reminder repeats, an amount with its currency, form
// field kinds – and never a credential field (plurals and the common DE/EN names of passwords,
// codes, keys and card data). (Moved here from the scratch probe zz-probe-f05.test.ts.)
// Owns: these assertions only. Never: I/O, models or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountIn, fieldsIn, firstUrl, isCredential, listIn, optionsIn, repeatIn, scriptIn } from '../../../src/runtime/subconscious/widget-text.ts';

test('firstUrl: the first link, without trailing punctuation; a balanced bracket stays', () => {
  assert.equal(firstUrl('Open https://example.com/a?b=1, then http://second.example'), 'https://example.com/a?b=1');
  assert.equal(firstUrl('See (https://example.com/page).'), 'https://example.com/page');
  assert.equal(firstUrl('Read https://en.wikipedia.org/wiki/Foo_(bar)'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(firstUrl('No link here'), undefined);
});

test('listIn and optionsIn: bullets, a list after a colon, alternatives ending a question', () => {
  assert.deepEqual(listIn('Shopping\n- milk\n* eggs\n1. bread'), ['milk', 'eggs', 'bread']);
  assert.deepEqual(listIn('Packen: Pass, Ladekabel und Tickets'), ['Pass', 'Ladekabel', 'Tickets']);
  assert.equal(listIn('Meeting at 10:30 with Anna'), undefined, 'a clock time is no list');
  assert.deepEqual(optionsIn('The red one or the blue one?'), ['The red one', 'The blue one']);
  assert.deepEqual(optionsIn('Tee, Kaffee oder Wasser?'), ['Tee', 'Kaffee', 'Wasser']);
  assert.equal(optionsIn('Call the bank, or wait?'), undefined, '", or" joins clauses');
});

test('scriptIn, repeatIn and amountIn', () => {
  assert.equal(scriptIn('Record the intro. Skript: Willkommen zum Kurs!'), 'Willkommen zum Kurs!');
  assert.equal(scriptIn('Say "Thanks for watching the whole video" at the end'), 'Thanks for watching the whole video');
  assert.equal(scriptIn('Record the intro'), undefined);
  assert.equal(repeatIn('Erinnere mich werktags um 8'), 'weekdays');
  assert.equal(repeatIn('Water the plants every day'), 'daily');
  assert.equal(repeatIn('Team call every Monday'), 'weekly');
  assert.equal(repeatIn('Call mum on Monday'), undefined);
  assert.deepEqual(amountIn('Pay $30 for the domain'), { value: 30, currency: 'USD' });
  assert.deepEqual(amountIn('Rechnung über 120 Euro freigeben'), { value: 120, currency: 'EUR' });
  assert.equal(amountIn('Approve 3 posts'), undefined, 'a number without a currency is no amount');
});

test('fieldsIn: kinds from the label, identifiers stay text, credentials never become a field', () => {
  assert.deepEqual(fieldsIn('Fill in: name, e-mail, birthday, number of guests, customer number, notes'), [
    { label: 'Name', kind: 'text' }, { label: 'E-mail', kind: 'email' }, { label: 'Birthday', kind: 'date' },
    { label: 'Number of guests', kind: 'number' }, { label: 'Customer number', kind: 'text' }, { label: 'Notes', kind: 'longtext' },
  ]);
  assert.deepEqual(fieldsIn('Login: user name and password'), [{ label: 'User name', kind: 'text' }]);
  assert.equal(fieldsIn('Enter: PIN, TAN'), undefined);
  assert.ok(isCredential('Your API key') && isCredential('Passwort') && !isCredential('Postcode'));
});

test('isCredential: plurals and the common names of passwords, codes, keys and card data – not postcodes or customer numbers', () => {
  const credentials = [
    'passwords', 'Wifi passwords', 'WLAN-Passwort', 'Passwörter', 'Kennwörter', 'passphrase', 'API keys', 'License key', 'WLAN-Schlüssel',
    'tokens', 'secrets', 'Geheimzahl', 'PINs', 'PIN-Code', 'TANs', 'credentials', 'Zugangsdaten', 'Anmeldedaten', 'Login details',
    'security code', 'verification code', 'recovery codes', 'one-time code', '2FA code', 'Auth code', 'Sicherheitscode', 'Bestätigungscode',
    'Einmalcode', 'Security question', 'Seed phrase', 'Card number', 'Kreditkartennummer', 'CVC',
  ];
  assert.deepEqual(credentials.filter((label) => !isCredential(label)), []);
  const plain = ['Postcode', 'Zip code', 'Postleitzahl', 'Discount code', 'Gutscheincode', 'Customer number', 'Kundennummer', 'Passport number', 'IBAN', 'User name', 'Expiry date'];
  assert.deepEqual(plain.filter((label) => isCredential(label)), []);
  assert.equal(fieldsIn('Send IT: user names and passwords, recovery codes, API keys'), undefined, 'no plain field for any of them');
  assert.deepEqual(fieldsIn('Fill in: card number, expiry date and security code'), [{ label: 'Expiry date', kind: 'date' }]);
});
