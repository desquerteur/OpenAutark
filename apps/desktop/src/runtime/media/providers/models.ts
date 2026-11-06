// B-058 G13: the curated media models of the providers that have no model listing of their own –
// ElevenLabs and fal.ai have no OpenAI-style /models (MEDIA_ONLY_PROVIDERS). This is the one table the
// catalog lists for their accounts (models/catalog-media.ts, catalog-merge.ts) and their adapters' kinds()
// read. One model per function and provider, chosen 29.10.2026 from the official model pages: current,
// good and cheap (prices: each adapter's own list). `relCost` (0..1, the catalog's relative price) orders
// the automatic pick across providers (models/functions.ts: cheapest first). B-058 review: three Gemini API
// models (listed by Google itself, as 'models/<id>') get their function and relative price here too – without
// it the name order made Lyria 3 Clip (always 30 s) the automatic music model, so every song was cut to a
// 30-second clip, and Nano Banana 2 Lite (1K only) the image model.
// Owns: which models, their display names, the function each serves, their relative price, and the
// function ↔ generation kind mapping. Never: I/O or a call's price (the adapters own their list prices).

import type { ModelFunction, ProviderId } from '../../../shared/model/providers.ts';
import type { GenerationKind } from './types.ts';

export interface MediaModel {
  /** Provider model id ('eleven_v4', 'fal-ai/z-image/turbo'). */
  model: string;
  name: string;
  fn: ModelFunction;
  relCost: number;
}

export const STATIC_MEDIA_MODELS: Readonly<Partial<Record<ProviderId, readonly MediaModel[]>>> = {
  // elevenlabs.io/docs/models and /pricing/api (29.10.2026, re-checked 30.10.): v4 TTS $0.08 per 1K characters (served by
  // POST /v1/text-to-speech, quickstart), sound effects $0.12/min (SFX v3 is limited access – "Unknown model" elsewhere –,
  // so v2, the API default), music $0.15/min
  elevenlabs: [
    { model: 'eleven_v4', name: 'Eleven v4', fn: 'tts', relCost: 0.15 },
    { model: 'eleven_text_to_sound_v2', name: 'Eleven Sound Effects v2', fn: 'sound', relCost: 0.15 },
    { model: 'music_v2_5', name: 'Eleven Music v2.5', fn: 'music', relCost: 0.3 },
  ],
  // fal.ai/models/<id>/llms.txt (29.10.2026, re-checked 30.10.): H3 Max Turbo $0.025–0.08/s, MiniMax Music 2.6 $0.15, ElevenLabs SFX v2 $0.002/s, Z-Image Turbo $0.005/MP
  fal: [
    { model: 'minimax/h3-max-turbo/text-to-video', name: 'MiniMax H3 Max Turbo', fn: 'video', relCost: 0.3 },
    { model: 'fal-ai/minimax-music/v2.6', name: 'MiniMax Music 2.6', fn: 'music', relCost: 0.3 },
    { model: 'fal-ai/elevenlabs/sound-effects/v2', name: 'ElevenLabs Sound Effects v2', fn: 'sound', relCost: 0.05 },
    { model: 'fal-ai/z-image/turbo', name: 'Z-Image Turbo', fn: 'image', relCost: 0.02 },
  ],
  // ai.google.dev/gemini-api/docs/music-generation, image-generation and /pricing (30.10.2026): Lyria 3.5 makes full songs
  // ($0.08 per song, half of ElevenLabs' or fal's), Lyria 3 Clip only 30-second clips ($0.04) – ordered after every full-song
  // model; Nano Banana 2.1 costs what Nano Banana 2 Lite costs at 1K ($0.0336) but draws better and also makes 2K/4K
  google: [
    { model: 'gemini-nano-banana-2.1', name: 'Nano Banana 2.1', fn: 'image', relCost: 0.04 },
    { model: 'lyria-3.5', name: 'Lyria 3.5', fn: 'music', relCost: 0.15 },
    { model: 'lyria-3-clip-preview', name: 'Lyria 3 Clip', fn: 'music', relCost: 0.35 },
  ],
};

/** The curated entry of a provider's model, if it is one (Google lists its ids as 'models/<id>'). */
export function staticMediaModel(provider: ProviderId, model: string): MediaModel | undefined {
  const id = model.replace(/^models\//, '');
  return STATIC_MEDIA_MODELS[provider]?.find((entry) => entry.model === id);
}

const KIND_OF: Partial<Record<ModelFunction, GenerationKind>> = { tts: 'speech', image: 'image', music: 'music', sound: 'sound', video: 'video' };

/** The generation kind a function model serves (speech to text serves none). */
export function kindOfFunction(fn: ModelFunction): GenerationKind | undefined {
  return KIND_OF[fn];
}
