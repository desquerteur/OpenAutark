// Names and values as people paste or keep them (owner 04.11.2026, shared/model/key-values.ts): .env lines with export,
// quotes, comments and a quoted value over several lines, "KEY: value", a flat JSON object of text values; a CSV, prose, a
// URL or a bare value is no key/value text; the kind a name suggests; which pair of a file is a secret, not a setting.
// Owns: these assertions only. Never: a file or the vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKeyValueFormat, isSecretPair, kindForName, parseKeyValues, ENV_FORMAT, JSON_FORMAT } from '../../../src/shared/model/key-values.ts';

test('.env: export, quotes, comments, blank lines, "=" inside a value and a value over several lines', () => {
  const text = [
    '# the shop', '', 'export OPENAI_API_KEY=sk-abc123', 'DB_PASS = "pa ss\\"word"', "SINGLE='keeps \\n as written'",
    'EMPTY=', 'TOKEN=abc==  # base64 with padding', 'PEM="-----BEGIN KEY-----', 'line two', '-----END KEY-----"', 'ESCAPED="a\\nb"',
  ].join('\r\n');
  assert.deepEqual(parseKeyValues(text), [
    { name: 'OPENAI_API_KEY', value: 'sk-abc123' },
    { name: 'DB_PASS', value: 'pa ss"word' },
    { name: 'SINGLE', value: 'keeps \\n as written' },
    { name: 'EMPTY', value: '' },
    { name: 'TOKEN', value: 'abc==' },
    { name: 'PEM', value: '-----BEGIN KEY-----\nline two\n-----END KEY-----' },
    { name: 'ESCAPED', value: 'a\nb' },
  ]);
  assert.deepEqual(parseKeyValues('Password: hunter2'), [{ name: 'Password', value: 'hunter2' }], 'KEY: value');
  assert.deepEqual(parseKeyValues('﻿A=1'), [{ name: 'A', value: '1' }], 'a BOM is dropped');
});

test('a flat JSON object of text values; anything else is no key/value text', () => {
  assert.deepEqual(parseKeyValues('{ "STRIPE_KEY": "sk_test_1", "apiToken": "t-2" }'), [{ name: 'STRIPE_KEY', value: 'sk_test_1' }, { name: 'apiToken', value: 't-2' }]);
  for (const text of [
    '{"x":1}', '{"nested":{"a":"b"}}', '[]', '{}', '{ broken',
    'name,url,username,password\nx,https://x.example,u,p', 'https://example.com/login', 'sk-abc123', 'just some words', 'A=1\nnot a pair', 'Q="never closed',
    '', '# only a comment',
  ]) assert.equal(parseKeyValues(text), undefined, text);
});

test('the kind a name suggests, and the two key/value formats', () => {
  assert.equal(kindForName('GITHUB_TOKEN'), 'token');
  assert.equal(kindForName('apiToken'), 'token');
  assert.equal(kindForName('DB_PASSWORD'), 'password');
  assert.equal(kindForName('dbPassword'), 'password');
  assert.equal(kindForName('SMTP_PASS'), 'password');
  assert.equal(kindForName('MAIL_PWD'), 'password');
  assert.equal(kindForName('PASSPORT_NUMBER'), 'api_key');
  assert.equal(kindForName('COMPASS_KEY'), 'api_key');
  assert.equal(kindForName('OPENAI_API_KEY'), 'api_key');
  assert.ok(isKeyValueFormat(ENV_FORMAT) && isKeyValueFormat(JSON_FORMAT));
  assert.equal(isKeyValueFormat('Chrome'), false);
});

test('a secret by its name or a password in a URL; plain settings and addresses are no secrets', () => {
  const pair = (name: string, value = 'some-value-1') => isSecretPair({ name, value });
  for (const name of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'apiToken', 'DB_PASSWORD', 'SMTP_PASS', 'SESSION_SECRET', 'NEXTAUTH_SECRET', 'AUTHORIZATION', 'SENTRY_DSN', 'SLACK_WEBHOOK_URL', 'GITHUB_PAT', 'githubPat', 'stripe.secret-key', 'AWS_ACCESS_KEY_ID']) {
    assert.ok(pair(name), name);
  }
  for (const name of ['NODE_ENV', 'PORT', 'APP_URL', 'NEXTAUTH_URL', 'authUrl', 'PRIVATE_KEY_PATH', 'SECRET_KEY_FILE', 'SESSION_TIMEOUT', 'AUTHOR', 'authorName', 'PATH', 'DEBUG', 'REGION']) {
    assert.equal(pair(name), false, name);
  }
  assert.ok(pair('DATABASE_URL', 'postgres://app:dbpass-9@db.local/shop'), 'a URL with a password');
  assert.ok(pair('REDIS_URL', 'redis://:pw-123@cache:6379'), 'a URL with only a password');
  assert.equal(pair('DATABASE_URL', 'postgres://db.local/shop'), false);
  assert.equal(pair('PUBLIC_URL', 'http://localhost:3000'), false);
  assert.equal(pair('SENTRY_URL', 'https://key@sentry.example/1'), false, 'a user without a password is no password');
});
