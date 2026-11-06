// B-058: media generation on OpenAI-compatible endpoints – OpenAI, xAI, OpenRouter, DeepSeek, Groq, local
// servers and any custom endpoint (moved here from media/generate.ts, MM3): images from `/images/generations`
// (answered as b64_json – asked for except from GPT image models, which refuse the field) and speech from
// `/audio/speech`. Music, sound effects and video have no OpenAI-compatible endpoint (Sora is gone since
// 24.09.2026). OpenAI's own speech models end on 06.01.2027: from then on a call to one of them is refused
// before it is sent (a setup failure, so media.speak falls back to the local voice).
// Owns: request/response mapping for these endpoints and their rough list prices. Never: logs or returns
// the key or a provider's raw error body (generate-http.ts maps failures), or stores files.

import { WorkforceError } from '../../../shared/errors.ts';
import { endpointFor } from '../../engines/http/common.ts';
import { GENERATED_MAX_BYTES, imageMime, mediaExchange, reached, unusable } from '../generate-http.ts';
import type { Generated, GenerationContext, GenerationKind, GenerationRequest, GenerationTarget, MediaAdapter } from './types.ts';

/** Rough USD prices of one paid call (upper ends of common list prices: over-, never under-estimated). */
const IMAGE_USD: Record<string, number> = { low: 0.02, medium: 0.07, high: 0.25, auto: 0.25 };
const SPEECH_USD_PER_CHAR = 30 / 1_000_000;

const SPEECH_FORMATS: Record<string, { mime: string; extension: string }> = {
  mp3: { mime: 'audio/mpeg', extension: 'mp3' }, wav: { mime: 'audio/wav', extension: 'wav' }, opus: { mime: 'audio/ogg', extension: 'ogg' },
};
const IMAGE_EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** OpenAI's speech models and the day OpenAI turns them off (developers.openai.com deprecations). */
const SPEECH_END = Date.UTC(2027, 0, 6);
const OPENAI_SPEECH = /^(tts-1(-hd)?|gpt-4o-mini-tts)(-\d{4}-\d{2}-\d{2})?$/i;

/** OpenAI's own speech model that is turned off by `now` (other providers' models of the same name are not affected). */
export function speechRetired(provider: string, model: string, now = Date.now()): boolean {
  return provider === 'openai' && now >= SPEECH_END && OPENAI_SPEECH.test(model.replace(/^openai\//i, ''));
}

/**
 * OpenAI's built-in voices (platform.openai.com text-to-speech guide). Review fix: an agent's voice is one name for
 * every route (a local speaker number "3", a Gemini "Kore"); OpenAI refuses any other name with HTTP 400 – a refusal
 * that never falls back – so on OpenAI itself another name speaks as "alloy". Compatible servers keep their own names.
 */
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);

export function speechVoice(provider: string, voice: string | undefined): string {
  const name = voice?.trim() ?? '';
  if (provider !== 'openai') return name || 'alloy';
  return OPENAI_VOICES.has(name.toLowerCase()) ? name.toLowerCase() : 'alloy';
}

/** GPT image models always answer base64 and refuse `response_format`; dall-e and most compatible servers need it for base64. */
const ALWAYS_BASE64 = /gpt-image/i;

async function headers(target: GenerationTarget): Promise<Record<string, string>> {
  let key: string | undefined;
  try { key = await target.key?.(); } catch { key = undefined; }
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function base(target: GenerationTarget, what: string): string {
  try { return endpointFor(target.account); } catch (error) {
    throw unusable(`${error instanceof Error ? error.message : 'The account has no valid server URL.'} (${what})`);
  }
}

async function image(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const what = 'Image generation';
  const url = `${base(target, what)}/images/generations`;
  const body: Record<string, unknown> = { model: target.model, prompt: request.prompt, n: 1, ...(ALWAYS_BASE64.test(target.model) ? {} : { response_format: 'b64_json' }) };
  if (request.size && request.size !== 'auto') body.size = request.size;
  if (request.quality && request.quality !== 'auto') body.quality = request.quality;
  const auth = await headers(target);
  // base64 is 4/3 of the bytes: cap the JSON answer a little above that
  const { raw } = await mediaExchange(ctx, { url, headers: auth, json: body, what, max: Math.ceil(GENERATED_MAX_BYTES.image * 1.4) + 64 * 1024 });
  const broken = (message: string) => new WorkforceError('unavailable', message, reached('answered'));
  let parsed: { data?: Array<{ b64_json?: unknown; revised_prompt?: unknown }> };
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw broken(`${what} returned an invalid answer.`); }
  const first = parsed?.data?.[0];
  if (typeof first?.b64_json !== 'string' || !first.b64_json) throw broken(`${what} returned no image (only base64 answers are accepted).`);
  const bytes = Buffer.from(first.b64_json, 'base64');
  if (bytes.byteLength > GENERATED_MAX_BYTES.image) throw broken('The generated image is larger than 20 MB.');
  const mime = imageMime(bytes);
  if (!mime) throw broken(`${what} returned data that is not a PNG, JPEG or WebP image.`);
  const revised = typeof first.revised_prompt === 'string' ? first.revised_prompt.slice(0, 2000) : undefined;
  return { bytes, mime, extension: IMAGE_EXTENSION[mime] ?? 'png', ...(revised ? { meta: { revisedPrompt: revised } } : {}) };
}

async function speech(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const what = 'Speech generation';
  if (speechRetired(target.account.provider, target.model)) {
    throw unusable(`OpenAI turned ${target.model} off on 06.01.2027. Choose another speech model (Settings › Models › Text to speech).`);
  }
  const url = `${base(target, what)}/audio/speech`;
  const format = SPEECH_FORMATS[request.format ?? 'mp3'] ? request.format ?? 'mp3' : 'mp3';
  const body: Record<string, unknown> = { model: target.model, input: request.text ?? request.prompt, response_format: format, voice: speechVoice(target.account.provider, request.voice) };
  const auth = await headers(target);
  const { raw: bytes, type } = await mediaExchange(ctx, { url, headers: auth, json: body, what, max: GENERATED_MAX_BYTES.speech });
  if (bytes.byteLength < 16 || type.startsWith('application/json') || type.startsWith('text/')) {
    throw new WorkforceError('unavailable', `${what} returned no audio.`, reached('answered'));
  }
  return { bytes, ...SPEECH_FORMATS[format] };
}

export const openaiAdapter: MediaAdapter = {
  provider: 'openai',
  // The catalog says which model serves which function; these endpoints define images and speech for any model.
  kinds: () => ['image', 'speech'],
  estimateUsd(kind: GenerationKind, request: GenerationRequest): number | undefined {
    if (kind === 'image') return IMAGE_USD[request.quality ?? 'auto'] ?? IMAGE_USD.auto;
    if (kind === 'speech') return (request.text ?? request.prompt).length * SPEECH_USD_PER_CHAR;
    return undefined;
  },
  async generate(kind, request, target, ctx) {
    if (kind === 'image') return image(request, target, ctx);
    if (kind === 'speech') return speech(request, target, ctx);
    throw new WorkforceError('unavailable', 'OpenAI-compatible endpoints make no music, sound effects or video.');
  },
};
