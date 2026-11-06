// B-058 G11/G12: which route makes a generation – the function model (generate.ts), else the free fallback of
// its kind: an image on the person's ChatGPT plan (codex-image.ts), speech in the local voice
// (generate-local.ts). Music, sound effects and video have no free route (nothing runs on this PC, no plan
// makes them), so their "not set up" error names the key that turns them on. The use's value can name the free
// route itself ("local" for speech, "codex" for images – a choice in Settings › Models): then it goes first, whatever
// else is connected. A route that fails before
// anything was made or charged (account, key, URL or model unusable – generate-http.ts mayFallBack) hands the
// request to the fallback; one that may have been charged never does (no blind retry).
// Owns: the route choice, the fallback rule and the run of a route. Never: stores files or books usage.

import type { RuntimeServices } from '../contracts.ts';
import type { Account } from '../../shared/model/providers.ts';
import { FREE_ROUTE_CHOICE, useValue } from '../../shared/model/models-uses.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { codexImage, codexImageAccount } from './codex-image.ts';
import { DEADLINE_MS, generateMedia, mayFallBack, notSetUp, resolveTarget, type GenerateOptions, type GenerateServices, type MediaTarget } from './generate.ts';
import { localVoiceReady, speakLocally } from './generate-local.ts';
import type { Generated, GenerationKind, GenerationRequest } from './providers/types.ts';

export type RouteServices = GenerateServices & Pick<RuntimeServices, 'engines' | 'paths' | 'log' | 'stt'>;

export type Route =
  | { via: 'model'; target: MediaTarget }
  | { via: 'plan'; account: Account }
  | { via: 'local' };

export interface Routes {
  first?: Route;
  /** The free route a failed first one hands over to (unset: none, or it is the first). */
  fallback?: Route;
  /** No route: why (turned off, not set up …). */
  error?: WorkforceError;
  /** Why the first route is a fallback although a model was asked for (the chosen one is not available). */
  note?: string;
}

/** What a route made, with the model or source shown to the agent. */
export type Made = Generated & { via: Route['via']; model: string; voice?: string; language?: string };

/** The free route of `kind` on this PC, when there is one. */
function freeRoute(s: RouteServices, kind: GenerationKind): Route | undefined {
  if (kind === 'image') { const account = codexImageAccount(s); return account ? { via: 'plan', account } : undefined; }
  if (kind === 'speech' && localVoiceReady(s)) return { via: 'local' };
  return undefined;
}

/** The routes of `kind` now (no network): the model first, the free route as its fallback (see the header). */
export function routesFor(s: RouteServices, kind: GenerationKind): Routes {
  const named = (kind === 'speech' || kind === 'image') && useValue(s.settings.get().routing, kind === 'speech' ? 'tts' : 'image') === FREE_ROUTE_CHOICE[kind] ? freeRoute(s, kind) : undefined;
  if (named) return { first: named };
  const { target, error, off } = resolveTarget(s, kind);
  if (off) return { error };
  const free = freeRoute(s, kind);
  if (target) return { first: { via: 'model', target }, ...(free ? { fallback: free } : {}) };
  if (!free && kind === 'speech' && (!error || error.message === notSetUp(kind).message)) {
    return { error: new WorkforceError('unavailable', 'Speech generation is not set up: the local voice cannot run on this PC; add a Gemini API key or an ElevenLabs key (Settings › Models).') };
  }
  if (!free) return { error: error ?? notSetUp(kind) };
  const chosenGone = error && mayFallBack(error) ? error.message : undefined;
  return { first: free, ...(chosenGone ? { note: chosenGone } : {}) };
}

const SOURCE: Record<'plan' | 'local', string> = { plan: 'the ChatGPT plan', local: 'the local voice' };

/** Runs one route. */
export async function runRoute(s: RouteServices, route: Route, request: GenerationRequest, options: GenerateOptions & { agentId?: string; onStatus?: (note: string) => void } = {}): Promise<Made> {
  if (route.via === 'model') {
    const made = await generateMedia(s, route.target, request, options);
    return { ...made, via: 'model', model: route.target.modelId, ...(request.voice ? { voice: request.voice } : {}), ...(request.language ? { language: request.language } : {}) };
  }
  if (route.via === 'plan') {
    const made = await codexImage(s, route.account, request, { signal: options.signal, timeoutMs: options.timeoutMs ?? DEADLINE_MS.image, agentId: options.agentId });
    return { ...made, via: 'plan' };
  }
  // The local voice's speaking deadline grows with the text (generate-local.ts localSpeakMs), unless a caller sets one.
  const made = await speakLocally(s, request, { signal: options.signal, timeoutMs: options.timeoutMs, onStatus: options.onStatus });
  return { ...made, via: 'local' };
}

/**
 * The first route, and the fallback when the first failed before anything was made or charged. `note` on
 * the result says why a fallback made it ("…; made with the ChatGPT plan instead").
 */
export async function generateRouted(s: RouteServices, routes: Routes, request: GenerationRequest, options: GenerateOptions & { agentId?: string; onStatus?: (note: string) => void } = {}): Promise<Made & { note?: string }> {
  if (!routes.first) throw routes.error ?? new WorkforceError('unavailable', 'This kind of media cannot be made here.');
  try {
    const made = await runRoute(s, routes.first, request, options);
    return routes.note && routes.first.via !== 'model' ? { ...made, note: `${routes.note} Made with ${SOURCE[routes.first.via]} instead.` } : made;
  } catch (error) {
    const fallback = routes.fallback;
    if (!fallback || fallback.via === 'model' || !mayFallBack(error) || options.signal?.aborted) throw error;
    options.onStatus?.(`trying ${SOURCE[fallback.via]}`);
    const made = await runRoute(s, fallback, request, options);
    return { ...made, note: `${(error as WorkforceError).message} Made with ${SOURCE[fallback.via]} instead.` };
  }
}
