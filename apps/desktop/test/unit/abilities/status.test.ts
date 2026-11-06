// B-058 G14 (T7): the abilities overview as a pure function of this PC's facts (runtime/abilities/status.ts) –
// one row per ability in ABILITY_IDS order, its state, what provides it and the one action that turns it on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABILITY_IDS, type Ability } from '../../../src/shared/model/abilities.ts';
import { abilityList, type AbilityFacts } from '../../../src/runtime/abilities/status.ts';

const FC = { id: 'fastconformer-de-int8', label: 'FastConformer German', downloadMb: 108 };

/** A fresh PC: the engine loads, nothing downloaded, no account. */
function fresh(extra: Partial<AbilityFacts> = {}): AbilityFacts {
  return {
    engine: true, sttRecommended: FC, hostDecodes: true, hostFrames: true, tagger: false,
    web: { tools: true }, pc: { tools: true },
    make: { image: { via: 'none', off: false }, speech: { via: 'local', installed: false, id: 'supertonic-3-int8', downloadMb: 129 }, music: { via: 'none', off: false }, sound: { via: 'none', off: false }, video: { via: 'none', off: false } },
    ...extra,
  };
}

const byId = (list: Ability[]) => Object.fromEntries(list.map((entry) => [entry.id, entry]));

test('a fresh PC: every ability in order, speech one download away, keys named for what costs money', () => {
  const list = abilityList(fresh());
  assert.deepEqual(list.map((entry) => entry.id), ABILITY_IDS);
  const a = byId(list);
  assert.equal(a['hear-speech'].state, 'setup');
  assert.equal(a['hear-speech'].source, undefined);
  assert.deepEqual(a['hear-speech'].action, { kind: 'download-model', label: 'Download', target: FC.id });
  assert.match(a['hear-speech'].note!, /108 MB/);
  assert.equal(a['hear-sounds'].state, 'ready');
  assert.match(a['hear-sounds'].source!, /CED Mini.*first use/);
  assert.deepEqual(a['hear-sounds'].action, { kind: 'download-model', label: 'Download', target: 'ced-mini' }, 'Download fetches the tagger now');
  assert.equal(byId(abilityList(fresh({ tagger: true })))['hear-sounds'].action, undefined, 'a downloaded tagger needs no action');
  assert.equal(a['see-images'].state, 'off');
  assert.deepEqual(a['see-images'].action, { kind: 'ai', label: 'Set up with AI', target: 'models' });
  assert.equal(a['see-video'].state, 'off');
  assert.deepEqual([a['use-web'].state, a['use-web'].note], ['ready', undefined]);
  assert.deepEqual([a['use-pc'].state, a['use-pc'].note], ['ready', undefined]);
  assert.equal(a.speak.state, 'ready');
  assert.deepEqual(a.speak.action, { kind: 'download-model', label: 'Download', target: 'supertonic-3-int8' });
  assert.deepEqual(a['make-images'].action, { kind: 'ai', label: 'Set up with AI', target: 'fal' });
  assert.match(a['make-images'].note!, /ChatGPT plan/);
  assert.deepEqual([a['make-music'].state, a['make-music'].action?.target], ['off', 'elevenlabs']);
  assert.deepEqual([a['make-sounds'].state, a['make-sounds'].action?.target], ['off', 'elevenlabs']);
  assert.deepEqual([a['make-video'].state, a['make-video'].action?.target], ['off', 'fal']);
});

test('hearing speech: the chosen local model, the service, a downloaded model not in use, a refused engine', () => {
  const chosen = byId(abilityList(fresh({ stt: FC, sttRecommended: undefined })))['hear-speech'];
  assert.deepEqual([chosen.state, chosen.source, chosen.action], ['ready', 'FastConformer German on this PC', undefined]);
  const wavOnly = byId(abilityList(fresh({ stt: FC, hostDecodes: false })))['hear-speech'];
  assert.match(wavOnly.note!, /WAV/);
  const service = byId(abilityList(fresh({ sttService: { model: 'whisper-large-v3-turbo', via: 'Groq' }, sttRecommended: undefined })))['hear-speech'];
  assert.deepEqual([service.state, service.source], ['ready', 'whisper-large-v3-turbo · Groq']);
  const unused = byId(abilityList(fresh({ sttInstalled: FC })))['hear-speech'];
  assert.deepEqual([unused.state, unused.action], ['setup', { kind: 'download-model', label: 'Use', target: FC.id }]);
  const noEngine = byId(abilityList(fresh({ engine: false, sttRecommended: undefined })))['hear-speech'];
  assert.deepEqual([noEngine.state, noEngine.action?.kind, noEngine.action?.target], ['off', 'ai', 'groq']);
  const listening = byId(abilityList(fresh({ engine: false, listener: { model: 'gemini-3.5-flash', via: 'Gemini' } })))['hear-speech'];
  assert.deepEqual([listening.state, listening.source], ['ready', 'gemini-3.5-flash · Gemini'], 'a model that hears audio');
});

test('review fix: a chosen local model whose engine cannot load here is not "ready"', () => {
  const blocked = byId(abilityList(fresh({ stt: FC, sttRecommended: undefined, engine: false })))['hear-speech'];
  assert.equal(blocked.state, 'off');
  assert.deepEqual(blocked.action, { kind: 'ai', label: 'Set up with AI', target: 'groq' });
  assert.match(blocked.note!, /FastConformer German cannot run on this PC/);
  const service = byId(abilityList(fresh({ stt: FC, engine: false, sttService: { model: 'whisper-large-v3-turbo', via: 'Groq' } })))['hear-speech'];
  assert.deepEqual([service.state, service.source], ['ready', 'whisper-large-v3-turbo · Groq'], 'a connected service still hears');
  const video = byId(abilityList(fresh({ stt: FC, engine: false, vision: { model: 'GPT-6.1 Sol', via: 'Codex' } })))['see-video'];
  assert.match(video.source!, /frames only/, 'video does not claim the spoken words either');
});

test('seeing and hearing: a vision model makes images and video ready; video says whether it hears the words', () => {
  const vision = { model: 'GPT-6.1 Sol', via: 'Codex' };
  const a = byId(abilityList(fresh({ vision, stt: FC })));
  assert.deepEqual([a['see-images'].state, a['see-images'].source], ['ready', 'GPT-6.1 Sol · Codex']);
  assert.deepEqual([a['see-video'].state, a['see-video'].source], ['ready', 'GPT-6.1 Sol · frames and spoken words']);
  assert.match(byId(abilityList(fresh({ vision })))['see-video'].source!, /frames only/);
  assert.equal(byId(abilityList(fresh({ vision, hostFrames: false })))['see-video'].state, 'off');
  const listener = byId(abilityList(fresh({ listener: { model: 'gemini-3.5-flash', via: 'Gemini' } })))['hear-sounds'];
  assert.equal(listener.source, 'gemini-3.5-flash · Gemini');
  const nothing = byId(abilityList(fresh({ engine: false })))['hear-sounds'];
  assert.deepEqual([nothing.state, nothing.action?.target], ['off', 'google']);
  assert.equal(byId(abilityList(fresh({ web: { tools: false } })))['use-web'].state, 'off');
});

test('making media: the model, the ChatGPT plan, the downloaded voice, a function turned off', () => {
  const make = {
    image: { via: 'plan' as const }, speech: { via: 'local' as const, installed: true },
    music: { via: 'model' as const, named: { model: 'Eleven Music v2.5', via: 'ElevenLabs' } },
    sound: { via: 'none' as const, off: true }, video: { via: 'model' as const, named: { model: 'MiniMax H3 Max Turbo', via: 'fal.ai' } },
  };
  const a = byId(abilityList(fresh({ make })));
  assert.deepEqual([a['make-images'].state, a['make-images'].source], ['ready', 'ChatGPT plan via Codex']);
  assert.deepEqual([a.speak.state, a.speak.source, a.speak.action], ['ready', 'Local voice on this PC', undefined]);
  assert.equal(a['make-music'].source, 'Eleven Music v2.5 · ElevenLabs');
  assert.deepEqual([a['make-sounds'].state, a['make-sounds'].action], ['off', { kind: 'ai', label: 'Set up with AI', target: 'routing' }]);
  assert.equal(a['make-video'].state, 'ready');
});
