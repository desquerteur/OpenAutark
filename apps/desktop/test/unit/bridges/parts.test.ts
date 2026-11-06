// Pure parts of chat bridges: plain-text rendering and chunking (text.ts), sender/body rules
// (inbound.ts), the Bot API error classification and token scrubbing (telegram-api.ts) and the
// long-poll loop's backoff and stop behaviour (poller.ts) – with fake fetch/sleep, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIAGRAM_LINE, INTERACTIVE_LINE, chunkText, toPlainText } from '../../../src/runtime/bridges/text.ts';
import { bodyOf, displayName, matchesChat, senderOf } from '../../../src/runtime/bridges/inbound.ts';
import { TelegramApi, TelegramError, botIdOf, scrub } from '../../../src/runtime/bridges/telegram-api.ts';
import type { TgMessage } from '../../../src/runtime/bridges/telegram-api.ts';
import { TelegramPoller, backoffMs } from '../../../src/runtime/bridges/poller.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { TOKEN } from './fake-telegram.ts';

test('toPlainText: Markdown marks removed, code kept, several blocks in a row become one line', () => {
  const md = '# Plan\n\n- **first** step\n- see [docs](https://x.y/d)\n\n```js\nconst a = `b`;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n```ui\n{"type":"steps","items":[]}\n```\n\n```ui\n{"type":"callout","text":"x"}\n```';
  assert.equal(toPlainText(md), ['Plan\n\n• first step\n• see docs (https://x.y/d)', 'const a = `b`;', DIAGRAM_LINE, INTERACTIVE_LINE].join('\n\n'));
  assert.equal(toPlainText('use `**not bold**` here'), 'use **not bold** here');
});

test('chunkText: paragraph breaks first, never above the limit, never inside a surrogate pair', () => {
  assert.deepEqual(chunkText('aaaa\n\nbbbb', 8), ['aaaa', 'bbbb']);
  const emoji = '😀'.repeat(10); // 20 UTF-16 units, no break points
  const chunks = chunkText(emoji, 7);
  assert.ok(chunks.every((chunk) => chunk.length <= 7));
  assert.equal(chunks.join(''), emoji, 'nothing lost, no broken emoji');
  assert.ok(chunks.every((chunk) => !/[\ud800-\udbff]$/.test(chunk)));
});

test('inbound rules: chat matching, display names, senders and bodies', () => {
  assert.equal(matchesChat('-100123', { id: -100123, type: 'supergroup' }), true);
  assert.equal(matchesChat('@MyChannel', { id: 5, type: 'channel', username: 'mychannel' }), true);
  assert.equal(matchesChat('@other', { id: 5, type: 'channel', username: 'mychannel' }), false);
  assert.equal(displayName('  Ana:\nLee  '), 'Ana Lee');
  assert.equal(displayName(''), 'Telegram user');
  const base = { message_id: 1, date: 0, chat: { id: 9, type: 'group' } } as TgMessage;
  assert.equal(senderOf({ ...base, from: { id: 3, is_bot: true } }), undefined);
  assert.deepEqual(senderOf({ ...base, sender_chat: { id: 77, type: 'channel', title: 'News' } }), { key: 'c77', name: 'News' });
  assert.equal(bodyOf({ ...base, text: '/start@wf_bot hello' }), '');
  assert.equal(bodyOf({ ...base, voice: {} }), '[voice message]');
});

function api(status: number, body: unknown): TelegramApi {
  return new TelegramApi((async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
}

test('Bot API errors: kinds, retry_after, migration and fixed sentences without the token', async () => {
  const cases: Array<[number, Record<string, unknown>, string]> = [
    [401, { ok: false, error_code: 401, description: 'Unauthorized' }, 'unauthorized'],
    [409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }, 'conflict'],
    [429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, 'rate_limited'],
    [400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'chat'],
    [502, { ok: false, error_code: 502, description: `Bad Gateway ${TOKEN}` }, 'server'],
    [400, { ok: false, error_code: 400, description: 'Bad Request: message text is empty' }, 'bad_request'],
  ];
  for (const [status, body, kind] of cases) {
    const error = await api(status, body).sendMessage(TOKEN, '1', 'x').catch((e: unknown) => e) as TelegramError;
    assert.ok(error instanceof TelegramError, kind);
    assert.equal(error.kind, kind);
    assert.ok(!error.message.includes(TOKEN) && !(error.detail ?? '').includes(TOKEN.split(':')[1]), `${kind}: token scrubbed`);
    if (kind === 'rate_limited') assert.equal(error.retryAfterMs, 7000);
  }
  const migrated = await api(400, { ok: false, error_code: 400, description: 'upgraded', parameters: { migrate_to_chat_id: -100555 } }).sendMessage(TOKEN, '1', 'x').catch((e: unknown) => e) as TelegramError;
  assert.equal(migrated.migrateTo, '-100555');
  const offline = new TelegramApi((async () => { throw new TypeError(`fetch failed for /bot${TOKEN}/getMe`); }) as typeof fetch);
  const network = await offline.getMe(TOKEN).catch((e: unknown) => e) as TelegramError;
  assert.equal(network.kind, 'network');
  assert.ok(!(network.detail ?? '').includes(TOKEN.split(':')[1]));
  assert.equal(botIdOf(TOKEN), '123456789');
  assert.equal(scrub(`token ${TOKEN} and 55555:${'x'.repeat(30)}`), 'token ••• and •••');
});

test('backoff: 1 s doubling up to 5 min', () => {
  assert.deepEqual([1, 2, 3, 10, 20].map(backoffMs), [1000, 2000, 4000, 300_000, 300_000]);
});

test('poller: network errors back off and recover; a fast empty answer waits instead of spinning; stop ends the loop', async () => {
  const clock = new ManualClock(0);
  const waits: number[] = [];
  const answers: Array<() => Promise<unknown>> = [
    async () => [], // backlog skip
    async () => { throw new TelegramError('network'); },
    async () => { throw new TelegramError('network'); },
    async () => [], // comes back empty at once → must wait 1 s
    async () => [{ update_id: 10, message: { message_id: 1, date: 0, chat: { id: 1, type: 'group' } } }],
  ];
  const seenOffsets: unknown[] = [];
  const states: string[] = [];
  const batches: number[] = [];
  let poller: TelegramPoller;
  const fakeApi = {
    async getUpdates(_token: string, params: { offset?: number }) {
      seenOffsets.push(params.offset);
      const next = answers.shift();
      if (!next) { poller.stop(); return []; }
      return next();
    },
  } as unknown as TelegramApi;
  poller = new TelegramPoller({
    api: fakeApi, token: TOKEN, clock, log: new MemoryLogger(),
    sleep: async (ms) => { waits.push(ms); },
    onUpdates: (updates) => { batches.push(updates.length); },
    onOffset: () => {},
    onState: (state) => { states.push(state.status); },
  });
  poller.start();
  await poller.done();
  assert.deepEqual(waits, [1000, 2000, 1000], 'backoff 1 s, 2 s, then the 1 s pause after an instant empty poll');
  assert.equal(seenOffsets[0], -1, 'first start skips the backlog');
  assert.deepEqual(batches, [1]);
  assert.equal(poller.offset, 11, 'the cursor moved past the handled update');
  assert.ok(states.includes('error') && states.at(-1) === 'connected');
});
