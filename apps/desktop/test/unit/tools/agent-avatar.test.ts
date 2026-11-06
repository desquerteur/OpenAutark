// B-044 agent portraits through agents.update avatar.fileId (tools/builtin/agent-avatar.ts): an agent sets
// a portrait for itself or a report only when its OWN run made the image (a Codex image_generation result
// attached to its answer, or a media.image result), PNG/JPEG ≤ 1 MB, never over a photo the person chose
// (no run of the agent made it); an image an agent set may be replaced; the change writes one quiet chat line;
// agents.list shows the avatar kind and colour; the bundled
// skill agent-portrait and the rules line that names it. B-059: a PNG over 1 MB is shrunk to 512 px (a new file).
// Owns: these assertions only. Never: real engines, image generation or blobs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { harness } from '../chat/harness.ts';
import { encodePng, pngSize } from '../../../src/runtime/computer/png.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { agentTools } from '../../../src/runtime/tools/builtin/agents.ts';
import { AVATAR_IMAGE_MAX, madeByRun, personPhoto } from '../../../src/runtime/tools/builtin/agent-avatar.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import type { ModeInfo } from '../../../src/shared/model/knowledge.ts';
import { RESOURCES } from '../store/helpers.ts';
import { parseFrontMatter } from '../../../src/runtime/skills/frontmatter.ts';
import { AGENT_FEATURES_OFF } from '../../../src/runtime/engines/codex/helper-thread.ts';

const MODE = { key: 'manager', name: 'Manager', tools: ['*'] } as unknown as ModeInfo;

function rig() {
  const h = harness();
  const org = new Org({ db: h.db, bus: h.bus, clock: h.clock, templatesDir: path.join(RESOURCES, 'agents') });
  (h.services as unknown as { org: Org }).org = org;
  const manager = org.ensureSeed()!;
  const dev = org.create({ name: 'Dev', role: 'Developer', managerId: manager.id, createdBy: manager.id });
  const chat = h.chats.create({ agentIds: [manager.id, dev.id], createdBy: 'human' });
  const journal = new Journal({ db: h.db, bus: h.bus, clock: h.clock });
  const files = new Map<string, FileRef>();
  Object.assign(h.services, {
    modes: { get: () => MODE },
    permissions: { check: async () => ({ effect: 'allow' }) },
    runs: { item: () => ({ id: 'ri_1' }), updateItem: () => undefined },
    secrets: { redact: (text: string) => text },
    files: { get: (id: string) => files.get(id) },
  });
  const registry = new Registry({ services: () => h.services });
  for (const tool of agentTools) registry.register(tool);
  let calls = 0;
  let made = 0;
  const run = async (agent: Agent, name: string, args: unknown) => {
    const out = await registry.call(name, args, { agent, runId: 'run_now', conversationId: chat.id, mode: 'manager', signal: new AbortController().signal, status: () => {} }, `call_${++calls}`);
    const text = out.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    return { failed: Boolean(out.isError), text };
  };
  /** An image a run of `agentId` made: Codex (attached to its answer in a run with image_generation) or media.image. */
  const portrait = (agentId: string, via: 'codex' | 'media' | 'chat', file: Partial<FileRef> = {}) => {
    const id = (++made).toString(16).padStart(64, 'a');
    files.set(id, { id, name: 'generated-image-1.png', mime: 'image/png', size: 300_000, createdAt: 0, ...file });
    const runId = `run_img_${made}`;
    journal.start({ id: runId, agentId, conversationId: chat.id, trigger: 'message' });
    const attachments = JSON.stringify([{ fileId: id, name: 'generated-image-1.png', mime: 'image/png', size: 300_000 }]);
    if (via === 'media') journal.item(runId, { kind: 'tool_result', name: 'media.image', data: { callId: 'c1', ok: true, preview: `{"ok":true,"fileId":"${id}"}` }, effectStatus: 'none' });
    if (via === 'codex') journal.item(runId, { kind: 'tool_call', name: 'image_generation', data: { own: true }, effectStatus: 'none' });
    if (via !== 'media') {
      // 'chat': the same attachment without an image generation in the run (e.g. chat.send of someone's file)
      const message = via === 'codex' ? h.chats.beginAgentMessage(chat.id, agentId, runId) : h.chats.send({ conversationId: chat.id, body: 'file', authorId: agentId, authorKind: 'agent' });
      if (via === 'codex') h.chats.finishAgentMessage(message.id, { body: 'Here is the portrait.', state: 'final' });
      h.db.run('UPDATE messages SET attachments = ? WHERE id = ?', [attachments, message.id]);
    }
    return id;
  };
  const lines = () => h.chats.messages(chat.id, { limit: 50 }).filter((message) => message.kind === 'status').map((message) => message.body);
  return { h, org, manager, dev, chat, files, run, portrait, lines };
}

test('an agent sets its own portrait from its Codex image; one quiet line', async () => {
  const { h, org, manager, run, portrait, lines } = rig();
  const id = portrait(manager.id, 'codex');
  assert.equal(madeByRun(h.db, manager.id, id), true);
  const out = await run(manager, 'agents.update', { avatar: { fileId: id, color: 2 } });
  assert.equal(out.failed, false, out.text);
  assert.deepEqual(org.get(manager.id)!.avatar, { kind: 'image', value: id, color: 2 });
  assert.deepEqual(lines().filter((line) => line.startsWith('New portrait')), [`New portrait for ${manager.name}.`]);
  assert.equal(personPhoto(h.db, org.get(manager.id)!), false, 'an agent set it');
});

test('a manager sets a report\'s portrait from its own media.image result; never from someone else\'s run', async () => {
  const { org, manager, dev, run, portrait } = rig();
  const mine = portrait(manager.id, 'media');
  assert.equal((await run(manager, 'agents.update', { agentId: dev.id, avatar: { fileId: mine }, reason: 'Team portrait' })).failed, false);
  assert.equal(org.get(dev.id)!.avatar.value, mine);

  const theirs = portrait(dev.id, 'codex');
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: theirs } })).text, /my own run made/);
  const forwarded = portrait(manager.id, 'chat');
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: forwarded } })).text, /my own run made/, 'an attachment without image generation');
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: 'b'.repeat(64) } })).text, /my own run made/);
});

test('only PNG or JPEG up to 1 MB', async () => {
  const { manager, run, portrait } = rig();
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: portrait(manager.id, 'codex', { mime: 'image/webp' }) } })).text, /PNG or JPEG/);
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: portrait(manager.id, 'codex', { size: AVATAR_IMAGE_MAX + 1 }) } })).text, /at most 1 MB/);
  assert.equal((await run(manager, 'agents.update', { avatar: { fileId: portrait(manager.id, 'codex', { mime: 'image/jpeg', size: AVATAR_IMAGE_MAX }) } })).failed, false);
});

test('B-059 #45: a PNG portrait over 1 MB is shrunk to 512 px and stored as a new file; a JPEG over 1 MB is still refused', async () => {
  const { h, org, manager, files, run, portrait } = rig();
  const big = encodePng({ width: 800, height: 800, channels: 3, pixels: new Uint8Array(randomBytes(800 * 800 * 3)) });
  assert.ok(big.byteLength > AVATAR_IMAGE_MAX, 'the generated PNG is over 1 MB');
  const stored = new Map<string, Uint8Array>();
  const id = portrait(manager.id, 'codex', { size: big.byteLength });
  stored.set(id, big);
  Object.assign(h.services.files as object, {
    read: async (fileId: string) => { const data = stored.get(fileId); if (!data) throw new Error('missing'); return data; },
    put: async (data: Uint8Array, name: string, mime?: string) => {
      const ref: FileRef = { id: 'e'.repeat(64), name, mime: mime ?? 'application/octet-stream', size: data.byteLength, createdAt: 0 };
      stored.set(ref.id, data);
      files.set(ref.id, ref);
      return ref;
    },
  });
  const out = await run(manager, 'agents.update', { avatar: { fileId: id } });
  assert.equal(out.failed, false, out.text);
  const avatar = org.get(manager.id)!.avatar;
  assert.equal(avatar.kind, 'image');
  assert.equal(avatar.value, 'e'.repeat(64), 'the shrunk copy, not the original');
  const small = stored.get(avatar.value)!;
  assert.ok(small.byteLength <= AVATAR_IMAGE_MAX);
  assert.deepEqual(pngSize(small), { width: 512, height: 512 });
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: portrait(manager.id, 'codex', { mime: 'image/jpeg', size: AVATAR_IMAGE_MAX + 1 }) } })).text, /at most 1 MB/);
});

test('never over a photo the person chose; an image an agent set may be replaced', async () => {
  const { h, org, manager, dev, run, portrait } = rig();
  const photo = 'c'.repeat(64);
  org.update(dev.id, { avatar: { kind: 'image', value: photo } }); // the person's choice (Team › agent)
  assert.equal(personPhoto(h.db, org.get(dev.id)!), true);
  const mine = portrait(manager.id, 'codex');
  assert.match((await run(manager, 'agents.update', { agentId: dev.id, avatar: { fileId: mine }, reason: 'Portrait' })).text, /photo the person chose/);
  assert.match((await run(manager, 'agents.update', { agentId: dev.id, avatar: { emoji: '🎬' }, reason: 'Emoji' })).text, /photo the person chose/);
  assert.equal(org.get(dev.id)!.avatar.value, photo);

  assert.equal((await run(manager, 'agents.update', { avatar: { fileId: mine } })).failed, false);
  assert.equal((await run(manager, 'agents.update', { avatar: { color: 4 } })).failed, false, 'a colour keeps the portrait');
  assert.deepEqual(org.get(manager.id)!.avatar, { kind: 'image', value: mine, color: 4 });
  assert.equal((await run(manager, 'agents.update', { avatar: { emoji: '' } })).failed, false);
  assert.equal(org.get(manager.id)!.avatar.kind, 'initials');
  assert.match((await run(manager, 'agents.update', { avatar: { fileId: mine, emoji: '🙂' } })).text, /either avatar\.fileId or avatar\.emoji/);
});

test('an image no run of the agent made counts as the person\'s photo', () => {
  const { h, org, dev } = rig();
  const hired = { ...org.get(dev.id)!, avatar: { kind: 'image' as const, value: 'd'.repeat(64) } };
  assert.equal(personPhoto(h.db, hired), true);
});

test('the bundled skill agent-portrait; the core rules no longer name it (B-047)', () => {
  const parsed = parseFrontMatter(readFileSync(path.join(RESOURCES, 'skills', 'agent-portrait', 'SKILL.md'), 'utf8'));
  assert.equal(parsed.data.name, 'agent-portrait');
  assert.ok(String(parsed.data.description).length <= 1024);
  assert.match(parsed.body, /A photo the person chose stays/);
  assert.match(parsed.body, /No text, letters, logos/);
  assert.match(parsed.body, /Square, 512 x 512 px/);
  // Owner 29.10.: agent threads on Codex keep Codex's image generation – the skill names it beside media.image.
  assert.ok(!AGENT_FEATURES_OFF.includes('image_generation'));
  assert.match(parsed.body, /agent turns on Codex have Codex's image generation/);
  assert.match(parsed.body, /`media\.image`/);
  // B-047 (D6): the core rules no longer carry the portrait line; the skill is found through the skills index.
  assert.ok(!readFileSync(path.join(RESOURCES, 'prompts', 'rules.md'), 'utf8').includes('agent-portrait'));
});

test('agents.list shows each agent\'s avatar kind and palette colour', async () => {
  const { manager, run } = rig();
  const listed = JSON.parse((await run(manager, 'agents.list', {})).text) as Array<{ id: string; avatar: string; color: number }>;
  const me = listed.find((entry) => entry.id === manager.id)!;
  assert.equal(me.avatar, 'initials');
  assert.ok(Number.isInteger(me.color) && me.color >= 0 && me.color <= 5);
});
