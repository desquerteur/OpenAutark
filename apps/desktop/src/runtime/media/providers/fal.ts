// B-058 G13: media generation on fal.ai (queue API in fal-queue.ts) with its curated models (providers/models.ts;
// schemas and prices from fal.ai/models/<id>/llms.txt, read 29.10.2026): video – MiniMax H3 Max Turbo (text to
// video, or image to video when a start image is given; 480P $0.025/s, 768P $0.04/s, 1080P $0.08/s after the
// promotion ending 31.10.2026), music – MiniMax Music 2.6 ($0.15 per song, lyrics or instrumental), sound effects
// – ElevenLabs Sound Effects v2 ($0.002/s, at most 22 s), images – Z-Image Turbo ($0.005 per megapixel). Results
// arrive as fal CDN links that expire: each is downloaded at once, without the key.
// Owns: the input of each model family, reading its output and the list prices. Never: logs or returns the key or
// a provider's raw body, or stores files.

import { WorkforceError } from '../../../shared/errors.ts';
import { reached, unusable } from '../generate-http.ts';
import { runFalJob } from './fal-queue.ts';
import { downloadResult, fileType } from './job.ts';
import { kindOfFunction, staticMediaModel } from './models.ts';
import type { Generated, GenerationKind, GenerationRequest, MediaAdapter } from './types.ts';

const WHAT: Record<GenerationKind, string> = { image: 'Image generation', speech: 'Speech generation', music: 'Music generation', sound: 'Sound effect generation', video: 'Video generation' };
/** Requested resolution → H3's native one, and its price per second. */
const H3_RESOLUTION: Record<string, '480P' | '768P' | '1080P'> = { '360p': '480P', '480p': '480P', '540p': '768P', '720p': '768P', '768p': '768P', '1080p': '1080P' };
const H3_USD_PER_S: Record<string, number> = { '480P': 0.025, '768P': 0.04, '1080P': 0.08 };
const H3_ASPECTS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const SFX_MAX_S = 22;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The family of a fal model id (curated ids and their close variants). */
function familyOf(model: string): 'h3' | 'minimax-music' | 'sfx' | 'image' | undefined {
  if (/^minimax\/h3-max/.test(model)) return 'h3';
  if (/minimax-music/.test(model)) return 'minimax-music';
  if (/elevenlabs\/sound-effects/.test(model)) return 'sfx';
  if (/z-image|flux-2/.test(model)) return 'image';
  return undefined;
}

const FAMILY_KIND: Record<NonNullable<ReturnType<typeof familyOf>>, GenerationKind> = { h3: 'video', 'minimax-music': 'music', sfx: 'sound', image: 'image' };

function kindOf(model: string): GenerationKind | undefined {
  const known = staticMediaModel('fal', model);
  if (known) return kindOfFunction(known.fn);
  const family = familyOf(model);
  return family ? FAMILY_KIND[family] : undefined;
}

/** 'WIDTHxHEIGHT' → fal's image_size object; else its square default. */
function imageSize(size: string | undefined): { width: number; height: number } | 'square_hd' {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size ?? '');
  return match ? { width: clamp(Number(match[1]), 256, 2048), height: clamp(Number(match[2]), 256, 2048) } : 'square_hd';
}

/** The endpoint and input of one request (see the header). */
function jobInput(kind: GenerationKind, request: GenerationRequest, model: string): { endpoint: string; input: Record<string, unknown> } {
  const family = familyOf(model);
  if (kind === 'video' && family === 'h3') {
    const resolution = H3_RESOLUTION[(request.resolution ?? '').toLowerCase()] ?? '768P';
    const input: Record<string, unknown> = { prompt: request.prompt, duration: clamp(request.durationS ?? 5, 1, 15), resolution, prompt_expansion_mode: 'balanced' };
    if (request.image) input.image_url = `data:${request.image.mime};base64,${Buffer.from(request.image.bytes).toString('base64')}`;
    else if (request.aspect && H3_ASPECTS.has(request.aspect)) input.aspect_ratio = request.aspect;
    return { endpoint: request.image ? model.replace(/\/text-to-video$/, '/image-to-video') : model, input };
  }
  if (kind === 'music' && family === 'minimax-music') {
    // the model takes 10–2000 characters of prompt
    const prompt = request.prompt.length >= 10 ? request.prompt.slice(0, 2000) : `${request.prompt}, a song`.length >= 10 ? `${request.prompt}, a song` : `${request.prompt}, a short song`;
    const lyrics = !request.instrumental && request.lyrics?.trim() ? request.lyrics.trim().slice(0, 3500) : undefined;
    return { endpoint: model, input: { prompt, ...(lyrics ? { lyrics } : {}), is_instrumental: Boolean(request.instrumental), lyrics_optimizer: !lyrics && !request.instrumental } };
  }
  if (kind === 'sound' && family === 'sfx') {
    const input: Record<string, unknown> = { text: request.prompt, output_format: 'mp3_44100_128' };
    if (request.durationS !== undefined) input.duration_seconds = clamp(request.durationS, 0.5, SFX_MAX_S);
    if (request.loop) input.loop = true;
    return { endpoint: model, input };
  }
  if (kind === 'image' && family === 'image') {
    return { endpoint: model, input: { prompt: request.prompt, image_size: imageSize(request.size), num_images: 1, output_format: 'png', enable_safety_checker: true } };
  }
  throw unusable(`${model} makes no ${kind === 'speech' ? 'speech' : kind} on fal.ai.`);
}

/** The output's file object of `kind` (video.url, audio.url, images[0].url). */
function outputFile(kind: GenerationKind, output: Record<string, unknown>): { url?: unknown; content_type?: unknown } | undefined {
  const pick = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as { url?: unknown; content_type?: unknown } : undefined);
  if (kind === 'image') return Array.isArray(output.images) ? pick(output.images[0]) : undefined;
  return pick(kind === 'video' ? output.video : output.audio);
}

export const falAdapter: MediaAdapter = {
  provider: 'fal',
  kinds: (model) => { const kind = kindOf(model); return kind ? [kind] : []; },
  estimateUsd(kind, request, model) {
    const family = familyOf(model);
    if (kind === 'video' && family === 'h3') {
      const resolution = H3_RESOLUTION[(request.resolution ?? '').toLowerCase()] ?? '768P';
      return H3_USD_PER_S[resolution] * (clamp(request.durationS ?? 5, 1, 15) + 0.7); // the clip may run 0.7 s longer
    }
    if (kind === 'music' && family === 'minimax-music') return 0.15;
    if (kind === 'sound' && family === 'sfx') return 0.002 * clamp(request.durationS ?? SFX_MAX_S, 0.5, SFX_MAX_S);
    if (kind === 'image' && family === 'image') {
      const size = imageSize(request.size);
      const pixels = size === 'square_hd' ? 1024 * 1024 : size.width * size.height;
      return 0.005 * Math.max(1, Math.ceil(pixels / 1_000_000));
    }
    return undefined;
  },
  async generate(kind, request, target, ctx): Promise<Generated> {
    const what = WHAT[kind];
    const { endpoint, input } = jobInput(kind, request, target.model);
    const { output, requestId } = await runFalJob(ctx, target, endpoint, input, what);
    // Z-Image answers a flagged image as a black one (llms.txt: enable_safety_checker): say so instead of storing it
    if (kind === 'image' && Array.isArray(output.has_nsfw_concepts) && output.has_nsfw_concepts[0] === true) {
      throw new WorkforceError('unavailable', `${what} on fal.ai was blocked by its safety checker. Rephrase the prompt.`, reached('answered'));
    }
    const file = outputFile(kind, output);
    if (!file) throw new WorkforceError('unavailable', `${what} on fal.ai returned no file.`, reached('answered'));
    const { bytes, type } = await downloadResult(ctx, file.url, kind, what);
    const declared = typeof file.content_type === 'string' ? file.content_type : type;
    return { bytes, ...fileType(bytes, declared, kind), meta: { model: endpoint, jobId: requestId } };
  },
};
