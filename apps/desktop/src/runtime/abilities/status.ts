// B-058 G14: the abilities overview as a pure function of what this PC has (facts.ts reads the facts from the
// runtime). One row per ability (shared/model/abilities.ts ABILITY_IDS order) with its state, what provides it
// and the one action that turns it on:
//   hear-speech  the chosen local speech model on this PC (only while the local engine loads here); else the
//                speech-to-text model; else a model that hears audio; else the recommended local model is one
//                download away ('setup'); else a free Groq key
//   hear-sounds  a model that hears audio; else the local sound tagger (downloads itself on first use, 48 MB;
//                Download fetches it now); else a Gemini key
//   see-images   a connected model that sees images (plans first); else connect an AI
//   see-video    keyframes in the desktop app + that model (the soundtrack's speech when hear-speech works)
//   use-web/-pc  read only from what B-055 offers: the built-in tools exist
//   speak        the speech model; else the local voice (downloads itself on first use; Download fetches it now)
//   make-*       the function model; images also the ChatGPT plan via Codex; else 'off' with the key that
//                turns it on – the free or cheapest one (ElevenLabs' free plan for music and sound effects,
//                fal.ai for video and images)
// A function turned off in settings.json (routing.<fn> 'off') reads 'off'. Every action that is not a
// download is 'Set up with AI'.
// 'ready' means: works now without the person doing anything (a model fetched on first use counts).
// Owns: these rules and their short texts. Never: I/O, or texts of the settings page itself (ui/settings).

import type { Ability, AbilityAction, AbilityId } from '../../shared/model/abilities.ts';
import { AUDIO_TAGGER } from '../../shared/model/local-speech-models.ts';
import type { GenerationKind } from '../media/providers/types.ts';

/** A model and the connection it runs on, as the overview names it ('GPT-6.1 Sol · Codex'). */
export interface Named { model: string; via: string }

/** A local speech model as the overview names it. */
export interface LocalNamed { id: string; label: string; downloadMb: number }

/** How one kind of media is made now (generate-route.ts routesFor). */
export type MakeFact = { via: 'model'; named: Named } | { via: 'plan' } | { via: 'local'; installed: boolean; downloadMb?: number; id?: string } | { via: 'none'; off: boolean };

export interface AbilityFacts {
  /** The local speech engine loads on this PC. */
  engine: boolean;
  /** The chosen local speech-to-text model, when it is downloaded. */
  stt?: LocalNamed;
  /** A downloaded speech-to-text model that is not chosen (the person cleared the choice). */
  sttInstalled?: LocalNamed;
  /** The model fitLocalSpeech recommends for the person's language, when it is not downloaded. */
  sttRecommended?: LocalNamed;
  /** The speech-to-text function model (routing.stt or the first connected one). */
  sttService?: Named;
  /** The host decodes compressed recordings and video sound (G6). */
  hostDecodes: boolean;
  /** The host takes keyframes of videos (the desktop app). */
  hostFrames: boolean;
  /** A connected model that hears audio (media.listen). */
  listener?: Named;
  /** The local sound tagger is downloaded. */
  tagger: boolean;
  /** A connected model that sees images (chat turns and media.view). */
  vision?: Named;
  web: { tools: boolean };
  pc: { tools: boolean };
  make: Record<GenerationKind, MakeFact>;
}

const named = (entry: Named) => `${entry.model} · ${entry.via}`;
const download = (target: string, label = 'Download'): AbilityAction => ({ kind: 'download-model', label, target });
const ai = (target: string): AbilityAction => ({ kind: 'ai', label: 'Set up with AI', target });
const WAV_ONLY = 'WAV recordings only until the app can decode other formats';

function hearSpeech(f: AbilityFacts): Ability {
  const id: AbilityId = 'hear-speech';
  const service = f.sttService ? named(f.sttService) : undefined;
  // a chosen model only hears while the engine loads here
  if (f.stt && f.engine) return { id, state: 'ready', source: `${f.stt.label} on this PC`, ...(f.hostDecodes ? {} : { note: WAV_ONLY }) };
  if (f.sttInstalled && f.engine) return { id, state: 'setup', source: service, action: download(f.sttInstalled.id, 'Use'), note: `${f.sttInstalled.label} is downloaded but not in use` };
  if (service) return { id, state: 'ready', source: service };
  if (f.engine && f.sttRecommended) {
    return { id, state: 'setup', ...(f.listener ? { source: named(f.listener) } : {}), action: download(f.sttRecommended.id), note: `Download ${f.sttRecommended.label} (${f.sttRecommended.downloadMb} MB) for accurate dictation` };
  }
  if (f.listener) return { id, state: 'ready', source: named(f.listener) };
  const why = f.stt ? `${f.stt.label} cannot run on this PC` : 'The local speech engine cannot run here';
  return { id, state: 'off', action: ai('groq'), note: `${why} – Groq has a free transcription key` };
}

function hearSounds(f: AbilityFacts): Ability {
  const id: AbilityId = 'hear-sounds';
  if (f.listener) return { id, state: 'ready', source: named(f.listener) };
  if (f.engine) {
    const where = f.tagger ? 'CED Mini on this PC' : 'CED Mini on this PC (downloads on first use, 48 MB)';
    return { id, state: 'ready', source: where, ...(f.tagger ? {} : { action: download(AUDIO_TAGGER.id) }), ...(f.hostDecodes ? {} : { note: WAV_ONLY }) };
  }
  return { id, state: 'off', action: ai('google'), note: 'Needs a model that hears audio – a Gemini key' };
}

function seeImages(f: AbilityFacts): Ability {
  if (f.vision) return { id: 'see-images', state: 'ready', source: named(f.vision) };
  return { id: 'see-images', state: 'off', action: ai('models'), note: 'No connected model sees images' };
}

function seeVideo(f: AbilityFacts, speech: Ability): Ability {
  const id: AbilityId = 'see-video';
  if (!f.hostFrames) return { id, state: 'off', note: 'Needs the desktop app (it takes the frames)' };
  if (!f.vision) return { id, state: 'off', action: ai('models'), note: 'No connected model sees images' };
  const sound = speech.state === 'ready' && f.hostDecodes ? 'frames and spoken words' : 'frames only – no spoken words yet';
  return { id, state: 'ready', source: `${f.vision.model} · ${sound}` };
}

function tool(id: AbilityId, fact: { tools: boolean }, source: string): Ability {
  if (!fact.tools) return { id, state: 'off', note: 'Not available here' };
  return { id, state: 'ready', source };
}

/** The key that turns a kind on (the free or cheapest one) and the line that says so. */
const KEY_FOR: Record<GenerationKind, { provider: string; note: string }> = {
  image: { provider: 'fal', note: 'Sign in to Codex with a ChatGPT plan, or add a key – fal.ai is the cheapest' },
  speech: { provider: 'elevenlabs', note: 'Needs a key – ElevenLabs has a free plan' },
  music: { provider: 'elevenlabs', note: 'Needs a key – ElevenLabs has a free plan' },
  sound: { provider: 'elevenlabs', note: 'Needs a key – ElevenLabs has a free plan' },
  video: { provider: 'fal', note: 'Needs a key – fal.ai is the cheapest (pay per use)' },
};

function make(id: AbilityId, kind: GenerationKind, fact: MakeFact): Ability {
  if (fact.via === 'model') return { id, state: 'ready', source: named(fact.named) };
  if (fact.via === 'plan') return { id, state: 'ready', source: 'ChatGPT plan via Codex' };
  if (fact.via === 'local') {
    if (fact.installed) return { id, state: 'ready', source: 'Local voice on this PC' };
    return { id, state: 'ready', source: `Local voice (downloads on first use${fact.downloadMb ? `, ${fact.downloadMb} MB` : ''})`, ...(fact.id ? { action: download(fact.id) } : {}) };
  }
  if (fact.off) return { id, state: 'off', action: ai('routing'), note: 'Turned off in settings.json' };
  const key = KEY_FOR[kind];
  return { id, state: 'off', action: ai(key.provider), note: key.note };
}

/** Every ability in ABILITY_IDS order. */
export function abilityList(f: AbilityFacts): Ability[] {
  const speech = hearSpeech(f);
  return [
    speech,
    hearSounds(f),
    seeImages(f),
    seeVideo(f, speech),
    tool('use-web', f.web, 'Built-in browser'),
    tool('use-pc', f.pc, 'Built-in PC control'),
    make('speak', 'speech', f.make.speech),
    make('make-images', 'image', f.make.image),
    make('make-music', 'music', f.make.music),
    make('make-sounds', 'sound', f.make.sound),
    make('make-video', 'video', f.make.video),
  ];
}
