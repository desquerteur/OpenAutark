// The page's voice conversation (ui/chat/composer/pwa-conversation.ts – one loop on the desktop window and the
// phone): the microphone opens first (inside the tap), the level detector cuts an utterance → it is uploaded →
// voice.transcribe (profile language) → messages.send marked spoken live → the reply is read aloud → listening
// again; nothing is taken while the reply is spoken and right after it (echo guard); the screen is kept on and
// everything is released when the page is hidden; a later chat joins the open microphone; stopping or tapping
// again while it starts leaves no hidden session. Replies are read with the reading voice and the profile
// language; "Start conversation" is offered where this connection may transcribe and send and the page can record.
// Owns: these assertions only. Never: a real microphone, recorder, speech engine or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import type { VoiceSessionEntry, VoiceSessionView } from '../../../src/shared/voice/conversation.ts';
import { spokenMeta } from '../../../src/shared/voice/conversation.ts';
import { ECHO_TAIL_MS, browserSpeech } from '../../../src/ui/chat/composer/conversation-audio.ts';
import { PageConversation } from '../../../src/ui/chat/composer/pwa-conversation.ts';
import type { PageConversationDeps } from '../../../src/ui/chat/composer/pwa-conversation.ts';
import { conversationAvailable } from '../../../src/ui/chat/composer/voice.ts';
import { session } from '../../../src/ui/lib/session.ts';

class FakeRecorder {
  static made: FakeRecorder[] = [];
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { FakeRecorder.made.push(this); }
  start(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }) });
    queueMicrotask(() => this.onstop?.());
  }
}

const tick = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const loud = new Float32Array(512).fill(0.2);
const silent = new Float32Array(512);

function setup(options: { microphone?: string; uploadFails?: boolean; holdMic?: boolean; holdChat?: boolean; noChat?: boolean; language?: string } = {}) {
  FakeRecorder.made = [];
  const log: string[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const observers: Array<(message: Message) => void> = [];
  const views: Array<VoiceSessionView | null> = [];
  const chats: VoiceSessionEntry[][] = [];
  const errors: Array<string | undefined> = [];
  const speaking: Array<{ text: string; done: () => void }> = [];
  const hide: Array<() => void> = [];
  let feed: ((samples: Float32Array, rate: number) => void) | null = null;
  const heldMics: Array<() => void> = [];
  const heldChats: Array<() => void> = [];
  let clock = 1000;
  let seq = 0;
  let ids = 0;
  const deps: PageConversationDeps = {
    rpc: {
      call: (async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params: params ?? {} });
        log.push(method);
        if (method === 'chats.get' && options.holdChat) await new Promise<void>((resolve) => { heldChats.push(resolve); });
        if (method === 'chats.get') { if (options.noChat) throw new Error('Chat not found.'); return { id: params?.id, title: `Chat ${String(params?.id)}` }; }
        if (method === 'voice.transcribe') return { text: 'Call Teydra tomorrow' };
        if (method === 'calls.start') return { callId: `call_${String(params?.conversationId)}` };
        if (method === 'messages.send') return { id: `msg_${++seq}`, seq, conversationId: params?.conversationId };
        return { ok: true };
      }) as PageConversationDeps['rpc']['call'],
      on: ((_event: string, listener: (message: Message) => void) => { observers.push(listener); return () => {}; }) as PageConversationDeps['rpc']['on'],
    },
    holdTopic: (topic) => { log.push(`hold ${topic}`); return () => log.push(`release ${topic}`); },
    capture: {
      openMicrophone: async (onSamples) => {
        log.push('microphone');
        if (options.holdMic) await new Promise<void>((resolve) => { heldMics.push(resolve); });
        feed = onSamples;
        return { stream: {} as MediaStream, close: () => log.push('microphone closed') };
      },
      newRecorder: () => new FakeRecorder() as never,
      upload: async (blob, name) => {
        log.push(`upload ${name} ${blob.size}`);
        if (options.uploadFails) throw new Error('Upload failed: the connection dropped.');
        return { id: 'f'.repeat(64) };
      },
      now: () => clock,
    },
    speech: { speak: (text, done) => { speaking.push({ text, done }); }, cancel: () => log.push('speech cancelled') },
    wakeLock: async () => { log.push('wake lock'); return { release: () => log.push('wake lock released') }; },
    onHide: (listener) => { hide.push(listener); return () => log.push('hide listener removed'); },
    microphoneProblem: () => options.microphone,
    language: () => options.language,
    publish: (view, error, list) => { views.push(view ? { ...view } : null); chats.push(list); if (!view) errors.push(error); },
    after: () => () => {},
    newId: () => `id_${++ids}`,
  };
  const conversation = new PageConversation(deps);
  const samples = (block: Float32Array, at: number) => { clock = at; feed?.(block, 48_000); };
  const reply = (conversationId: string, body: string) => {
    const message = { id: `reply_${++seq}`, conversationId, seq: seq + 100, authorId: 'ag_tom', authorKind: 'agent', kind: 'text', body, state: 'final', silent: false, meta: {} } as unknown as Message;
    for (const observe of observers) observe(message);
  };
  const sends = () => calls.filter((call) => call.method === 'messages.send').map((call) => call.params);
  const release = (held: Array<() => void>) => () => { for (const resolve of held.splice(0)) resolve(); };
  return { conversation, log, calls, sends, views, chats, errors, speaking, hide, samples, reply, releaseMic: release(heldMics), releaseChat: release(heldChats), now: () => clock };
}

test('one utterance: microphone first, then record → upload → voice.transcribe (profile language) → messages.send marked spoken live', async () => {
  const f = setup({ language: 'de-DE' });
  const view = await f.conversation.start('ch_1');
  await tick();
  assert.deepEqual(view, { id: 'id_2', conversationId: 'ch_1', status: 'listening' });
  assert.deepEqual(f.log.slice(0, 4), ['microphone', 'wake lock', 'chats.get', 'hold chat:ch_1'], 'the microphone opens inside the tap, before any round trip');
  assert.equal(f.conversation.active, true);

  f.samples(loud, 1100);
  assert.equal(FakeRecorder.made.length, 1, 'speech starts a take');
  f.samples(loud, 1500);
  f.samples(silent, 2700); // more than 1.1 s of silence ends the utterance
  await tick();
  assert.ok(f.log.includes('upload Utterance.webm 3'));
  assert.deepEqual(f.calls.find((call) => call.method === 'voice.transcribe')?.params, { fileId: 'f'.repeat(64), language: 'de-DE' }, 'the hint the composer\'s dictation gives too');
  assert.deepEqual(f.sends(), [{ conversationId: 'ch_1', body: 'Call Teydra tomorrow', clientId: 'id_3', speech: { ...spokenMeta(true), call: 'call_ch_1' } }], 'a line of the call of the chat');
  assert.equal(f.chats.at(-1)?.[0]?.status, 'responding');

  f.samples(loud, 3000);
  f.samples(silent, 4500);
  await tick();
  assert.equal(f.calls.filter((call) => call.method === 'messages.send').length, 2, 'speech while the reply is awaited goes out at once');
  f.conversation.stop();
  assert.equal(f.calls.filter((call) => call.method === 'messages.stop').length, 0, 'ending never stops agent work (21.10. 17:09)');
  assert.deepEqual(f.calls.filter((call) => call.method === 'calls.end').map((call) => call.params), [{ callId: 'call_ch_1' }], 'ending ends the call');
});

test('the reply is read aloud; its sound and tail are not taken for the person (echo guard), then listening again', async () => {
  const f = setup();
  await f.conversation.start('ch_1');
  f.samples(loud, 1100);
  f.samples(silent, 2400);
  await tick();
  f.reply('ch_1', 'Sure, **tomorrow** at ten.');
  assert.deepEqual(f.speaking.map((entry) => entry.text), ['Sure, tomorrow at ten.']);
  assert.equal(f.views.at(-1)?.status, 'speaking');

  f.samples(loud, 3000);
  f.samples(loud, 3400);
  assert.equal(FakeRecorder.made.length, 1, 'the speaker is not recorded');

  f.speaking[0].done();
  assert.equal(f.views.at(-1)?.status, 'listening');
  const doneAt = f.now();
  f.samples(loud, doneAt + ECHO_TAIL_MS - 100);
  assert.equal(FakeRecorder.made.length, 1, 'the tail of the reply is not recorded');
  f.samples(loud, doneAt + ECHO_TAIL_MS + 50);
  assert.equal(FakeRecorder.made.length, 2, 'after the tail the person is heard again');
  f.conversation.stop();
});

test('a second chat joins the open microphone and listens; ending one leaves the other talking', async () => {
  const f = setup();
  await f.conversation.start('ch_1');
  await f.conversation.start('ch_2');
  assert.equal(f.log.filter((entry) => entry === 'microphone').length, 1, 'one microphone for both');
  assert.deepEqual(f.chats.at(-1)?.map((chat) => [chat.conversationId, chat.listening]), [['ch_2', true], ['ch_1', false]]);
  await f.conversation.start('ch_1'); // focusing a talking chat
  assert.deepEqual(f.chats.at(-1)?.map((chat) => chat.conversationId), ['ch_1', 'ch_2']);
  f.conversation.stop('ch_1');
  assert.equal(f.conversation.active, true);
  assert.equal(f.views.at(-1)?.conversationId, 'ch_2');
  assert.ok(!f.log.includes('microphone closed'));
  f.conversation.stop('ch_2');
  assert.equal(f.conversation.active, false);
  assert.ok(f.log.includes('microphone closed'));
});

test('hiding the page ends the conversation and releases microphone, wake lock, topic and speech', async () => {
  const f = setup();
  await f.conversation.start('ch_1');
  await tick();
  assert.equal(f.hide.length, 1);
  f.hide[0]();
  assert.equal(f.conversation.active, false);
  assert.deepEqual(f.views.at(-1), null);
  assert.equal(f.errors.at(-1), undefined, 'a quiet end, no error');
  for (const entry of ['microphone closed', 'release chat:ch_1', 'wake lock released', 'hide listener removed', 'speech cancelled']) {
    assert.ok(f.log.includes(entry), `${entry}`);
  }
  f.samples(loud, 5000);
  assert.equal(FakeRecorder.made.length, 0, 'a closed capture records nothing');
});

test('it never starts what cannot work: no microphone API, a chat that does not exist', async () => {
  const http = setup({ microphone: 'Open the HTTPS address to talk: browsers allow the microphone only there.' });
  await assert.rejects(http.conversation.start('ch_1'), /Open the HTTPS address to talk/);
  assert.deepEqual(http.log, [], 'no microphone, no round trip');
  assert.equal(http.conversation.active, false);

  const gone = setup({ noChat: true });
  await assert.rejects(gone.conversation.start('ch_gone'), { message: 'Chat not found.' }, 'a real failure is reported, not taken for a cancel');
  assert.ok(gone.log.includes('microphone closed'), 'the microphone opened in the tap is closed again');
  assert.equal(gone.conversation.active, false);
});

test('a failed upload ends the conversation with its error; stopping while the microphone opens starts nothing', async () => {
  const failing = setup({ uploadFails: true });
  await failing.conversation.start('ch_1');
  failing.samples(loud, 1100);
  failing.samples(silent, 2400);
  await tick();
  assert.equal(failing.conversation.active, false);
  assert.equal(failing.errors.at(-1), 'Upload failed: the connection dropped.');
  assert.equal(failing.calls.filter((call) => call.method === 'voice.transcribe').length, 0);

  const early = setup({ holdMic: true });
  const started = early.conversation.start('ch_1');
  early.conversation.stop();
  early.releaseMic();
  await assert.rejects(started, { name: 'ConversationCancelled' }, 'ended by the person: no error to show');
  assert.ok(early.log.includes('microphone closed'));
  assert.equal(early.calls.length, 0, 'no chat was asked for');
});

test('ending while the chat is looked up starts nothing: no session, held topic or listening view is left behind', async () => {
  const f = setup({ holdChat: true });
  const started = f.conversation.start('ch_1');
  await tick();
  assert.deepEqual(f.log, ['microphone', 'wake lock', 'chats.get']);
  f.conversation.stop();
  f.releaseChat();
  await assert.rejects(started, { name: 'ConversationCancelled' });
  assert.equal(f.conversation.active, false);
  assert.ok(f.log.includes('microphone closed'));
  assert.equal(f.log.filter((entry) => entry.startsWith('hold ')).length, f.log.filter((entry) => entry.startsWith('release ')).length, 'no chat topic stays held');
  assert.ok(!f.views.some((entry) => entry?.status === 'listening'), 'nothing shows as listening');
});

test('a second tap while the microphone opens joins the first: one microphone, one session', async () => {
  const f = setup({ holdMic: true, holdChat: true });
  const first = f.conversation.start('ch_1');
  const second = f.conversation.start('ch_1');
  f.releaseMic();
  await tick();
  f.releaseChat();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(f.conversation.active, true);
  assert.equal(f.log.filter((entry) => entry === 'microphone').length, 1);
  assert.equal(f.log.filter((entry) => entry === 'hold chat:ch_1').length, 1, 'one session holds the topic');
  f.samples(loud, 1100);
  assert.equal(FakeRecorder.made.length, 1, 'the microphone hears the person');
  f.conversation.stop();
  assert.ok(f.log.includes('release chat:ch_1'));
});

test('replies are read with the reading voice and the profile language, one line at a time on the device', () => {
  const spoken: Array<{ text: string; lang: string; voice: unknown; onend?: () => void; onerror?: (event: { error: string }) => void }> = [];
  let cancels = 0;
  const anna = { name: 'Anna', lang: 'de-DE' };
  Object.assign(globalThis, {
    speechSynthesis: { speak: (utterance: (typeof spoken)[number]) => spoken.push(utterance), cancel: () => { cancels += 1; }, getVoices: () => [{ name: 'Tom', lang: 'en-US' }, anna] },
    SpeechSynthesisUtterance: class { text: string; lang = ''; voice: unknown = null; constructor(text: string) { this.text = text; } },
  });
  try {
    let done = 0;
    browserSpeech(() => ({ voice: { ttsVoice: 'Anna' }, language: 'de' })).speak('Ask Teydra about it.', () => { done += 1; });
    assert.equal(spoken[0].text, 'Ask Teydra about it.');
    assert.equal(spoken[0].voice, anna);
    assert.equal(spoken[0].lang, 'de-DE');
    // Another reader of this page (another chat) waits for its turn: nothing is cut.
    browserSpeech(() => ({ voice: { ttsVoice: 'Missing' }, language: 'en-GB' })).speak('Hello', () => { done += 1; });
    assert.equal(spoken.length, 1, 'one line at a time on this device');
    spoken[0].onerror?.({ error: 'interrupted' }); // cut by the system, not by its reader
    assert.equal(done, 1, 'a line cut by someone else counts as finished: its reader goes on');
    spoken[0].onend?.();
    assert.equal(done, 1, 'its late end finishes nothing else');
    assert.equal(spoken[1].voice, null, 'a voice this device lacks: the default voice');
    assert.equal(spoken[1].lang, 'en-GB');
    spoken[1].onerror?.({ error: 'synthesis-failed' });
    assert.equal(done, 2, 'a failed reading never leaves the conversation speaking');
    assert.equal(cancels, 0, 'no reader cancels another one');
  } finally {
    delete (globalThis as Record<string, unknown>).speechSynthesis;
    delete (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;
  }
});

test('"Start conversation": only with the methods this connection may call and a page that can record', () => {
  const allowed = ['chats.get', 'voice.transcribe', 'messages.send', 'files.upload'] as SessionInfo['allowedMethods'];
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  session.value = { kind: 'device', capabilities: ['todo', 'chat'], secure: true, allowedMethods: allowed };
  try {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    assert.equal(conversationAvailable(), false, 'no microphone API on this page');
    Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: () => undefined } }, configurable: true });
    Object.assign(globalThis, { AudioContext: class {} });
    assert.equal(conversationAvailable(), true, 'the call cell offers it');
    session.value = { kind: 'device', capabilities: ['todo'], secure: true, allowedMethods: ['files.upload'] as SessionInfo['allowedMethods'] };
    assert.equal(conversationAvailable(), false, 'a link that may not transcribe or send');
  } finally {
    session.value = null;
    delete (globalThis as Record<string, unknown>).AudioContext;
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
  }
});
