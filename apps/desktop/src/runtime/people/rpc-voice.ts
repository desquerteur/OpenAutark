// What a person's device may call (F-52), speech: so people talk in live calls (and dictate) like the
// owner's phone – the page records an utterance, uploads it and has the PC's transcription service turn it
// into text (shared/voice/conversation.ts, lib/dictation.ts). The person variants are narrow:
//  * files.upload takes only an utterance – audio, at most UTTERANCE_MAX_BYTES (one inline upload), at most
//    UTTERANCE_LIMITS per person and ten minutes (well above continuous speech; 'rate_limited' beyond). The
//    blob is attached to nothing, so no one may read it (people/access.ts mayReadFile wants an attachment of
//    a readable message) and the person cannot attach it either (their files go through people/uploads.ts);
//    it is queued for the blob clean-up at once, due after TRANSCRIBE_WINDOW_MS (files/cleanup.ts keeps
//    what something uses), so an utterance nobody transcribes does not stay on the owner's disk;
//  * voice.transcribe transcribes only an utterance this person uploaded in the last TRANSCRIBE_WINDOW_MS,
//    once (kept in memory per person, bounded) – never another file of the PC; the people's transcriptions
//    run one after another (one per person, a short queue), so they bill the owner's speech-to-text account
//    once per utterance and never hold both of the transcriber's dictation slots (the owner keeps one);
//  * models.list tells only whether speech-to-text is there: the transcription-capable models with their
//    account ids removed, and none when the owner switched speech to text off – nothing of the owner's chat
//    models, accounts or routing.
// The audio goes to the transcription service the owner set up (on the owner's account, like agents'
// turns for people). Every call first checks that the person's access still holds (rpc-base.ts caller).
// Owns: these variants, the per-person upload list, limits and transcription queue. Never: the owner's
// handlers, other files or keys.

import { WorkforceError } from '../../shared/errors.ts';
import { FUNCTION_OFF } from '../../shared/model/providers.ts';
import { useValue } from '../../shared/model/models-uses.ts';
import type { ModelInfo } from '../../shared/model/providers.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { base64Length, decodeBase64 } from '../rpc/uploads.ts';
import { bad, input, onlyKeys, optText, text } from '../rpc/params.ts';
import type { HandlerTable } from '../rpc/table.ts';
import { caller } from './rpc-base.ts';

/** One utterance (one inline upload, below the 6 MB client frame, http/ws.ts): a 16 kHz WAV dictation of about two minutes – longer takes are said in parts. */
export const UTTERANCE_MAX_BYTES = 4 * 1024 * 1024;
export const TRANSCRIBE_WINDOW_MS = 10 * 60_000;
/** Per person and ten minutes: utterances and their bytes (continuous speech stays far below both). */
export const UTTERANCE_LIMITS = { perTenMinutes: 120, bytesPerTenMinutes: 24 * 1024 * 1024 } as const;
/** The people's transcriptions waiting or running at once (one per person). */
export const PEOPLE_HEARING_MAX = 8;
const TEN_MINUTES = 10 * 60_000;
const RECENT_PER_PERSON = 24;
const AUDIO_MIME = /^audio\/[a-z0-9.+-]+(?:\s*;.*)?$/i;
const AUDIO_NAME = /\.(?:webm|ogg|oga|opus|m4a|mp4|mp3|wav|aac|flac)$/i;
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const FILE_ID = /^[0-9a-f]{64}$/i;

/** The people's utterances (per runtime, in memory, bounded): what each sent lately, what is still to transcribe, who is heard. */
export class RecentUtterances {
  private readonly byPerson = new Map<string, Map<string, number>>(); // not transcribed yet: file id → when
  private readonly sent = new Map<string, Array<{ at: number; bytes: number }>>(); // the last ten minutes' uploads
  private readonly hearing = new Set<string>(); // people with a transcription waiting or running
  private queue: Promise<unknown> = Promise.resolve();

  /** Counts one more utterance of `bytes` – or 'rate_limited' when it would pass the person's limits. */
  admit(personId: string, bytes: number, now: number): void {
    const recent = (this.sent.get(personId) ?? []).filter((entry) => now - entry.at < TEN_MINUTES);
    this.sent.set(personId, recent);
    const used = recent.reduce((sum, entry) => sum + entry.bytes, 0);
    if (recent.length >= UTTERANCE_LIMITS.perTenMinutes || used + bytes > UTTERANCE_LIMITS.bytesPerTenMinutes) {
      throw new WorkforceError('rate_limited', 'Too much speech was sent in a short time. Wait a few minutes.', { retryAfterMs: Math.max(1000, (recent[0]?.at ?? now) + TEN_MINUTES - now) });
    }
    recent.push({ at: now, bytes });
  }

  note(personId: string, fileId: string, at: number): void {
    const own = this.byPerson.get(personId) ?? new Map<string, number>();
    own.delete(fileId);
    own.set(fileId, at);
    while (own.size > RECENT_PER_PERSON) own.delete(own.keys().next().value as string);
    this.byPerson.set(personId, own);
  }

  /** The person uploaded this utterance within the window and it was not transcribed yet. */
  has(personId: string, fileId: string, now: number): boolean {
    const at = this.byPerson.get(personId)?.get(fileId);
    return at !== undefined && now - at <= TRANSCRIBE_WINDOW_MS;
  }

  /** Takes the utterance for its one transcription: true when it was theirs and still open. */
  take(personId: string, fileId: string, now: number): boolean {
    if (!this.has(personId, fileId, now)) return false;
    this.byPerson.get(personId)!.delete(fileId);
    return true;
  }

  /** Is a transcription of this person waiting or running? */
  busy(personId: string): boolean {
    return this.hearing.has(personId);
  }

  /** Runs one transcription of the person after the people's earlier ones (one per person, PEOPLE_HEARING_MAX in all). */
  async hear<T>(personId: string, run: () => Promise<T>): Promise<T> {
    if (this.hearing.has(personId)) throw new WorkforceError('conflict', 'Your last recording is still being transcribed. Try again in a moment.');
    if (this.hearing.size >= PEOPLE_HEARING_MAX) throw new WorkforceError('conflict', 'Many recordings are being transcribed right now. Try again in a moment.');
    this.hearing.add(personId);
    const job = this.queue.then(run);
    this.queue = job.catch(() => undefined);
    try { return await job; } finally { this.hearing.delete(personId); }
  }
}

const recent = new WeakMap<object, RecentUtterances>();
const recentOf = (services: object): RecentUtterances => {
  let list = recent.get(services);
  if (!list) { list = new RecentUtterances(); recent.set(services, list); }
  return list;
};

/** The transcription models as a person's device may know them: available or not, no accounts. */
export function personSpeechModels(models: readonly ModelInfo[], sttSetting: string | undefined): ModelInfo[] {
  if (sttSetting === FUNCTION_OFF) return [];
  return models.filter((model) => model.functions?.includes('stt')).map((model) => ({ ...model, accounts: [], strengths: {}, functions: ['stt'] }));
}

export function registerPersonVoice(table: HandlerTable): void {
  table.addPerson('files.upload', async (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['name', 'mime', 'dataBase64']);
    const name = text(o, 'name', { max: 200 });
    const mime = optText(o, 'mime', { max: 120 });
    if (mime !== undefined ? !AUDIO_MIME.test(mime) : !AUDIO_NAME.test(name)) {
      throw new WorkforceError('forbidden', 'Only recorded speech can be sent from here.', { details: { reason: 'utterance_only' } });
    }
    const bytes = decodeBase64(text(o, 'dataBase64', { max: base64Length(UTTERANCE_MAX_BYTES) + 4 }), 'dataBase64');
    if (!bytes.length) bad('dataBase64', 'recorded audio');
    if (bytes.length > UTTERANCE_MAX_BYTES) throw new WorkforceError('bad_request', 'This recording is too long. Say it in shorter parts.');
    const list = recentOf(ctx.services);
    const before = ctx.services.clock.now();
    list.admit(person.id, bytes.length, before);
    const ref = await ctx.services.files.put(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), name, mime);
    const now = ctx.services.clock.now();
    list.note(person.id, ref.id, now);
    // Bytes the store already had are not this upload's to give back; a new utterance goes after the window.
    if (ref.createdAt >= before) {
      try { reclaimerOf(ctx.services.files)?.reclaim([ref.id], { notBefore: now + TRANSCRIBE_WINDOW_MS }); } catch { /* the clean-up logs its own failures */ }
    }
    return ref;
  });
  table.addPerson('voice.transcribe', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['fileId', 'language']);
    const fileId = text(o, 'fileId', { max: 64 });
    if (!FILE_ID.test(fileId)) bad('fileId', 'the id of a recorded utterance');
    const language = optText(o, 'language', { max: 16 });
    if (language !== undefined && !LANGUAGE.test(language)) bad('language', 'a language code like "de" or "en-US"');
    const list = recentOf(ctx.services);
    const own = fileId.toLowerCase();
    if (!list.has(person.id, own, ctx.services.clock.now())) {
      throw new WorkforceError('forbidden', 'Only your own recording from just now can be transcribed, once.', { details: { reason: 'not_your_utterance' } });
    }
    if (list.busy(person.id)) throw new WorkforceError('conflict', 'Your last recording is still being transcribed. Try again in a moment.');
    list.take(person.id, own, ctx.services.clock.now());
    return list.hear(person.id, () => ctx.extras.voice.transcribe({ fileId: own, language }));
  });
  table.addPerson('models.list', (_params, ctx) => {
    caller(ctx);
    let stt: string | undefined;
    try { stt = useValue(ctx.services.settings.get().routing, 'stt'); } catch { stt = undefined; }
    return personSpeechModels(ctx.services.catalog.list(), stt);
  });
}
