// Chat bridges end to end inside the runtime (src/runtime/bridges/service.ts): a fake Telegram
// Bot API, the real ChatService on SQLite and an in-memory vault. Covers connecting (token only
// in the vault, backlog skipped), incoming messages as untrusted external members (dedupe,
// bots and /start ignored, removed contacts stay out), the outgoing selection (owner + final
// agent answers, never echoes, status lines, drafts or edits), chunking, 429 retry, refused
// chats, supergroup migration, disconnect, resume from the stored cursor, a revoked token and
// that no token ever reaches rows, events, logs or errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { Bridge } from '../../../src/shared/model/bridges.ts';
import { BOT, GROUP_ID, OTHER_TOKEN, TOKEN, bridgeSetup, until } from './fake-telegram.ts';

async function connected(setup = bridgeSetup()) {
  const bridge = await setup.bridges.connectTelegram({ conversationId: setup.chat.id, botToken: TOKEN, externalChatId: String(GROUP_ID) });
  await until(() => setup.bridges.list()[0]?.status === 'connected');
  await until(() => setup.telegram.polls() >= 2); // backlog skip + the first long poll
  return { ...setup, bridge };
}

const chatMessages = (s: ReturnType<typeof bridgeSetup>) => s.h.chats.messages(s.chat.id).filter((m) => m.kind === 'text');

test('connect: token checked with getMe and kept only in the vault; the backlog is skipped', async () => {
  const s = bridgeSetup();
  s.telegram.push({ text: 'old message before the link' });
  const { bridge, telegram, vault, bridges, h } = await connected(s);
  try {
    assert.equal(telegram.calls[0].method, 'getMe');
    assert.deepEqual(Object.keys(bridge).sort(), ['conversationId', 'createdAt', 'externalChatId', 'id', 'kind', 'status', 'updatedAt']);
    const [secret] = vault.list();
    assert.equal(secret.label, `Telegram bot @${BOT.username}`);
    assert.equal(secret.source, 'api.telegram.org', 'owner 29.10.2026: where it came from, not a binding');
    assert.deepEqual(vault.values(), [TOKEN]);
    assert.equal(chatMessages(s).length, 0, 'the backlog is not imported');
    const rows = JSON.stringify(h.db.all('SELECT * FROM bridges'));
    assert.ok(!rows.includes(TOKEN) && !rows.includes(TOKEN.split(':')[1]), 'no token in bridge rows');
    assert.ok(!JSON.stringify(h.events).includes(TOKEN.split(':')[1]), 'no token in events');
  } finally {
    bridges.stop();
  }
});

test('a rejected token stores nothing and gives a fixed sentence without the token', async () => {
  const s = bridgeSetup();
  await assert.rejects(
    s.bridges.connectTelegram({ conversationId: s.chat.id, botToken: OTHER_TOKEN, externalChatId: '42' }),
    (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request' && error.message === 'Telegram rejected the bot token.' && !error.message.includes(OTHER_TOKEN),
  );
  assert.equal(s.vault.list().length, 0);
  assert.equal(s.bridges.list().length, 0);
  assert.ok(!JSON.stringify(s.log.entries).includes(OTHER_TOKEN.split(':')[1]), 'no token in logs');
});

test('incoming: untrusted external member, one member per sender, media marker, duplicates, bots and /start ignored', async () => {
  const s = await connected();
  try {
    s.telegram.push({ text: 'Hi team' });
    await until(() => chatMessages(s).length === 1);
    const [first] = chatMessages(s);
    assert.equal(first.authorKind, 'external');
    assert.equal(first.authorId, 'ext:tg:42:Ana Lee (Telegram)');
    assert.equal(first.meta.via, 'bridge');
    assert.equal(first.body, 'Hi team');
    const member = s.h.chats.members(s.chat.id).find((m) => m.memberId === first.authorId);
    assert.equal(member?.kind, 'external');

    s.telegram.push({ text: '/start' });
    s.telegram.push({ text: 'from a bot', from: { id: 7, is_bot: true, first_name: 'OtherBot' } });
    s.telegram.push({ caption: 'our logo', photo: [{}] });
    s.telegram.push({ message_id: 9001, text: 'sent twice' });
    s.telegram.push({ message_id: 9001, text: 'sent twice' }); // redelivered update, same Telegram message
    s.telegram.push({ text: 'second from Ana' });
    await until(() => chatMessages(s).length === 4);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(chatMessages(s).map((m) => m.body), ['Hi team', '[photo] our logo', 'sent twice', 'second from Ana']);
    const external = s.h.chats.members(s.chat.id).filter((m) => m.kind === 'external');
    assert.equal(external.length, 1, 'the same sender stays one member');
    assert.equal(s.telegram.sent.length, 0, 'nothing that came from Telegram is echoed back');
  } finally {
    s.bridges.stop();
  }
});

test('a contact the owner removed stays out', async () => {
  const s = await connected();
  try {
    s.telegram.push({ text: 'first' });
    await until(() => chatMessages(s).length === 1);
    s.h.chats.setMembers(s.chat.id, { remove: [chatMessages(s)[0].authorId] }, 'human');
    s.telegram.push({ text: 'after removal' });
    const polls = s.telegram.polls();
    await until(() => s.telegram.polls() > polls); // the batch was handled and the next poll started
    assert.deepEqual(chatMessages(s).map((m) => m.body), ['first']);
  } finally {
    s.bridges.stop();
  }
});

test('outgoing: the owner and final agent answers as plain text; status lines, drafts and edits stay home', async () => {
  const s = await connected();
  try {
    s.h.chats.send({ conversationId: s.chat.id, body: '**Please** check the [plan](https://example.com/p)', authorId: 'human' });
    await s.bridges.settled();
    assert.deepEqual(s.telegram.sent, [{ chatId: String(GROUP_ID), text: 'Sam: Please check the plan (https://example.com/p)' }]);

    s.h.chats.status(s.chat.id, { type: 'note', text: 'Switched model' });
    const draft = s.h.chats.beginAgentMessage(s.chat.id, 'ag_ada', 'run_1');
    s.h.chats.appendDelta(draft.id, 'Working…');
    await s.bridges.settled();
    assert.equal(s.telegram.sent.length, 1, 'no status line and no streaming draft');

    s.h.chats.finishAgentMessage(draft.id, { body: 'Done.\n\n```ui\n{"type":"callout","text":"Saved"}\n```', state: 'final' });
    await s.bridges.settled();
    assert.equal(s.telegram.sent[1].text, 'Ada: Done.\n\n[interactive content – open the app]');

    const mine = s.h.chats.send({ conversationId: s.chat.id, body: 'typo', authorId: 'human' });
    await s.bridges.settled();
    s.h.chats.edit(mine.id, 'fixed', 'human');
    await s.bridges.settled();
    assert.deepEqual(s.telegram.sent.map((m) => m.text), ['Sam: Please check the plan (https://example.com/p)', 'Ada: Done.\n\n[interactive content – open the app]', 'Sam: typo']);
  } finally {
    s.bridges.stop();
  }
});

test('long answers are split into messages of at most 4096 characters, in order', async () => {
  const s = await connected();
  try {
    const paragraph = 'word '.repeat(700).trim(); // ≈ 3500 characters
    s.h.chats.send({ conversationId: s.chat.id, body: `${paragraph}\n\n${paragraph}\n\n${paragraph}`, authorId: 'human' });
    await s.bridges.settled();
    assert.equal(s.telegram.sent.length, 3);
    assert.ok(s.telegram.sent.every((m) => m.text.length <= 4096));
    assert.ok(s.telegram.sent[0].text.startsWith('Sam: word'));
  } finally {
    s.bridges.stop();
  }
});

test('429: waits retry_after and sends once; a refused chat sets a fixed error that clears on the next success', async () => {
  const s = await connected();
  try {
    s.telegram.sendRules.push(() => ({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } } }));
    s.h.chats.send({ conversationId: s.chat.id, body: 'one', authorId: 'human' });
    await s.bridges.settled();
    assert.deepEqual(s.telegram.sent.map((m) => m.text), ['Sam: one']);
    assert.ok(s.sleeps.includes(3000), 'waited retry_after');

    s.telegram.sendRules.push(() => ({ status: 403, body: { ok: false, error_code: 403, description: `Forbidden: bot was kicked (${TOKEN})` } }));
    s.h.chats.send({ conversationId: s.chat.id, body: 'two', authorId: 'human' });
    await s.bridges.settled();
    const failed = s.bridges.list()[0];
    assert.equal(failed.status, 'error');
    assert.equal(failed.error, 'Telegram refused messages for this chat. Check the chat id and that the bot is a member.');
    assert.ok(!JSON.stringify(s.log.entries).includes(TOKEN.split(':')[1]), 'provider text is scrubbed in logs');

    s.h.chats.send({ conversationId: s.chat.id, body: 'three', authorId: 'human' });
    await s.bridges.settled();
    assert.equal(s.bridges.list()[0].status, 'connected');
    assert.deepEqual(s.telegram.sent.map((m) => m.text), ['Sam: one', 'Sam: three'], 'a refused message is not retried');
  } finally {
    s.bridges.stop();
  }
});

test('supergroup migration: the bridge follows the new chat id and the message is delivered there', async () => {
  const s = await connected();
  try {
    s.telegram.sendRules.push(() => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100999 } } }));
    s.h.chats.send({ conversationId: s.chat.id, body: 'hello', authorId: 'human' });
    await s.bridges.settled();
    assert.equal(s.bridges.list()[0].externalChatId, '-100999');
    assert.deepEqual(s.telegram.sent, [{ chatId: '-100999', text: 'Sam: hello' }]);
  } finally {
    s.bridges.stop();
  }
});

test('disconnect: the long poll ends, a stopped event goes out, nothing more is sent', async () => {
  const s = await connected();
  s.bridges.disconnect(s.bridge.id);
  const polls = s.telegram.polls();
  s.telegram.push({ text: 'after disconnect' });
  s.h.chats.send({ conversationId: s.chat.id, body: 'after disconnect', authorId: 'human' });
  await s.bridges.settled();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.telegram.polls(), polls, 'no further getUpdates');
  assert.equal(s.telegram.sent.length, 0);
  assert.equal(s.bridges.list().length, 0);
  const last = s.h.of('bridge.upserted').at(-1) as Bridge;
  assert.equal(last.status, 'stopped');
  assert.equal(chatMessages(s).filter((m) => m.authorKind === 'external').length, 0);
  s.bridges.stop();
});

test('restart: a new service resumes from the stored cursor without importing old messages again', async () => {
  const s = await connected();
  s.telegram.push({ text: 'before restart' });
  await until(() => chatMessages(s).length === 1);
  await until(() => s.telegram.polls() >= 3); // the cursor moved and the next poll is waiting
  s.bridges.stop();

  const callsBefore = s.telegram.calls.length;
  const again = s.make();
  again.start();
  await until(() => s.telegram.calls.length > callsBefore && s.telegram.calls.at(-1)!.method === 'getUpdates');
  const resumed = s.telegram.calls.slice(callsBefore).find((call) => call.method === 'getUpdates')!;
  assert.notEqual(resumed.body.offset, -1, 'no backlog skip: the stored cursor is used');
  assert.equal(typeof resumed.body.offset, 'number');
  s.telegram.push({ text: 'after restart' });
  await until(() => chatMessages(s).length === 2);
  assert.deepEqual(chatMessages(s).map((m) => m.body), ['before restart', 'after restart']);
  again.stop();
});

test('a token revoked while running stops the loop for good with a clear status', async () => {
  const s = await connected();
  s.telegram.validTokens.clear();
  s.telegram.push({ text: 'wakes the waiting poll' }); // this answer still succeeds; the next poll gets 401
  await until(() => s.bridges.list()[0]?.status === 'error');
  const polls = s.telegram.polls();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.telegram.polls(), polls, 'no retry after the token was rejected');
  assert.equal(s.bridges.list()[0].error, 'Telegram rejected the bot token. Connect again with a new token.');
  s.bridges.stop();
});

test('a chat can be linked once per Telegram chat; unknown chats are refused', async () => {
  const s = await connected();
  try {
    await assert.rejects(s.bridges.connectTelegram({ conversationId: s.chat.id, botToken: TOKEN, externalChatId: String(GROUP_ID) }),
      (error: unknown) => error instanceof WorkforceError && error.code === 'conflict');
    await assert.rejects(s.bridges.connectTelegram({ conversationId: 'ch_missing', botToken: TOKEN, externalChatId: '1' }),
      (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
  } finally {
    s.bridges.stop();
  }
});
