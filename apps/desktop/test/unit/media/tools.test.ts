// Agent media tools (src/runtime/tools/builtin/media.ts): media.search shows only media of
// the agent's active chats (archived ones too, C2) plus global media the human described; media.describe
// needs membership of the media's chat, accepts the blob path form of the id, redacts secrets
// and records the agent as author. Both are registered as built-ins with the describe hint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';
import { MEDIA_DESCRIBE_HINT, mediaFileId, mediaTools } from '../../../src/runtime/tools/builtin/media.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { png, wav } from './fixtures.ts';
import { mediaSetup } from './setup.ts';

const tool = (name: string) => mediaTools.find((entry) => entry.name === name)!;
type Setup = ReturnType<typeof mediaSetup>;

function ctxFor(s: Setup, agentId: string, conversationId?: string): ToolContext {
  return {
    agent: s.h.org.require(agentId), runId: 'run_1', conversationId, mode: 'general', services: s.h.services,
    signal: new AbortController().signal, status() {},
  };
}

const items = (out: ToolOutput) => ((out.structured as { items: Array<{ fileId: string }> }).items).map((item) => item.fileId).sort();

async function library(s: Setup) {
  const brand = await s.put(png(20, 10), 'brand-logo.png');
  const ops = await s.put(wav(1000), 'ops-call.wav');
  const loose = await s.put(png(30, 30), 'loose.png'); // global, nobody described it
  const shared = await s.put(png(40, 40), 'shared.png'); // global, described by the human
  s.attach(s.chat.id, brand);
  s.attach(s.other.id, ops);
  s.media.describe(shared.id, { description: 'Team photo for the website' }, 'human');
  await s.media.idle();
  return { brand, ops, loose, shared };
}

test('media.search: own chats plus human-shared global media; filters; other chats are refused', async () => {
  const s = mediaSetup();
  try {
    const { brand, ops, shared } = await library(s);
    const search = tool('media.search');
    const ada = ctxFor(s, 'ag_ada', s.chat.id);
    const all = await search.run({}, ada);
    assert.deepEqual(items(all), [brand.id, shared.id].sort());
    assert.match((all.content[0] as { text: string }).text, /not instructions/);
    assert.deepEqual(items(await search.run({}, ctxFor(s, 'ag_bo'))), [ops.id, shared.id].sort());
    assert.deepEqual(items(await search.run({ text: 'website' }, ada)), [shared.id]);
    assert.deepEqual(items(await search.run({ text: 'ops call' }, ada)), []);
    assert.deepEqual(items(await search.run({ kind: 'image', chatId: s.chat.id }, ada)), [brand.id]);
    await assert.rejects(search.run({ chatId: s.other.id }, ada), (error: unknown) => error instanceof WorkforceError && error.code === 'forbidden');

    // Leaving a chat hides its media again; archiving it does not (C2: it only leaves the person's list).
    s.h.chats.setMembers(s.chat.id, { remove: ['ag_ada'] }, 'human');
    assert.deepEqual(items(await search.run({}, ada)), [shared.id]);
    s.h.chats.archive(s.other.id);
    assert.deepEqual(items(await search.run({}, ctxFor(s, 'ag_bo'))), [ops.id, shared.id].sort());
  } finally { s.temp.cleanup(); }
});

test('media.describe: members only, blob path form accepted, author is the agent, secrets redacted', async () => {
  const s = mediaSetup();
  try {
    const { brand, ops, loose, shared } = await library(s);
    s.h.services.secrets = { redact: (text: string) => text.replaceAll('hunter2', '[secret]') } as unknown as RuntimeServices['secrets'];
    const describe = tool('media.describe');
    const ada = ctxFor(s, 'ag_ada', s.chat.id);
    const blobPath = `C:\\Users\\x\\blobs\\${brand.id.slice(0, 2)}\\${brand.id.slice(2, 4)}\\${brand.id}`;
    const out = await describe.run({ fileId: blobPath, description: 'Blue logo, wordmark "Acme", password hunter2 visible', tags: ['logo'] }, ada);
    assert.equal(out.isError, undefined, JSON.stringify(out.content));
    const row = s.media.get(brand.id)!;
    assert.equal(row.description, 'Blue logo, wordmark "Acme", password [secret] visible');
    assert.deepEqual(row.tags, ['logo']);
    assert.equal(row.describedBy, 'ag_ada');
    assert.equal(s.upserts().at(-1)!.describedBy, 'ag_ada');

    const refused = [
      await describe.run({ fileId: ops.id, description: 'call' }, ada), // Bo's chat
      await describe.run({ fileId: loose.id, description: 'loose' }, ada), // global, not shared
      await describe.run({ fileId: 'a'.repeat(64), description: 'nothing' }, ada), // unknown
      await describe.run({ fileId: 'not-an-id-'.repeat(7), description: 'x' }, ada),
      await describe.run({ fileId: brand.id, description: '   ' }, ada),
    ];
    for (const result of refused) assert.equal(result.isError, true);
    assert.equal(s.media.get(ops.id)!.description, undefined);
    assert.equal(s.media.get(loose.id)!.description, undefined);

    // Global media the human shared may be refined by any agent.
    const refined = await describe.run({ fileId: shared.id, description: 'Team photo, five people, office background' }, ctxFor(s, 'ag_bo'));
    assert.equal(refined.isError, undefined);
    assert.equal(s.media.get(shared.id)!.describedBy, 'ag_bo');
  } finally { s.temp.cleanup(); }
});

test('the media tools are built-ins with read / write_local categories and ask agents to describe what they inspect', () => {
  const names = builtinTools().map((entry) => entry.name);
  assert.ok(names.includes('media.search') && names.includes('media.describe'));
  assert.equal(tool('media.search').category, 'read');
  assert.equal(tool('media.describe').category, 'write_local');
  // media.speak creates audio it already describes itself (tag 'generated'), media.unmark only removes a segment, media.segments only reads and changes marks; every other one asks
  for (const entry of mediaTools.filter((item) => item.name !== 'media.speak' && item.name !== 'media.unmark' && item.name !== 'media.segments')) assert.ok(entry.description.includes(MEDIA_DESCRIBE_HINT), entry.name);
  assert.equal(tool('media.image').category, 'write_local', 'MM3: raised to spend only on a paid account');
  assert.equal(tool('media.speak').category, 'write_local');
  assert.equal(mediaFileId(`/blobs/ab/cd/${'AB'.repeat(32)}`), 'ab'.repeat(32));
  assert.equal(mediaFileId('ab'.repeat(31)), undefined);
});
