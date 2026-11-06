// RPC handlers: feedback reports, the app's look (theme.get – <data>/theme.css, runtime/root/theme.ts),
// onboarding, the one-time legacy import and voice transcription.
// Owns: param checks and scope rules. Requests from a client are always authored by the human; `theme.get` is
// open to every authenticated device and to employees' devices (they all look the same). Writing and listing feedback and dictation need
// 'chat'; so do `feedback.send`, `feedback.dismiss` and `feedback.status` (whether this build can send at all):
// Send seals the report for the team (B-055); the team inbox and setup are owner-only (handlers/feedback-inbox.ts).
// Onboarding and the legacy import stay owner-only. Local speech: voice.localModels and voice.speak need 'chat',
// voice.pullLocal (a download) is owner-only.
// Never: implements feedback/onboarding/voice behaviour (extras do), or uploads anything.

import type { FeedbackKind } from '../../../shared/model/system.ts';
import { AUDIO_TAGGER, localSpeechIds } from '../../../shared/model/local-speech-models.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { readTheme } from '../../root/theme.ts';
import { bad, input, oneOf, onlyKeys, optId, optText, text, type Obj } from '../params.ts';
import type { Handler, HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;

const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'change', 'praise'];
const SHA256 = /^[0-9a-f]{64}$/;

function fileId(o: Obj, key: string): string {
  const value = o[key];
  if (typeof value !== 'string' || !SHA256.test(value)) bad(key, 'a file id');
  return value;
}

function optFileId(o: Obj, key: string): string | undefined {
  return o[key] === undefined || o[key] === null ? undefined : fileId(o, key);
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- feedback
  table.add('feedback.create', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['kind', 'text', 'screenshotFileId', 'annotationFileId', 'view', 'conversationId']);
    return ctx.extras.feedback.create({
      kind: oneOf(o, 'kind', FEEDBACK_KINDS),
      text: text(o, 'text', { max: 20_000, multiline: true }),
      screenshotFileId: optFileId(o, 'screenshotFileId'),
      annotationFileId: optFileId(o, 'annotationFileId'),
      view: optText(o, 'view', { max: 120 }),
      conversationId: optId(o, 'conversationId'),
      author: HUMAN_ID,
    });
  }, CHAT);
  table.add('feedback.list', (_params, ctx) => ctx.extras.feedback.list(), CHAT);
  // B-055: `receiving` (this PC holds the team's key: Settings › Feedback shows the inbox) only ever for the owner.
  table.add('feedback.status', (_params, ctx) => {
    const status = ctx.extras.feedback.status?.();
    return { sending: status?.sending === true, receiving: ctx.scope.kind === 'owner' && status?.receiving === true };
  }, CHAT);
  table.add('feedback.send', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'visibility']);
    const visibility = o.visibility === undefined ? 'public' : oneOf(o, 'visibility', ['public', 'private'] as const);
    return ctx.extras.feedback.send(text(o, 'id', { max: 128 }), { reveal: ctx.scope.kind === 'owner', visibility });
  }, CHAT);
  table.add('feedback.dismiss', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return ctx.extras.feedback.dismiss(text(o, 'id', { max: 128 }));
  }, CHAT);

  // ---------------------------------------------------------------- the app's look
  const theme: Handler<'theme.get'> = (_params, ctx) => ({ css: readTheme(ctx.services.paths.data, ctx.services.log) });
  table.add('theme.get', theme, 'any');
  table.addPerson('theme.get', theme); // an employee's device looks the same

  // ---------------------------------------------------------------- onboarding & import
  table.add('onboarding.reset', (_params, ctx) => { // "Set up team again" (owner only): the first-run layer again
    ctx.extras.onboarding.reset();
    return { ok: true };
  });
  // B-044: the first-run cards are through – the Manager's first chat and the app's start text there as the person's line (owner only).
  table.add('onboarding.start', (params, ctx) => {
    onlyKeys(input(params), []);
    return ctx.extras.onboarding.start();
  });
  table.add('import.legacy', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['path']);
    return { imported: await ctx.extras.importLegacy(optText(o, 'path', { max: 1024 })) };
  });

  // ---------------------------------------------------------------- voice
  table.add('voice.transcribe', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['fileId', 'language']);
    const language = optText(o, 'language', { max: 16 });
    if (language !== undefined && !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) bad('language', 'a language code like "de" or "en-US"');
    return ctx.extras.voice.transcribe({ fileId: fileId(o, 'fileId'), language });
  }, CHAT);
  // B-047 D14: local speech – the list and the voice for every chat device (the phone reads answers through
  // the PC's voice), the download for the owner only (it writes to disk and chooses the model).
  table.add('voice.localModels', (params, ctx) => {
    onlyKeys(input(params), []);
    return ctx.extras.voice.localModels();
  }, CHAT);
  table.add('voice.pullLocal', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    const id = text(o, 'id', { max: 80 });
    // B-058 (T7): also the sound tagger (only downloaded, never chosen)
    if (!localSpeechIds('stt').includes(id) && !localSpeechIds('tts').includes(id) && id !== AUDIO_TAGGER.id) bad('id', 'a local speech model id from voice.localModels');
    return ctx.extras.voice.pullLocal(id);
  });
  table.add('voice.speak', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['text', 'voice', 'language']);
    const voice = optText(o, 'voice', { max: 8 });
    if (voice !== undefined && !/^\d{1,2}$/.test(voice)) bad('voice', 'a speaker number like "0"');
    const language = optText(o, 'language', { max: 16 });
    if (language !== undefined && !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(language)) bad('language', 'a language code like "de" or "en-US"');
    return ctx.extras.voice.speak({ text: text(o, 'text', { max: 2_000, multiline: true }), voice, language });
  }, CHAT);
}
