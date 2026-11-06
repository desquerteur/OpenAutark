// Row sync between linked PCs, what B-075 added (devices/sync/rows.ts, tables.ts): a streaming answer travels like
// any message, with its live values; changes that come quickly go once, in their latest state (FLUSH_MS); an answer
// that ends after other lines moves to the end on the other PC too (a fresh seq there); a row naming a stored file
// takes that file's row along (no text cache, no use count); knowledge rows travel without their embedding and a
// removal follows; a plan login a PC found travels as metadata – the other PC gives it its own home, a PC with the
// same login keeps one account – and what else a PC found (an environment key) stays on it; such rows from before
// (never stamped) get their stamp at the next start, so a link with a cursor gets them; a memory file's old version
// travels with its file's event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agent } from '../chat/harness.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { Account } from '../../../src/shared/model/providers.ts';
import type { KnowledgeItem } from '../../../src/shared/model/knowledge.ts';
import type { AccountService, RuntimeServices } from '../../../src/runtime/contracts.ts';
import { ConversationRepo } from '../../../src/runtime/chat/conversation-repo.ts';
import { MessageRepo } from '../../../src/runtime/chat/message-repo.ts';
import { AccountRepo } from '../../../src/runtime/accounts/repo.ts';
import { FileRepo } from '../../../src/runtime/store/files.ts';
import { deleteRows, insertItem } from '../../../src/runtime/knowledge/rows.ts';
import { FLUSH_MS, RowSync } from '../../../src/runtime/devices/sync/rows.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An answer row written straight into the chat (the chat service's own live writes: other tests). */
function answer(pc: Pc, conversationId: string, id: string): Message {
  const message: Message = {
    id, conversationId, seq: 0, authorId: 'ag_mara', authorKind: 'agent', kind: 'text', body: '', attachments: [], mentions: [],
    priority: 'normal', state: 'streaming', silent: false, meta: {}, createdAt: pc.h.clock.now(),
  };
  pc.h.db.tx(() => {
    message.seq = new ConversationRepo(pc.h.db).nextSeq(conversationId, message.createdAt);
    new MessageRepo(pc.h.db).insert(message);
  });
  pc.h.bus.emit('message.created', message);
  return message;
}

function rewrite(pc: Pc, message: Message, patch: Partial<Message>): void {
  Object.assign(message, patch);
  new MessageRepo(pc.h.db).update(message);
  pc.h.bus.emit('message.updated', message);
}

const itemsFor = (net: Net, id: string) => net.calls.flatMap((call) => ((call.params as { items?: Array<{ id: string; row?: Record<string, unknown> }> }).items ?? []).filter((item) => item.id === id));

test('a streaming answer travels with its live values – quick changes once, in their latest state – and moves to the end there when it ends', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a', FLUSH_MS);
  const b = makePc(net, 'dev_b', FLUSH_MS);
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  const live = answer(a, chat.id, 'msg_live');
  for (const note of ['Reading the plan', 'Searching the web', 'Writing']) rewrite(a, live, { body: `${note} …`, meta: { live: { note } } as unknown as Message['meta'] });
  assert.equal(itemsFor(net, 'msg_live').length, 0, 'nothing went yet: the changes gather');
  await wait(FLUSH_MS + 100);
  assert.equal(itemsFor(net, 'msg_live').length, 1, 'the row went once');
  const there = b.h.chats.message('msg_live')!;
  assert.equal(there.state, 'streaming');
  assert.deepEqual([there.body, (there.meta as { live?: { note: string } }).live?.note], ['Writing …', 'Writing'], 'in its latest state');

  b.h.chats.send({ conversationId: chat.id, authorId: 'human', body: 'Und die Kosten?' }); // a line on B while it streams
  await wait(FLUSH_MS + 100);
  rewrite(a, live, { state: 'final', body: 'Der Plan steht.', meta: {} });
  await wait(FLUSH_MS + 100);
  const order = (pc: Pc) => pc.h.chats.messages(chat.id).map((message) => message.body);
  assert.deepEqual(order(b), ['Und die Kosten?', 'Der Plan steht.'], 'the finished answer moved below the line that came while it ran');
  assert.equal(b.h.chats.message('msg_live')!.state, 'final');
});

test('a silent live row (a background run) that ends as the chat\'s last line gets a fresh seq on the other PC too', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a', FLUSH_MS);
  const b = makePc(net, 'dev_b', FLUSH_MS);
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  const live = answer(a, chat.id, 'msg_quiet');
  rewrite(a, live, { silent: true });
  await wait(FLUSH_MS + 100);
  const before = b.h.chats.message('msg_quiet')!.seq;
  rewrite(a, live, { state: 'final', silent: false, body: 'Erledigt.' });
  await wait(FLUSH_MS + 100);
  const after = b.h.chats.message('msg_quiet')!;
  assert.equal(after.state, 'final');
  assert.ok(after.seq > before, `a fresh seq at the end (${before} -> ${after.seq}), so no cursor here has passed it`);
});

test('a row naming a stored file takes the file\'s row along; knowledge rows travel without their embedding, and a removal follows', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  const sha = 'b'.repeat(64);
  const files = new FileRepo(a.h.db);
  files.insert({ id: sha, name: 'plan.pdf', mime: 'application/pdf', size: 1234, createdAt: 5 });
  files.setText(sha, 'the extracted text stays here');
  files.addRefs(sha, 2);
  const chat = a.h.chats.create({ agentIds: [], createdBy: 'human' });
  a.h.chats.send({ conversationId: chat.id, authorId: 'human', body: `Hier der Plan: /files/${sha}` });
  await settle();
  assert.deepEqual({ ...b.h.db.get<Record<string, unknown>>('SELECT id, name, mime, size, text_preview, refs FROM files WHERE id = ?', [sha]) },
    { id: sha, name: 'plan.pdf', mime: 'application/pdf', size: 1234, text_preview: null, refs: 0 }, 'its metadata, not this PC\'s cache or count');

  const item: KnowledgeItem = {
    id: 'kn_1', scope: 'global', kind: 'fact', title: 'Firma', body: 'Die Firma heißt Berger.', tags: [], source: { kind: 'agent', trusted: false },
    confidence: 0.7, pinned: false, recordedAt: 10, createdBy: 'ag_mara', uses: 0,
  };
  insertItem(a.h.db, item);
  a.h.db.run("UPDATE knowledge SET uses = 4, embedding = x'0102' WHERE id = 'kn_1'");
  a.h.bus.emit('knowledge.upserted', item);
  await settle();
  assert.deepEqual({ ...b.h.db.get<Record<string, unknown>>('SELECT body, uses, embedding FROM knowledge WHERE id = ?', ['kn_1']) }, { body: 'Die Firma heißt Berger.', uses: 0, embedding: null });
  assert.ok(b.h.of('knowledge.upserted').some((known) => known.id === 'kn_1'), 'announced there');

  deleteRows(a.h.db, ['kn_1']);
  a.h.bus.emit('knowledge.removed', { ids: ['kn_1'] });
  await settle();
  assert.equal(b.h.db.get('SELECT 1 FROM knowledge WHERE id = ?', ['kn_1']), undefined, 'the removal followed');
});

test('a plan login a PC found travels as metadata: its own home on the other PC, one account where that login is too; an environment key stays', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const c = makePc(net, 'dev_c');
  link(a, b);
  link(a, c);
  for (const pc of [a, b, c]) {
    const repo = new AccountRepo(pc.h.db);
    (pc.h.services as { paths: RuntimeServices['paths'] }).paths = { accounts: path.join('data', pc.id, 'accounts') } as RuntimeServices['paths'];
    pc.h.services.accounts = { get: (id: string) => repo.get(id) } as unknown as AccountService;
  }
  const save = (pc: Pc, account: Account) => { new AccountRepo(pc.h.db).save(account); pc.h.bus.emit('account.upserted', account); };
  const base = { label: 'Codex', state: 'ok', priority: 0, rotation: false, enabled: true, createdAt: 1 } as const;
  save(c, { ...base, id: 'acc_c', provider: 'codex', auth: 'cli', detected: true, email: 'lena@example.com' }); // C found the same login
  save(b, { ...base, id: 'acc_b', provider: 'codex', auth: 'cli', detected: true, email: 'other@example.com' });
  save(a, { ...base, id: 'acc_found', provider: 'codex', auth: 'cli', detected: true, email: 'lena@example.com' });
  save(a, { ...base, id: 'acc_env', provider: 'openai', auth: 'env', envVar: 'OPENAI_API_KEY', detected: true });
  await settle();

  const there = new AccountRepo(b.h.db).get('acc_found');
  assert.equal(there?.home, path.join('data', 'dev_b', 'accounts', 'codex', 'acc_found'), 'B keeps it in its own home for it');
  assert.equal(there?.detected, false, 'there it is no login B found');
  assert.equal(new AccountRepo(c.h.db).get('acc_found'), undefined, 'C has that login itself: one account');
  assert.equal(new AccountRepo(b.h.db).get('acc_env'), undefined, 'an environment key stays on its PC');

  save(b, { ...there!, label: 'Codex Lena' });
  await settle();
  const home = new AccountRepo(a.h.db).get('acc_found')!;
  assert.deepEqual([home.label, home.home, home.detected], ['Codex Lena', undefined, true], 'the new name came back; A keeps its own login where it found it');
});

test('rows that never travelled reach a PC whose link has a cursor (stored files, knowledge, a plan login a PC found); a memory file\'s old version goes with its file', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  (b.h.services as { paths: RuntimeServices['paths'] }).paths = { accounts: path.join('data', 'dev_b', 'accounts') } as RuntimeServices['paths'];
  const sha = 'c'.repeat(64);
  const fact: KnowledgeItem = {
    id: 'kn_old', scope: 'global', kind: 'fact', title: 'Firma', body: 'Die Firma heißt Berger.', tags: [], source: { kind: 'agent', trusted: false },
    confidence: 0.7, pinned: false, recordedAt: 10, createdBy: 'ag_mara', uses: 0,
  };
  // From before these tables travelled: rows on A that no event ever named, so they have no stamp.
  new FileRepo(a.h.db).insert({ id: sha, name: 'logo.png', mime: 'image/png', size: 99, createdAt: 5 });
  insertItem(a.h.db, fact);
  new AccountRepo(a.h.db).save({ id: 'acc_found', label: 'Codex', provider: 'codex', auth: 'cli', detected: true, email: 'lena@example.com', state: 'ok', priority: 0, rotation: false, enabled: true, createdAt: 1 });
  const cursor = a.h.clock.now(); // the link's last complete link-up was after them
  a.h.clock.advance(1000);

  const started = new RowSync(a.h.services, new Stamps(a.h.db, a.h.clock), 0); // the next start of the app
  const off = started.attach();
  assert.equal(await started.catchUp('dev_b', cursor), true);
  assert.equal(b.h.db.get<{ name: string }>('SELECT name FROM files WHERE id = ?', [sha])?.name, 'logo.png', 'the stored file\'s row');
  assert.equal(b.h.db.get<{ body: string }>('SELECT body FROM knowledge WHERE id = ?', ['kn_old'])?.body, 'Die Firma heißt Berger.', 'the knowledge row');
  assert.equal(new AccountRepo(b.h.db).get('acc_found')?.home, path.join('data', 'dev_b', 'accounts', 'codex', 'acc_found'), 'the plan login A found');
  off();
  a.h.clock.advance(1000);
  new RowSync(a.h.services, new Stamps(a.h.db, a.h.clock), 0).attach()();
  assert.deepEqual(new Stamps(a.h.db, a.h.clock).since('', cursor + 1000), [], 'stamped once: the next start stamps nothing again');

  insertItem(a.h.db, { ...fact, id: 'kn_v1', body: 'Die alte Fassung.', expiredAt: 20, supersedes: 'notes:firma.md' });
  a.h.bus.emit('knowledge.upserted', { ...fact, id: 'notes:firma.md', body: 'Die neue Fassung.' }); // the memory file's event
  await settle();
  assert.equal(b.h.db.get<{ supersedes: string }>('SELECT supersedes FROM knowledge WHERE id = ?', ['kn_v1'])?.supersedes, 'notes:firma.md', 'its old version arrived');
});
