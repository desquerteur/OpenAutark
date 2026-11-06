// The owner's Telegram account on a bridge (src/runtime/bridges/owner-link.ts) against the fake Bot API, the real
// ChatService on SQLite and an in-memory vault: "Link my Telegram" codes (8 characters, 10 minutes, single use, memory
// only), /link from the owner's account (stored, confirmed once, never posted), that account's messages posting as the
// human (never echoed), bots/channels/other chats never linking, unlink, disconnect and restart – plus the two RPC
// methods. A real bot stays a manual check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fromBridgeOwner } from '../../../src/shared/model/bridges.ts';
import type { Bridge, OwnerLinkCode } from '../../../src/shared/model/bridges.ts';
import { OWNER_LINK_CODE_MS } from '../../../src/shared/model/bridges.ts';
import { linkCommand, linkedText, normalizeCode, privateChatOwner } from '../../../src/runtime/bridges/owner-link.ts';
import { newestPrivateChat } from '../../../src/runtime/bridges/tools.ts';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { allowedScope, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import type { RpcExtras } from '../../../src/runtime/rpc/extras.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import { GROUP_ID, OWNER_TG, TOKEN, delivered, ownerSetup, until } from './fake-telegram.ts';

const CONFIRM = linkedText('Sam');

async function connected(setup = ownerSetup()) {
  const bridge = await setup.bridges.connectTelegram({ conversationId: setup.chat.id, botToken: TOKEN, externalChatId: String(GROUP_ID) });
  await until(() => setup.bridges.list()[0]?.status === 'connected');
  await until(() => setup.telegram.polls() >= 2); // backlog skip + the first long poll
  return { ...setup, bridge };
}

type Setup = Awaited<ReturnType<typeof connected>>;

const texts = (s: Setup) => s.h.chats.messages(s.chat.id).filter((m) => m.kind !== 'status');
const owner = (text: string, extra: Record<string, unknown> = {}) => ({ text, from: OWNER_TG, ...extra });
const member = (text: string) => ({ text, from: { id: 99, is_bot: false, first_name: 'Sam', last_name: 'Owner' } }); // picks the owner's name

async function linked(s: Setup): Promise<OwnerLinkCode> {
  const code = s.bridges.linkOwner(s.bridge.id);
  await delivered(s.telegram, s.bridges, owner(`/link ${code.code}`));
  assert.ok(s.bridges.list()[0].owner, 'linked');
  return code;
}

test('a code: 8 readable characters, valid 10 minutes, a new one replaces the unused one', async () => {
  const s = await connected();
  try {
    const first = s.bridges.linkOwner(s.bridge.id);
    assert.match(first.code, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.equal(first.bridgeId, s.bridge.id);
    assert.equal(first.expiresAt, s.h.clock.now() + OWNER_LINK_CODE_MS);
    const second = s.bridges.linkOwner(s.bridge.id);
    assert.notEqual(second.code, first.code);
    await delivered(s.telegram, s.bridges, owner(`/link ${first.code}`));
    assert.equal(s.bridges.list()[0].owner, undefined, 'the replaced code no longer works');
    await delivered(s.telegram, s.bridges, owner(`/link ${second.code}`));
    assert.equal(s.bridges.list()[0].owner?.name, 'Sam Owner');
    const stored = JSON.stringify([s.h.db.all('SELECT * FROM bridges'), s.log.entries, s.h.events]);
    assert.ok(!stored.includes(first.code) && !stored.includes(second.code), 'codes live in memory only (not in rows, logs or events)');
  } finally {
    s.bridges.stop();
  }
});

test('/link <code> from the owner links the account, confirms once and is never posted', async () => {
  const s = await connected();
  try {
    const code = await linked(s);
    const bridge = s.bridges.list()[0];
    assert.deepEqual(bridge.owner, { name: 'Sam Owner', linkedAt: s.h.clock.now() });
    assert.deepEqual(s.telegram.sent, [{ chatId: String(GROUP_ID), text: CONFIRM }], 'one confirmation');
    assert.equal(texts(s).length, 0, 'the /link message never reaches the chat');
    assert.equal(s.h.db.get<{ owner_user_id: string }>('SELECT owner_user_id FROM bridges')?.owner_user_id, String(OWNER_TG.id));
    const event = s.h.of('bridge.upserted').at(-1) as Bridge;
    assert.equal(event.owner?.name, 'Sam Owner');
    assert.ok(!JSON.stringify([s.h.of('bridge.upserted'), s.bridges.list()]).includes(String(OWNER_TG.id)), 'clients never see the Telegram user id');

    await delivered(s.telegram, s.bridges, owner(`/link ${code.code}`)); // single use
    assert.equal(s.telegram.sent.length, 1, 'no second confirmation');
    assert.equal(texts(s).length, 0);
  } finally {
    s.bridges.stop();
  }
});

test('the code ignores case, spaces and dashes; /link@<bot> works', async () => {
  assert.equal(linkCommand('/link abcd-efgh'), 'abcd-efgh');
  assert.equal(linkCommand('/link@wf_test_bot  ABCD EFGH '), 'ABCD EFGH');
  assert.equal(linkCommand('/link'), '');
  assert.equal(linkCommand('/linked ABCDEFGH'), undefined);
  assert.equal(linkCommand('please /link ABCDEFGH'), undefined);
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  const s = await connected();
  try {
    const { code } = s.bridges.linkOwner(s.bridge.id);
    await delivered(s.telegram, s.bridges, owner(`/link@wf_test_bot ${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`));
    assert.equal(s.bridges.list()[0].owner?.name, 'Sam Owner');
  } finally {
    s.bridges.stop();
  }
});

test('the owner posts as the human via the bridge: not echoed, wakes the agent, others stay external', async () => {
  const s = await connected();
  try {
    await linked(s);
    await delivered(s.telegram, s.bridges, owner('Status of the launch?'), { text: 'Hi from Ana' });
    const [mine, ana] = texts(s);
    assert.equal(mine.authorId, 'human');
    assert.equal(mine.authorKind, 'human');
    assert.equal(mine.kind, 'text');
    assert.equal(mine.body, 'Status of the launch?');
    assert.equal(mine.meta.via, 'bridge');
    assert.equal((mine.meta.bridge as { owner?: boolean }).owner, true);
    assert.ok(fromBridgeOwner(mine));
    assert.equal(ana.authorKind, 'external');
    assert.equal(ana.authorId, 'ext:tg:42:Ana Lee (Telegram)');
    assert.ok(!fromBridgeOwner(ana));
    assert.ok(s.h.wakeRows().some((row) => row.agent_id === 'ag_ada' && row.reason === 'message'), 'the agent is woken like for the desktop');
    assert.deepEqual(s.telegram.sent.map((m) => m.text), [CONFIRM], 'nothing from Telegram is echoed back');

    const draft = s.h.chats.beginAgentMessage(s.chat.id, 'ag_ada', 'run_1');
    s.h.chats.finishAgentMessage(draft.id, { body: 'On track.', state: 'final' });
    await s.bridges.settled();
    assert.deepEqual(s.telegram.sent.map((m) => m.text), [CONFIRM, 'Ada: On track.']);
  } finally {
    s.bridges.stop();
  }
});

test('owner messages never answer an ask: always plain text, the open to-do stays open', async () => {
  const s = await connected();
  try {
    const ask = s.h.tasks.create({ conversationId: s.chat.id, title: 'Approve the budget?', assigneeKind: 'human', humanReason: 'approval', createdBy: 'ag_ada' });
    await linked(s);
    await delivered(s.telegram, s.bridges, owner('yes'), owner('approve', { reply_to_message: { message_id: 1 } }));
    const posted = texts(s).filter((m) => m.authorKind === 'human');
    assert.deepEqual(posted.map((m) => [m.kind, m.body]), [['text', 'yes'], ['text', 'approve']]);
    assert.ok(posted.every((m) => m.replyTo === undefined && m.taskId === undefined && m.meta.answer === undefined));
    assert.ok(!s.h.chats.messages(s.chat.id).some((m) => m.kind === 'answer'), 'no answer receipt');
    assert.equal(s.h.tasks.get(ask.id)?.status, ask.status, 'the ask is still open');
  } finally {
    s.bridges.stop();
  }
});

test('bots, channel posts, a bare /link and other chats never link', async () => {
  const s = await connected();
  try {
    const { code } = s.bridges.linkOwner(s.bridge.id);
    const guesses = Array.from({ length: 6 }, (_, i) => `/link WRONG${String(i).padStart(3, '2')}`);
    await delivered(s.telegram, s.bridges,
      ...guesses.map((text) => ({ text, from: { id: 7, is_bot: true, first_name: 'OtherBot' } })),
      ...guesses.map((text) => ({ text, from: undefined, sender_chat: { id: GROUP_ID, type: 'supergroup', title: 'Team' } })),
      owner('/link'),
      owner(`/link ${code}`, { chatId: 555 }), // the owner's private chat with the bot: not this bridge's chat
    );
    assert.equal(s.bridges.list()[0].owner, undefined);
    assert.equal(s.telegram.sent.length, 0);
    assert.equal(texts(s).length, 0);
    await delivered(s.telegram, s.bridges, owner(`/link ${code}`));
    assert.equal(s.bridges.list()[0].owner?.name, 'Sam Owner', 'the code still works in the bridged chat');
  } finally {
    s.bridges.stop();
  }
});

test('unlink: the account is an external contact again; disconnect drops link and code', async () => {
  const s = await connected();
  try {
    await linked(s);
    const unlinked = s.bridges.unlinkOwner(s.bridge.id);
    assert.equal(unlinked.owner, undefined);
    assert.equal((s.h.of('bridge.upserted').at(-1) as Bridge).owner, undefined);
    await delivered(s.telegram, s.bridges, owner('am I still me?'));
    assert.equal(texts(s).at(-1)?.authorId, 'ext:tg:4242:Sam Owner (Telegram)');
    assert.equal(texts(s).at(-1)?.authorKind, 'external');

    await linked(s);
    const pending = s.bridges.linkOwner(s.bridge.id);
    s.bridges.disconnect(s.bridge.id);
    const stopped = s.h.of('bridge.upserted').at(-1) as Bridge;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.owner, undefined, 'the stopped event carries no link');
    assert.throws(() => s.bridges.unlinkOwner(s.bridge.id), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');

    const polls = s.telegram.polls();
    const again = await s.bridges.connectTelegram({ conversationId: s.chat.id, botToken: TOKEN, externalChatId: String(GROUP_ID) });
    await until(() => s.telegram.polls() >= polls + 2); // backlog skip + the long poll of the new stream
    assert.equal(again.owner, undefined, 'a new bridge starts without a link');
    await delivered(s.telegram, s.bridges, owner(`/link ${pending.code}`));
    assert.equal(s.bridges.list()[0].owner, undefined, 'the code died with the old bridge');
  } finally {
    s.bridges.stop();
  }
});

test('restart: the link is stored, a code is not', async () => {
  const s = await connected();
  await linked(s);
  const pending = s.bridges.linkOwner(s.bridge.id);
  s.bridges.stop();

  const polls = s.telegram.polls();
  const again = s.make();
  again.start();
  await until(() => s.telegram.polls() > polls); // resumed from the stored cursor, the long poll waits
  try {
    await delivered(s.telegram, again, owner('back after a restart'));
    assert.equal(texts(s).at(-1)?.authorKind, 'human');
    assert.equal(texts(s).at(-1)?.body, 'back after a restart');
    await delivered(s.telegram, again, { text: `/link ${pending.code}`, from: { id: 99, is_bot: false, first_name: 'Eve' } });
    assert.equal(again.list()[0].owner?.name, 'Sam Owner', 'the old code is gone with the old process');
  } finally {
    again.stop();
  }
});

test('linkOwner refuses unknown bridges and channels', async () => {
  const s = await connected();
  try {
    assert.throws(() => s.bridges.linkOwner('br_missing'), (error: unknown) => error instanceof WorkforceError && error.code === 'not_found');
    const channel = await s.bridges.connectTelegram({ conversationId: s.chat.id, botToken: TOKEN, externalChatId: '@team_news' });
    assert.throws(() => s.bridges.linkOwner(channel.id), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  } finally {
    s.bridges.stop();
  }
});

test('RPC: bridges.linkOwner / unlinkOwner are owner only and take exactly { id }', async () => {
  const calls: Array<[string, string]> = [];
  const code: OwnerLinkCode = { bridgeId: 'br_1', code: 'ABCDEFGH', expiresAt: 1 };
  const bridge: Bridge = { id: 'br_1', kind: 'telegram', conversationId: 'ch_1', externalChatId: '42', status: 'connected', createdAt: 1, updatedAt: 1 };
  const extras = {
    bridges: {
      list: () => [], connectTelegram: async () => bridge, disconnect: () => undefined,
      linkOwner: (id: string) => { calls.push(['linkOwner', id]); return code; },
      unlinkOwner: (id: string) => { calls.push(['unlinkOwner', id]); return bridge; },
    },
  } as unknown as RpcExtras;
  const table = createHandlerTable();
  const ctx: HandlerContext = { scope: { kind: 'owner' }, services: {} as RuntimeServices, extras, topics: new Set(), signal: new AbortController().signal };
  const call = async (method: string, params?: unknown) => table.get(method)!.handler(params as never, ctx);
  const device = { kind: 'device', deviceId: 'dev_x', capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'], secure: true } as ClientScope;
  for (const method of ['bridges.linkOwner', 'bridges.unlinkOwner']) {
    assert.ok(allowedScope(table.get(method)!.scope, { kind: 'owner' }), method);
    assert.ok(!allowedScope(table.get(method)!.scope, device), `${method} stays on the PC`);
  }
  assert.deepEqual(await call('bridges.linkOwner', { id: 'br_1' }), code);
  assert.deepEqual(await call('bridges.unlinkOwner', { id: 'br_1' }), bridge);
  assert.deepEqual(calls, [['linkOwner', 'br_1'], ['unlinkOwner', 'br_1']]);
  await assert.rejects(call('bridges.linkOwner', { id: 'br_1', code: 'X' }), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
  await assert.rejects(call('bridges.unlinkOwner', {}), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request');
});

test('a private chat with the bot is the owner\'s without a link; telegram.connect picks the newest private chat', () => {
  assert.equal(privateChatOwner('123456789'), '123456789');
  assert.equal(privateChatOwner(String(GROUP_ID)), undefined);
  assert.equal(privateChatOwner('@channel'), undefined);
  const updates = [
    { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 11, type: 'private', first_name: 'Ana' }, text: 'hi' } },
    { update_id: 2, message: { message_id: 2, date: 0, chat: { id: GROUP_ID, type: 'supergroup', title: 'Team' }, text: 'x' } },
    { update_id: 3, message: { message_id: 3, date: 0, chat: { id: 22, type: 'private', first_name: 'Sam', last_name: 'Owner' }, text: 'hi' } },
  ];
  assert.deepEqual(newestPrivateChat(updates as never), { id: '22', name: 'Sam Owner' });
  assert.equal(newestPrivateChat([]), undefined);
});
