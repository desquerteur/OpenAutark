// B-058 G12/G13: media generation on the Gemini API's Interactions endpoint, POST {base}/interactions with
// `x-goog-api-key` (ai.google.dev/gemini-api/docs image-generation, speech-generation, music-generation and omni,
// read 29.10.2026; the docs show the Interactions API for all four): Nano Banana images (gemini-*-image,
// gemini-nano-banana-*), TTS (gemini-*-tts: WAV by default on 3.8, raw 24 kHz PCM on older models – wrapped as
// WAV), Lyria music (lyria-*: MP3, lyrics as text) and Gemini Omni video (gemini-omni-*: asked as a Files API
// URI, gemini-files.ts). The base is the account's OpenAI-compatible URL without its '/openai' tail. Every
// call sets store=false (nothing kept on Google's side). Results: steps[type=model_output].content[].
// Owns: request/response mapping and the list prices (ai.google.dev/gemini-api/docs/pricing, 29.10.2026; TTS at
// the higher 2027 rate). Never: logs or returns the key or a provider's raw error body (generate-http.ts maps
// failures), or stores files.

import { WorkforceError } from '../../../shared/errors.ts';
import { encodeWav, pcm16Samples } from '../../../shared/voice/wav.ts';
import { endpointFor } from '../../engines/http/common.ts';
import { GENERATED_MAX_BYTES, mediaExchange, reached, unusable } from '../generate-http.ts';
import { downloadGeneratedFile } from './gemini-files.ts';
import { answerJson, fileType, keyHeader, modelSaid } from './job.ts';
import type { Generated, GenerationContext, GenerationKind, GenerationRequest, GenerationTarget, MediaAdapter } from './types.ts';

type Block = Record<string, unknown>;

const WHAT: Record<GenerationKind, string> = { image: 'Image generation', speech: 'Speech generation', music: 'Music generation', sound: 'Sound effect generation', video: 'Video generation' };
/** The 30 prebuilt voices of Gemini TTS (speech-generation#voices). */
const VOICES = new Map(['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina',
  'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia',
  'Sadaltager', 'Sulafat'].map((name) => [name.toLowerCase(), name]));
const DEFAULT_VOICE = 'Kore';
const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].map((ratio) => { const [w, h] = ratio.split(':').map(Number); return { ratio, value: w / h }; });
const VIDEO_RESOLUTION: Record<string, string> = { '360p': '360p', '480p': '360p', '720p': '720p', '1080p': '1080p', '4k': '4k' };
/** USD per image by size (pricing page; unknown models: a high default). */
const IMAGE_USD: Array<[RegExp, Record<string, number>]> = [
  [/nano-banana-2/, { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 }],
  [/3\.1-flash-lite-image/, { '1K': 0.0336 }],
  [/3\.1-flash-image/, { '1K': 0.067, '2K': 0.101, '4K': 0.151 }],
  [/3-pro-image|nano-banana-pro/, { '1K': 0.134, '2K': 0.134, '4K': 0.24 }],
  [/2\.5-flash-image/, { '1K': 0.039 }],
];
/** Omni: 5,792 output tokens per second of 720p video at $17.50 per 1M (≈ $0.10/s); upscaled sizes are not listed – assumed dearer. */
const OMNI_USD_PER_S = (5792 * 17.5) / 1_000_000;
const OMNI_SIZE_FACTOR: Record<string, number> = { '360p': 1, '720p': 1, '1080p': 1.5, '4k': 3 };
/** B-058 review: the largest interaction answer read – base64 inline media plus text. A video is asked as a URI (a small
 *  answer), so its answer is capped far below the 200 MB video limit: a 280 MB JSON would be held three times (chunks, text,
 *  parse) on a PC with < 1 GB free. Images, speech and music stay inline (their own limit, base64-sized). */
const answerMax = (kind: GenerationKind) => (kind === 'video' ? 64 * 1024 * 1024 : Math.ceil(GENERATED_MAX_BYTES[kind] * 1.4) + 256 * 1024);

const apiModel = (model: string) => model.replace(/^models\//, '');

function kindOf(model: string): GenerationKind | undefined {
  const name = apiModel(model).toLowerCase();
  if (/(^|[-_.])tts([-_.]|$)/.test(name)) return 'speech';
  if (/^lyria/.test(name) && !/realtime/.test(name)) return 'music';
  if (/gemini-omni/.test(name)) return 'video';
  if (!/imagen/.test(name) && /nano-banana|(^|[-_.])image([-_.]|$)/.test(name)) return 'image'; // Imagen is shut down
  return undefined;
}

/** Only 1K images on these models (image-generation: Flash Lite Image and 2.5 Flash Image). */
const ONE_K_ONLY = (model: string) => /flash-lite-image|2\.5-flash-image/.test(model);

function imageFormat(request: GenerationRequest, model: string): { aspect?: string; size?: '2K' | '4K' } {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(request.size ?? '');
  const out: { aspect?: string; size?: '2K' | '4K' } = {};
  if (match) {
    const [w, h] = [Number(match[1]), Number(match[2])];
    out.aspect = ASPECTS.reduce((best, next) => (Math.abs(Math.log(next.value / (w / h))) < Math.abs(Math.log(best.value / (w / h))) ? next : best)).ratio;
    const edge = Math.max(w, h);
    if (edge > 2752) out.size = '4K'; else if (edge > 1584) out.size = '2K';
  }
  if (!out.size && request.quality === 'high') out.size = '2K';
  if (ONE_K_ONLY(model)) delete out.size;
  return out;
}

function base(target: GenerationTarget, what: string): string {
  try { return endpointFor(target.account).replace(/\/openai$/, ''); } catch (error) {
    throw unusable(`${error instanceof Error ? error.message : 'The account has no valid server URL.'} (${what})`);
  }
}

/** A rate limit on a model without a free tier usually means the key has no billing: say so. */
function explain(error: unknown, kind: GenerationKind): unknown {
  if (!(error instanceof WorkforceError) || error.code !== 'rate_limited' || kind === 'speech') return error;
  return new WorkforceError('rate_limited', `${WHAT[kind]}: the Gemini API limit was reached. Image, music and video models have no free tier – they need a key with billing turned on (Google AI Studio).`, { details: error.details, retryAfterMs: error.retryAfterMs });
}

/** One interaction; its model output blocks and their joined text. */
async function interact(ctx: GenerationContext, target: GenerationTarget, kind: GenerationKind, body: Record<string, unknown>) {
  const what = WHAT[kind];
  const root = base(target, what);
  const headers = await keyHeader(target, 'x-goog-api-key');
  let raw: Buffer;
  try {
    ({ raw } = await mediaExchange(ctx, { url: `${root}/interactions`, headers, json: { model: apiModel(target.model), ...body, store: false }, what, max: answerMax(kind) }));
  } catch (error) { throw explain(error, kind); }
  const answer = answerJson(raw, what);
  const steps = Array.isArray(answer.steps) ? answer.steps : [];
  const blocks: Block[] = steps.filter((step): step is Block => Boolean(step) && typeof step === 'object' && (step as Block).type === 'model_output')
    .flatMap((step) => (Array.isArray(step.content) ? step.content.filter((part): part is Block => Boolean(part) && typeof part === 'object') : []));
  const text = blocks.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n').trim();
  if (answer.status === 'failed' || answer.status === 'cancelled') throw new WorkforceError('unavailable', `${what} failed on the Gemini API (its safety filters may have blocked it).${modelSaid(text)}`);
  return { blocks, text, root, headers, what };
}

/** The last block of `type` with its bytes inline or a URI. */
function lastOf(blocks: Block[], type: string): Block | undefined {
  return blocks.filter((part) => part.type === type && (typeof part.data === 'string' || typeof part.uri === 'string')).at(-1);
}

const inline = (block: Block) => (typeof block.data === 'string' && block.data ? Buffer.from(block.data, 'base64') : undefined);
const mimeOf = (block: Block) => (typeof block.mime_type === 'string' ? block.mime_type : undefined);
const missing = (what: string, text: string, noun: string) => new WorkforceError('unavailable', `${what} returned no ${noun}.${modelSaid(text)}`, reached('answered'));

async function image(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const { aspect, size } = imageFormat(request, target.model);
  const input = request.image
    ? [{ type: 'text', text: request.prompt }, { type: 'image', data: Buffer.from(request.image.bytes).toString('base64'), mime_type: request.image.mime }]
    : request.prompt;
  const { blocks, text, what } = await interact(ctx, target, 'image', { input, response_format: { type: 'image', ...(aspect ? { aspect_ratio: aspect } : {}), ...(size ? { image_size: size } : {}) } });
  const block = lastOf(blocks, 'image');
  const bytes = block && inline(block);
  if (!block || !bytes) throw missing(what, text, 'image');
  return { bytes, ...fileType(bytes, mimeOf(block), 'image'), meta: { model: apiModel(target.model) } };
}

async function speech(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const voice = request.voice?.trim() ?? '';
  const chosen = /^voice(key)?_[\w-]{1,100}$/.test(voice) ? voice : VOICES.get(voice.toLowerCase()) ?? DEFAULT_VOICE;
  const text = request.text ?? request.prompt;
  // speech_metadata.style steers the delivery (3.8 TTS); preview models read the text verbatim without it
  const style = request.text && request.prompt && request.prompt !== request.text && !/preview/.test(target.model) ? request.prompt.slice(0, 500) : undefined;
  const content = [{ type: 'text', text, ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}) }];
  const { blocks, text: said, what } = await interact(ctx, target, 'speech', {
    input: [{ type: 'user_input', content }], response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice: chosen }] },
  });
  const block = lastOf(blocks, 'audio');
  const bytes = block && inline(block);
  if (!block || !bytes) throw missing(what, said, 'audio');
  const mime = (mimeOf(block) ?? '').toLowerCase();
  const isWav = bytes.subarray(0, 4).toString('latin1') === 'RIFF';
  if (!isWav && (mime === '' || /l16|pcm/.test(mime))) {
    const rate = (typeof block.sample_rate === 'number' && block.sample_rate > 0 ? block.sample_rate : Number(/rate=(\d+)/.exec(mime)?.[1])) || 24_000;
    const wav = Buffer.from(encodeWav(pcm16Samples(bytes), rate));
    return { bytes: wav, mime: 'audio/wav', extension: 'wav', durationMs: Math.round((bytes.byteLength / 2 / rate) * 1000), meta: { voice: chosen } };
  }
  return { bytes, ...fileType(bytes, mime, 'speech'), meta: { voice: chosen } };
}

async function music(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const clip = /clip/.test(target.model); // Lyria 3 Clip always makes 30 s
  const parts = [request.prompt];
  if (request.instrumental) parts.push('Instrumental only, no vocals.');
  else if (request.lyrics?.trim()) parts.push(`Lyrics:\n${request.lyrics.trim()}`);
  if (!clip && request.durationS) parts.push(`Length: about ${Math.round(request.durationS)} seconds.`);
  const wav = request.format === 'wav' && !clip;
  const { blocks, text, what } = await interact(ctx, target, 'music', { input: parts.join('\n\n'), ...(wav ? { response_format: { type: 'audio', mime_type: 'audio/wav' } } : {}) });
  const block = lastOf(blocks, 'audio');
  const bytes = block && inline(block);
  if (!block || !bytes) throw missing(what, text, 'music');
  return { bytes, ...fileType(bytes, mimeOf(block), 'music'), meta: { model: apiModel(target.model), ...(text ? { lyrics: text.slice(0, 2000) } : {}) } };
}

async function video(request: GenerationRequest, target: GenerationTarget, ctx: GenerationContext): Promise<Generated> {
  const prompt = request.durationS ? `${request.prompt}\n\nLength: about ${Math.round(request.durationS)} seconds.` : request.prompt;
  const input = request.image
    ? [{ type: 'image', data: Buffer.from(request.image.bytes).toString('base64'), mime_type: request.image.mime }, { type: 'text', text: prompt }]
    : prompt;
  const format: Record<string, unknown> = { type: 'video', delivery: 'uri' };
  if (request.aspect === '16:9' || request.aspect === '9:16') format.aspect_ratio = request.aspect;
  const resolution = VIDEO_RESOLUTION[(request.resolution ?? '').toLowerCase()];
  if (resolution) format.resolution = resolution;
  const { blocks, text, root, headers, what } = await interact(ctx, target, 'video', { input, response_format: format });
  const block = lastOf(blocks, 'video');
  if (!block) throw missing(what, text, 'video');
  const made = inline(block) ? { bytes: inline(block)!, type: mimeOf(block) ?? 'video/mp4' } : await downloadGeneratedFile(ctx, { base: root, headers, uri: block.uri, kind: 'video', what });
  return { bytes: made.bytes, ...fileType(made.bytes, mimeOf(block) ?? made.type, 'video'), meta: { model: apiModel(target.model) } };
}

export const geminiAdapter: MediaAdapter = {
  provider: 'google',
  kinds: (model) => { const kind = kindOf(model); return kind ? [kind] : []; },
  estimateUsd(kind, request, model) {
    const name = apiModel(model).toLowerCase();
    if (kind === 'image') {
      const size = imageFormat(request, name).size ?? '1K';
      const table = IMAGE_USD.find(([pattern]) => pattern.test(name))?.[1];
      return (table?.[size] ?? table?.['1K'] ?? 0.15) + (request.image ? 0.003 : 0.001);
    }
    if (kind === 'speech') {
      const seconds = Math.max(1, (request.text ?? request.prompt).length / 12); // ~12 characters per spoken second (over-estimate)
      const perMillion = /flash-lite-tts/.test(name) ? 12 : /3\.8-flash-tts/.test(name) ? 18 : 20; // audio output, 25 tokens/s
      return Math.max(0.001, (seconds * 25 * perMillion) / 1_000_000);
    }
    if (kind === 'music') return /clip/.test(name) ? 0.04 : 0.08;
    if (kind === 'video') return OMNI_USD_PER_S * (OMNI_SIZE_FACTOR[VIDEO_RESOLUTION[(request.resolution ?? '').toLowerCase()] ?? '720p'] ?? 1) * (request.durationS ?? 10);
    return undefined;
  },
  async generate(kind, request, target, ctx) {
    if (!geminiAdapter.kinds(target.model).includes(kind)) throw unusable(`${apiModel(target.model)} makes no ${kind === 'speech' ? 'speech' : kind} on the Gemini API.`);
    if (kind === 'image') return image(request, target, ctx);
    if (kind === 'speech') return speech(request, target, ctx);
    if (kind === 'music') return music(request, target, ctx);
    if (kind === 'video') return video(request, target, ctx);
    throw unusable('The Gemini API makes no sound effects.');
  },
};
