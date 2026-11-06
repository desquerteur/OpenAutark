// B-058 T6 (G7): Codex models that report audio input are listed with audioIn and get recordings as `localAudio`;
// every other model keeps today's text line. The owner's plan models were text+image only on 29.10.2026 (live
// model/list), so these run against a fake app server answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexHearsAudio, listCodexModels } from '../../../src/runtime/engines/codex/reads.ts';
import { codexInput } from '../../../src/runtime/engines/codex/turn.ts';
import type { TurnInputItem } from '../../../src/runtime/engines/types.ts';

const page = (models: unknown[]) => ({ request: async () => ({ data: models, nextCursor: null }) }) as never;
const model = (id: string, inputModalities?: string[]) => ({ model: id, displayName: id, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], ...(inputModalities ? { inputModalities } : {}) });

test('model/list: inputModalities with audio → audioIn true and remembered; without → false; not reported → unknown', async () => {
  const listed = await listCodexModels(page([model('gpt-7-ear', ['text', 'image', 'audio']), model('gpt-6-luna', ['text', 'image']), model('old')]), new Map());
  assert.deepEqual(listed.map((entry) => [entry.model, entry.audioIn, entry.vision]), [['gpt-7-ear', true, true], ['gpt-6-luna', false, true], ['old', undefined, true]]);
  assert.equal(codexHearsAudio('gpt-7-ear'), true);
  assert.equal(codexHearsAudio('gpt-6-luna'), false);
  assert.equal(codexHearsAudio('old'), false);
  // A later listing without audio forgets it.
  await listCodexModels(page([model('gpt-7-ear', ['text'])]), new Map());
  assert.equal(codexHearsAudio('gpt-7-ear'), false);
});

test('codexInput: a recording goes as localAudio (its text after it) only when the model hears audio', () => {
  const input: TurnInputItem[] = [{ type: 'text', text: 'What plays?' }, { type: 'audio', path: 'C:/blobs/song', name: 'song.mp3', mime: 'audio/mpeg', text: 'Transcript excerpt.' }];
  assert.deepEqual(codexInput(input, true), [
    { type: 'text', text: 'What plays?', text_elements: [] },
    { type: 'localAudio', path: 'C:/blobs/song' },
    { type: 'text', text: 'Transcript excerpt.', text_elements: [] },
  ]);
  assert.deepEqual(codexInput(input)[1], { type: 'text', text: '[file: song.mp3 (audio/mpeg) at C:/blobs/song]\nTranscript excerpt.', text_elements: [] });
  assert.deepEqual(codexInput([{ type: 'file', path: 'C:/a.pdf', name: 'a.pdf', mime: 'application/pdf' }], true), [{ type: 'text', text: '[file: a.pdf (application/pdf) at C:/a.pdf]', text_elements: [] }]);
});
