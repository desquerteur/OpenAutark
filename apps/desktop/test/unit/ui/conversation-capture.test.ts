// The voice conversation's capture and self barge-in (src/ui/chat/composer/conversation-audio.ts,
// src/ui/lib/barge-in.ts, shared/voice/conversation.ts bargeIn): the level detector cuts a take and hands its
// upload to the loop; a take is dropped when the loop moves on; nothing is taken while this device reads aloud
// (echo guard); with echo cancellation on, a voice clearly above the reading's echo, held long enough, stops this
// device's own reading and is taken at once – a cough, the echo itself or a microphone without echo cancellation
// never does; the loop stops reading and listens.
// Owns: these assertions only. Never: a real microphone, recorder or speech engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../../src/shared/model/chat.ts';
import { VoiceSessions } from '../../../src/shared/voice/conversation.ts';
import type { VoiceSessionView } from '../../../src/shared/voice/conversation.ts';
import { ConversationCapture, type RecorderLike } from '../../../src/ui/chat/composer/conversation-audio.ts';
import { BargeInDetector, echoCancelled } from '../../../src/ui/lib/barge-in.ts';

const BLOCK_MS = 85;
const block = (level: number) => new Float32Array(4096).fill(level);

class FakeRecorder implements RecorderLike {
  state: RecorderLike['state'] = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  start(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['voice']) } as BlobEvent);
    this.onstop?.(new Event('stop'));
  }
}

function rig(options: { aec?: boolean; bargeIn?: () => boolean; speaking?: () => boolean } = {}) {
  let now = 0;
  let feed: ((samples: Float32Array, rate: number) => void) | undefined;
  const recorders: FakeRecorder[] = [];
  const utterances: string[] = [];
  const barged: string[] = [];
  const stream = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: options.aec === true }) }] } as unknown as MediaStream;
  const capture = new ConversationCapture({
    utterance: async (_id, fileId) => { utterances.push(fileId); },
    ...(options.bargeIn ? { bargeIn: (id: string) => { barged.push(id); return options.bargeIn!(); } } : {}),
  }, () => undefined, {
    openMicrophone: async (listener) => { feed = listener; return { stream, close: () => undefined }; },
    newRecorder: () => { const recorder = new FakeRecorder(); recorders.push(recorder); return recorder; },
    upload: async () => ({ id: 'file_1' }),
    now: () => now,
    speaking: options.speaking,
  });
  const run = (level: number, ms: number) => { for (let t = 0; t < ms; t += BLOCK_MS) { now += BLOCK_MS; feed!(block(level), 48_000); } };
  const view = (status: VoiceSessionView['status']) => capture.follow({ id: 'mic_1', conversationId: 'ch_a', status });
  return { capture, run, view, recorders, utterances, barged, tick: () => new Promise<void>((resolve) => setImmediate(resolve)) };
}

test('a take starts at the first sound, ends after the silence and goes to the loop; a take the loop moved past is dropped', async () => {
  const r = rig();
  await r.capture.open();
  r.view('listening');
  r.run(0, 300);
  assert.equal(r.recorders.length, 0);
  r.run(0.3, 200);
  assert.equal(r.recorders[0].state, 'recording', 'started at the start edge');
  r.view('transcribing'); // the loop moved on: the take is dropped
  r.run(0.3, 100);
  assert.equal(r.recorders[0].state, 'inactive');
  r.view('listening');
  r.run(0.3, 200);
  r.run(0, 1400); // the end edge: the utterance goes to the loop
  await r.tick();
  assert.deepEqual(r.utterances, ['file_1'], 'only the finished take, never the dropped one');
  r.capture.close();
});

test('the capture takes nothing while this device reads aloud (echo guard)', async () => {
  let speaking = true;
  const r = rig({ speaking: () => speaking });
  await r.capture.open();
  r.view('listening');
  r.run(0.5, 600);
  assert.equal(r.recorders.length, 0, 'silence while another line is read');
  speaking = false;
  r.run(0.5, 300);
  assert.equal(r.recorders.length, 1, 'the person is heard again');
  r.capture.close();
});

test('self barge-in: only with echo cancellation, only above the echo, only when held', async () => {
  const r = rig({ aec: true, bargeIn: () => true });
  await r.capture.open();
  r.view('speaking');
  r.run(0.05, 700); // the reading's echo (warm-up and after)
  r.run(0.3, 170); // a cough
  r.run(0.05, 300);
  assert.deepEqual(r.barged, [], 'no barge-in from the echo or a cough');
  r.run(0.4, 450);
  assert.deepEqual(r.barged, ['mic_1'], 'a held voice clearly above the echo');
  assert.equal(r.recorders.length, 1);
  assert.equal(r.recorders[0].state, 'recording', 'taken at once, without the echo tail');
  r.view('listening'); // the loop stopped reading
  r.run(0.4, 200);
  r.run(0, 1400);
  await r.tick();
  assert.deepEqual(r.utterances, ['file_1'], 'the words said over the reading go out');

  const plain = rig({ aec: false, bargeIn: () => true });
  await plain.capture.open();
  plain.view('speaking');
  plain.run(0.05, 700);
  plain.run(0.5, 900);
  assert.deepEqual([plain.barged, plain.recorders.length], [[], 0], 'without echo cancellation the echo guard stays');

  const refused = rig({ aec: true, bargeIn: () => false });
  await refused.capture.open();
  refused.view('speaking');
  refused.run(0.05, 700);
  refused.run(0.5, 900);
  assert.equal(refused.barged.length > 0 && refused.recorders.length === 0, true, 'nothing of the loop was read: no take');
});

test('the barge-in detector learns the echo and wants a held voice above it', () => {
  const detector = new BargeInDetector({ ratio: 3, minLevel: 0.06, holdMs: 350, warmMs: 600 });
  let now = 0;
  const feed = (level: number, ms: number) => { let fired = false; for (let t = 0; t < ms; t += BLOCK_MS) { now += BLOCK_MS; fired = detector.feed(level, now) || fired; } return fired; };
  assert.equal(feed(0.1, 600), false, 'warm-up only learns');
  assert.equal(feed(0.25, 170), false, 'below three times the echo');
  assert.equal(feed(0.1, 85), false);
  assert.equal(feed(0.5, 255), false, 'not held long enough');
  assert.equal(feed(0.1, 85), false, 'a quiet block starts it over');
  assert.equal(feed(0.5, 500), true);
  detector.stop();
  assert.equal(feed(0.5, 300), false, 'a new reading warms up again');
  assert.equal(echoCancelled(undefined), false);
  assert.equal(echoCancelled({ getAudioTracks: () => { throw new Error('gone'); } } as unknown as MediaStream), false);
});

test('the loop stops its own reading on a barge-in and listens', async () => {
  const views: Array<VoiceSessionView | null> = [];
  let silenced = 0;
  const spoken: string[] = [];
  let onMessage: ((message: Message) => void) | undefined;
  let ids = 0;
  const sessions = new VoiceSessions({
    rpc: {
      call: (async (method: string) => (method === 'chats.get' ? { id: 'ch_a', title: 'Plan' } : method === 'voice.transcribe' ? { text: 'Tell me the plan' } : method === 'messages.send' ? { id: 'm1', seq: 1 } : { ok: true })) as never,
      on: ((event: string, listener: (message: Message) => void) => { if (event === 'message.created') onMessage = listener; return () => undefined; }) as never,
      subscribe: async () => () => undefined,
    },
    publish: (view) => { views.push(view); },
    speak: (_id, text) => { spoken.push(text); },
    silence: () => { silenced += 1; },
    newId: () => `id_${++ids}`,
    after: () => () => undefined,
  });
  const view = await sessions.start('ch_a');
  assert.equal(sessions.bargeIn(view.id), false, 'nothing is read yet');
  await sessions.utterance(view.id, 'file_1');
  onMessage!({ id: 'r1', conversationId: 'ch_a', seq: 2, authorId: 'ag_ava', authorKind: 'agent', kind: 'text', body: 'Here is the long plan.', state: 'final', silent: false, meta: {} } as unknown as Message);
  assert.equal(sessions.view()?.status, 'speaking');
  assert.equal(sessions.bargeIn('other'), false, 'another microphone');
  assert.equal(sessions.bargeIn(view.id), true);
  assert.deepEqual([silenced, sessions.view()?.status], [1, 'listening']);
  assert.deepEqual(spoken, ['Here is the long plan.']);
});
