// B-058 G12/G13: media generation on the ElevenLabs API (elevenlabs.io/docs/api-reference, read 29.10.2026):
// speech – POST {base}/text-to-speech/{voice_id}; sound effects – POST {base}/sound-generation; music –
// POST {base}/music. Header `xi-api-key`, JSON body, `?output_format=` codec_rate_bitrate; every answer is
// the audio file itself. The models are the curated ones (providers/models.ts – ElevenLabs lists none for us).
// Owns: request/response mapping for these endpoints and their list prices (elevenlabs.io/pricing/api,
// 29.10.2026: speech $0.08 per 1K characters – Flash/Turbo $0.04 –, sound effects $0.12 and music $0.15 per
// minute, billed per generation). Never: logs or returns the key or a provider's raw error body
// (generate-http.ts maps failures), or stores files.

import { WorkforceError } from '../../../shared/errors.ts';
import { endpointFor } from '../../engines/http/common.ts';
import { GENERATED_MAX_BYTES, mediaExchange, reached, unusable } from '../generate-http.ts';
import { fileType, keyHeader } from './job.ts';
import { kindOfFunction, staticMediaModel } from './models.ts';
import type { Generated, GenerationContext, GenerationKind, GenerationRequest, GenerationTarget, MediaAdapter } from './types.ts';

/** "George" – the premade voice of ElevenLabs' own API examples; used when no voice id is given. */
export const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const VOICE_ID = /^[A-Za-z0-9]{16,32}$/;

/** Requested format → ElevenLabs output_format (44.1 kHz WAV/PCM needs the Pro plan, so WAV is 24 kHz). */
const SPEECH_FORMAT: Record<string, string> = { mp3: 'mp3_44100_128', wav: 'wav_24000', opus: 'opus_48000_64' };
const SOUND_S = { min: 0.5, max: 30 };
const MUSIC_MS = { min: 3_000, max: 600_000 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function base(target: GenerationTarget, what: string): string {
  try { return endpointFor(target.account); } catch (error) {
    throw unusable(`${error instanceof Error ? error.message : 'The account has no valid server URL.'} (${what})`);
  }
}

/** One POST whose answer is the audio file. */
async function audioCall(ctx: GenerationContext, target: GenerationTarget, kind: GenerationKind, what: string, path: string, format: string, body: Record<string, unknown>): Promise<Generated> {
  const url = `${base(target, what)}${path}?output_format=${encodeURIComponent(format)}`;
  const headers = await keyHeader(target, 'xi-api-key');
  const { raw, type } = await mediaExchange(ctx, { url, headers, json: body, what, max: GENERATED_MAX_BYTES[kind] });
  if (raw.byteLength < 16 || type.startsWith('application/json') || type.startsWith('text/')) {
    throw new WorkforceError('unavailable', `${what} returned no audio.`, reached('answered'));
  }
  return { bytes: raw, ...fileType(raw, type, kind), meta: { model: target.model } };
}

function speech(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const voice = request.voice?.trim() && VOICE_ID.test(request.voice.trim()) ? request.voice.trim() : DEFAULT_VOICE;
  const body: Record<string, unknown> = { text: request.text ?? request.prompt, model_id: target.model };
  // language_code is ignored by models without it and refused by multilingual_v2 (API reference)
  if (request.language && !/multilingual_v2/.test(target.model)) body.language_code = request.language.slice(0, 8);
  const format = SPEECH_FORMAT[request.format ?? 'mp3'] ?? SPEECH_FORMAT.mp3;
  return audioCall(ctx, target, 'speech', 'Speech generation', `/text-to-speech/${encodeURIComponent(voice)}`, format, body)
    .then((made) => ({ ...made, meta: { ...made.meta, voice: voice === DEFAULT_VOICE ? 'George (default)' : voice } }));
}

function sound(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const body: Record<string, unknown> = { text: request.prompt, model_id: target.model };
  if (request.durationS !== undefined) body.duration_seconds = clamp(request.durationS, SOUND_S.min, SOUND_S.max);
  if (request.loop) body.loop = true;
  return audioCall(ctx, target, 'sound', 'Sound effect generation', '/sound-generation', 'mp3_44100_128', body);
}

function music(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  // The prompt carries the lyrics (the API has no lyrics field next to a prompt; composition plans are not used).
  const prompt = request.lyrics?.trim() && !request.instrumental ? `${request.prompt}\n\nLyrics:\n${request.lyrics.trim()}` : request.prompt;
  const body: Record<string, unknown> = { prompt, model_id: target.model };
  if (request.durationS !== undefined) body.music_length_ms = clamp(Math.round(request.durationS * 1000), MUSIC_MS.min, MUSIC_MS.max);
  if (request.instrumental) body.force_instrumental = true;
  return audioCall(ctx, target, 'music', 'Music generation', '/music', 'mp3_44100_128', body);
}

/** The kind a model makes: the curated table, else the family of its id. */
function kindOf(model: string): GenerationKind | undefined {
  const known = staticMediaModel('elevenlabs', model);
  if (known) return kindOfFunction(known.fn);
  if (/text_to_sound/.test(model)) return 'sound';
  if (/^music_v/.test(model)) return 'music';
  if (/^eleven_(?!.*(sts|ttv))/.test(model)) return 'speech';
  return undefined;
}

export const elevenlabsAdapter: MediaAdapter = {
  provider: 'elevenlabs',
  kinds: (model) => { const kind = kindOf(model); return kind ? [kind] : []; },
  estimateUsd(kind, request, model) {
    if (kind === 'speech') return ((request.text ?? request.prompt).length / 1000) * (/flash|turbo|conversational/.test(model) ? 0.04 : 0.08);
    if (kind === 'sound') return 0.12; // billed per generation at $0.12/min: one minute is the upper end
    // no length sent: the model picks it from the prompt – priced at 5 minutes, the longest song media.music asks for
    if (kind === 'music') return 0.15 * Math.max(1, Math.ceil((request.durationS ?? 300) / 60));
    return undefined;
  },
  async generate(kind, request, target, ctx) {
    if (!elevenlabsAdapter.kinds(target.model).includes(kind)) throw unusable(`${target.model} makes no ${kind === 'speech' ? 'speech' : kind} on ElevenLabs.`);
    if (kind === 'speech') return speech(request, target, ctx);
    if (kind === 'sound') return sound(request, target, ctx);
    if (kind === 'music') return music(request, target, ctx);
    throw unusable('ElevenLabs makes no images or video.');
  },
};
