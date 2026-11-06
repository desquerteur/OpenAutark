// Media generation (MM3; B-058 G11–G13 dispatcher): images, speech, music, sound effects and video through
// the function models (models/functions.ts: the Settings choice routing.<fn> while available, else
// the first connected specialist) and the adapter of the account's provider (providers/index.ts adapterFor –
// OpenAI-compatible, Gemini API, ElevenLabs, fal.ai). The free fallbacks (an image on the ChatGPT plan,
// speech in the local voice) and the choice between the routes live in generate-route.ts.
// Owns: the target pick with clear setup errors (naming the setting, or the one key that turns an ability
// on), the request limits per kind, the rough price of a paid call for the summary and the booking (the
// adapter's list price, else a high default – over-, never under-estimated), the deadline per kind
// (image/speech 120 s, music/sound 180 s, video 6 min) enforced around the adapter too, and the check of
// what came back (size cap, a real image / audio / video). Never: logs or returns the key or a provider's
// raw error body, or stores files (the tools do).

import type { RuntimeServices } from '../contracts.ts';
import type { Account, ModelFunction, ProviderId } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { functionStatus } from '../models/functions.ts';
import { chargeOf } from '../models/pricing.ts';
import { adapterFor } from './providers/index.ts';
import { speechRetired } from './providers/openai.ts';
import type { Generated, GenerationKind, GenerationRequest, MediaAdapter, MediaFetch } from './providers/types.ts';
import { avMime, GENERATED_MAX_BYTES, imageMime, reached, unusable } from './generate-http.ts';

export { generationPhase, imageMime, mayFallBack, type GenerationPhase } from './generate-http.ts';
export type { Generated, GenerationKind, GenerationRequest } from './providers/types.ts';

export type FetchFn = MediaFetch;
export type GenerateServices = Pick<RuntimeServices, 'catalog' | 'accounts' | 'settings'> & {
  /** The adapter per provider; tests pass fakes, the app uses providers/index.ts adapterFor. */
  mediaAdapter?: (provider: ProviderId) => MediaAdapter | undefined;
};

export const GENERATE_LIMITS = { speechChars: 4096, promptChars: 4000, lyricsChars: 3000 } as const;
export const DURATION_S: Record<'music' | 'sound' | 'video', { min: number; max: number }> = { music: { min: 5, max: 300 }, sound: { min: 0.5, max: 30 }, video: { min: 2, max: 20 } };
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'] as const;
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export const SPEECH_FORMATS = ['mp3', 'wav', 'opus'] as const;
export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'] as const;
export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

/** The whole exchange of one call (several requests for a polled job), per kind. */
export const DEADLINE_MS: Record<GenerationKind, number> = { image: 120_000, speech: 120_000, music: 180_000, sound: 180_000, video: 360_000 };
/** How long past its deadline an adapter may take to end by itself before the call is cut. */
const GRACE_MS = 2_000;

export const FUNCTION_OF: Record<GenerationKind, ModelFunction> = { image: 'image', speech: 'tts', music: 'music', sound: 'sound', video: 'video' };

const MODELS = 'Settings › Models';
export const ABILITY: Record<GenerationKind, { what: string; noun: string; where: string; keys: string }> = {
  image: { what: 'Image generation', noun: 'images', where: `${MODELS} › Images`, keys: 'sign in to Codex with a ChatGPT plan, or add an OpenAI or Gemini API key' },
  speech: { what: 'Speech generation', noun: 'speech', where: `${MODELS} › Text to speech`, keys: 'download the local voice, or add a Gemini API key or an ElevenLabs key' },
  music: { what: 'Music generation', noun: 'music', where: `${MODELS} › Music`, keys: 'add a Gemini API key, an ElevenLabs key or a fal.ai key' },
  sound: { what: 'Sound effect generation', noun: 'sound effects', where: `${MODELS} › Sound effects`, keys: 'add an ElevenLabs key or a fal.ai key' },
  video: { what: 'Video generation', noun: 'video', where: `${MODELS} › Video`, keys: 'add a Gemini API key or a fal.ai key' },
};

/** The clear "not set up" message: the one key (or sign-in) that turns the ability on. */
export function notSetUp(kind: GenerationKind): WorkforceError {
  const { what, keys } = ABILITY[kind];
  return new WorkforceError('unavailable', `${what} is not set up: ${keys} (${MODELS}).`);
}

export interface MediaTarget {
  kind: GenerationKind;
  account: Account;
  /** Provider model id sent to the provider (e.g. "gpt-image-1"). */
  model: string;
  /** Catalog model id (shown to the agent). */
  modelId: string;
  /** Pay-per-use API key: the call goes through the permission/budget gate. */
  paid: boolean;
  adapter: MediaAdapter;
}

const kindOf = (fn: ModelFunction | GenerationKind): GenerationKind => (fn === 'tts' ? 'speech' : fn as GenerationKind);

/** Model, account and adapter for `kind` (or its function name, 'tts' for speech), or an error saying why none. */
export function resolveTarget(s: GenerateServices, fn: ModelFunction | GenerationKind): { target?: MediaTarget; error?: WorkforceError; off?: boolean } {
  const kind = kindOf(fn);
  const { what, noun, where, keys } = ABILITY[kind];
  const lower = what.toLowerCase();
  const status = functionStatus(s, FUNCTION_OF[kind]);
  if (status.off) return { off: true, error: new WorkforceError('unavailable', `${what} is turned off (${where}).`) };
  if (!status.choice) {
    return {
      error: status.settingUnavailable
        ? unusable(`The chosen ${lower} model is not available. Connect its account again or choose another one (${where}).`)
        : notSetUp(kind),
    };
  }
  const account = s.accounts.get(status.choice.accountId);
  if (!account || !account.enabled) return { error: unusable(`The ${lower} account is not available. Turn it on or connect another one (${where}).`) };
  const adapter = (s.mediaAdapter ?? adapterFor)(account.provider);
  if (!adapter) return { error: new WorkforceError('bad_request', `This account offers no ${lower} endpoint: ${keys} (${where}).`) };
  if (!adapter.kinds(status.choice.model).includes(kind)) {
    return { error: unusable(`${status.choice.modelId} makes no ${noun} through this provider: ${keys} (${where}).`) };
  }
  // Review fix: a retired OpenAI voice is no route at all (the provider would refuse it).
  if (kind === 'speech' && speechRetired(account.provider, status.choice.model)) {
    return { error: unusable(`OpenAI turned ${status.choice.modelId} off on 06.01.2027. Choose another speech model (${where}).`) };
  }
  return { target: { kind, account, model: status.choice.model, modelId: status.choice.modelId, paid: chargeOf(account) === 'paid', adapter } };
}

/** The target, or the clear error. */
export function mediaTarget(s: GenerateServices, fn: ModelFunction | GenerationKind): MediaTarget {
  const { target, error } = resolveTarget(s, fn);
  if (!target) throw error ?? notSetUp(kindOf(fn));
  return target;
}

/** A paid call whose price the adapter does not list: high defaults (video per second, 10 s when not given). */
function unlistedUsd(kind: GenerationKind, request: GenerationRequest): number {
  if (kind === 'video') return 0.5 * (request.durationS ?? 10);
  return { image: 0.25, speech: 0.15, music: 0.5, sound: 0.25 }[kind];
}

/** What one call may cost in USD (undefined for free connections), rounded up to the cent, at least one cent. */
export function priceOf(target: Pick<MediaTarget, 'paid' | 'kind' | 'adapter' | 'model'>, request: GenerationRequest): number | undefined {
  if (!target.paid) return undefined;
  const usd = target.adapter.estimateUsd(target.kind, request, target.model) ?? unlistedUsd(target.kind, request);
  return Math.max(0.01, Math.ceil(usd * 100 - 1e-9) / 100);
}

/** MM3 form of priceOf for an image or a speech of `chars` characters. */
export function estimateUsd(target: Pick<MediaTarget, 'paid'> & Partial<Pick<MediaTarget, 'adapter' | 'model'>>, input: { kind: 'image'; quality?: ImageQuality } | { kind: 'speech'; chars: number }): number | undefined {
  const request: GenerationRequest = input.kind === 'image' ? { prompt: '', quality: input.quality } : { prompt: '', text: ' '.repeat(input.chars) };
  const adapter = target.adapter ?? adapterFor('openai')!;
  return priceOf({ paid: target.paid, kind: input.kind, adapter, model: target.model ?? '' }, request);
}

/** The request trimmed and checked for `kind` (a clear error before anything is sent). */
export function checkRequest(kind: GenerationKind, input: GenerationRequest): GenerationRequest {
  const request: GenerationRequest = { ...input, prompt: input.prompt.trim(), ...(input.text !== undefined ? { text: input.text.trim() } : {}) };
  if (kind === 'speech') {
    const text = request.text || request.prompt;
    if (!text) throw new WorkforceError('bad_request', 'Write the text to speak.');
    if (text.length > GENERATE_LIMITS.speechChars) throw new WorkforceError('bad_request', `Speech is limited to ${GENERATE_LIMITS.speechChars} characters per call; split the text.`);
    return { ...request, text };
  }
  if (!request.prompt) throw new WorkforceError('bad_request', `Describe the ${kind === 'sound' ? 'sound' : kind} to create.`);
  if (request.prompt.length > GENERATE_LIMITS.promptChars) throw new WorkforceError('bad_request', `Keep the description under ${GENERATE_LIMITS.promptChars} characters.`);
  if (request.lyrics && request.lyrics.length > GENERATE_LIMITS.lyricsChars) throw new WorkforceError('bad_request', `Keep the lyrics under ${GENERATE_LIMITS.lyricsChars} characters.`);
  if (kind === 'music' || kind === 'sound' || kind === 'video') {
    const { min, max } = DURATION_S[kind];
    if (request.durationS !== undefined && !(request.durationS >= min && request.durationS <= max)) {
      throw new WorkforceError('bad_request', `The ${kind === 'sound' ? 'sound effect' : kind} lasts ${min}–${max} seconds.`);
    }
  }
  return request;
}

/** The generated bytes are what `kind` promises: within the size cap and a real image / audio / video. */
function checkMade(kind: GenerationKind, made: Generated): Generated {
  const broken = (message: string) => new WorkforceError('unavailable', message, reached('answered'));
  const { what } = ABILITY[kind];
  if (!made?.bytes?.byteLength) throw broken(`${what} returned nothing.`);
  if (made.bytes.byteLength > GENERATED_MAX_BYTES[kind]) throw broken(`${what} returned more than ${Math.round(GENERATED_MAX_BYTES[kind] / 1_048_576)} MB.`);
  if (kind === 'image') {
    const mime = imageMime(made.bytes);
    if (!mime) throw broken(`${what} returned data that is not a PNG, JPEG or WebP image.`);
    return { ...made, mime };
  }
  const first = made.bytes[0];
  if (first === 0x7b || first === 0x3c) throw broken(`${what} returned text instead of ${kind === 'video' ? 'a video' : 'audio'}.`); // '{' or '<'
  let mime = !made.mime || made.mime === 'application/octet-stream' ? avMime(made.bytes) ?? made.mime : made.mime;
  if (kind !== 'video' && mime === 'video/mp4') mime = 'audio/mp4'; // an MP4 container holding sound
  if (!mime?.startsWith(kind === 'video' ? 'video/' : 'audio/')) {
    throw broken(`${what} returned ${mime || 'an unknown format'} instead of ${kind === 'video' ? 'a video' : 'audio'}.`);
  }
  return { ...made, mime };
}

export interface GenerateOptions {
  fetch?: FetchFn;
  signal?: AbortSignal;
  /** The whole exchange; default DEADLINE_MS[kind]. */
  timeoutMs?: number;
}

/**
 * One generation on `target`: the request checked, the adapter called with the deadline, and – should the
 * adapter not end by itself – the call cut GRACE_MS after its deadline or after a stop (effect unknown:
 * phase 'sent'), then what came back checked.
 */
export async function generateMedia(s: GenerateServices, target: MediaTarget, input: GenerationRequest, options: GenerateOptions = {}): Promise<Generated> {
  const request = checkRequest(target.kind, input);
  const { what } = ABILITY[target.kind];
  const ms = options.timeoutMs ?? DEADLINE_MS[target.kind];
  if (options.signal?.aborted) throw new WorkforceError('cancelled', 'Stopped.');
  const controller = new AbortController();
  let cut!: (error: WorkforceError) => void;
  const forced = new Promise<never>((_resolve, reject) => { cut = reject; });
  const later = (delay: number, error: () => WorkforceError) => {
    const timer = setTimeout(() => { controller.abort(); cut(error()); }, delay);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };
  const deadline = later(ms + GRACE_MS, () => new WorkforceError('timeout', `${what} timed out after ${Math.max(1, Math.round(ms / 1000))} s.`, reached('sent')));
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const onStop = () => { controller.abort(); stopTimer = later(GRACE_MS, () => new WorkforceError('cancelled', 'Stopped.', reached('sent'))); };
  options.signal?.addEventListener('abort', onStop, { once: true });
  const deadlineMs = Date.now() + ms;
  const job = Promise.resolve().then(() => target.adapter.generate(target.kind, request, { account: target.account, model: target.model, key: () => s.accounts.apiKey(target.account.id) }, {
    fetch: options.fetch ?? ((url, init) => fetch(url, init)), signal: controller.signal, deadlineMs,
  }));
  job.catch(() => undefined); // a cut call ends later on its own
  try {
    return checkMade(target.kind, await Promise.race([job, forced]));
  } catch (error) {
    if (error instanceof WorkforceError) throw error;
    throw new WorkforceError('unavailable', `${what} failed.`, reached('sent')); // an adapter's own failure: it may have been sent
  } finally {
    clearTimeout(deadline);
    if (stopTimer) clearTimeout(stopTimer);
    options.signal?.removeEventListener('abort', onStop);
  }
}
