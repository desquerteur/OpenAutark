// B-058 T6 (G7): ACP agents that declare the `audio` prompt capability get recordings as ACP audio blocks
// { type: 'audio', mimeType, data } (agentclientprotocol.com/protocol/content); others keep the file link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseAgentInfo } from '../../../src/runtime/engines/acp/protocol.ts';
import { promptBlocks } from '../../../src/runtime/engines/acp/turn.ts';
import type { TurnInputItem } from '../../../src/runtime/engines/types.ts';
import { hearsAudio } from '../../../src/runtime/decision/engine-runner.ts';
import { account } from './fakes.ts';
import { setup } from './acp-fixture.ts';

test('B-058 i1: an agent that declares audio lists its models with audioIn (a listener); others do not', async () => {
  const configOptions = [{ id: 'model', category: 'model', type: 'select', currentValue: 'pro', options: [{ value: 'pro', name: 'Pro' }, { value: 'flash', name: 'Flash' }] }];
  const hearing = setup({ session: { configOptions }, init: { agentCapabilities: { promptCapabilities: { image: true, audio: true }, mcpCapabilities: { http: true } } } });
  const models = await hearing.engine.listModels(account());
  assert.deepEqual(models.map((m) => [m.model, m.audioIn]), [['pro', true], ['flash', true]]);
  assert.deepEqual((await hearing.engine.listModels(account())).map((m) => m.audioIn), [true, true], 'the remembered offer keeps it');
  assert.equal(hearsAudio({ engine: 'acp', model: 'pro', caps: { audioIn: models[0].audioIn } } as any), true);
  await hearing.engine.dispose();
  const deaf = setup();
  const plain = await deaf.engine.listModels(account());
  assert.deepEqual(plain.map((m) => [m.model, m.audioIn]), [['default', false]]);
  assert.equal(hearsAudio({ engine: 'acp', model: 'default', caps: { audioIn: plain[0].audioIn } } as any), false);
  await deaf.engine.dispose();
});

test('initialize: promptCapabilities.audio is read (Gemini CLI declares image, audio, embeddedContext)', () => {
  const info = parseAgentInfo({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true, audio: true, embeddedContext: true } } });
  assert.deepEqual([info.images, info.audio], [true, true]);
  assert.equal(parseAgentInfo({ agentCapabilities: { promptCapabilities: { image: true } } }).audio, false);
  assert.equal(parseAgentInfo({}).audio, false);
});

test('promptBlocks: audio blocks when declared, the link otherwise; unreadable or too large recordings degrade', async () => {
  const bytes = Buffer.from('RIFF....WAVEfmt ');
  const item: TurnInputItem = { type: 'audio', path: 'C:/blobs/take.wav', name: 'take.wav', mime: 'audio/wav', text: 'Listen closely.' };
  const read = async () => bytes;
  assert.deepEqual(await promptBlocks([item], true, undefined, read, true), [
    { type: 'audio', mimeType: 'audio/wav', data: bytes.toString('base64') },
    { type: 'text', text: 'Listen closely.' },
  ]);
  const plain: TurnInputItem = { ...item, text: undefined };
  const [link] = await promptBlocks([plain], true, undefined, read);
  assert.equal(link.type, 'resource_link');
  assert.deepEqual(await promptBlocks([plain], true, undefined, async () => { throw new Error('gone'); }, true), [{ type: 'text', text: '[audio unavailable: take.wav]' }]);
  const [large] = await promptBlocks([plain], true, undefined, async () => new Uint8Array(20 * 1024 * 1024 + 1), true);
  assert.equal(large.type, 'resource_link', 'over 20 MB: the file link (Gemini CLI reads at most 20 MB per file)');
});

test('review: a recording over 20 MB on disk goes as its link without being read into memory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acp-audio-'));
  try {
    const file = path.join(dir, 'long.webm');
    await writeFile(file, '');
    await truncate(file, 20 * 1024 * 1024 + 1);
    const item: TurnInputItem = { type: 'audio', path: file, name: 'long.webm', mime: 'audio/webm' };
    let reads = 0;
    const [block] = await promptBlocks([item], true, undefined, async () => { reads += 1; return new Uint8Array(0); }, true);
    assert.deepEqual([block.type, block.name, reads], ['resource_link', 'long.webm', 0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
