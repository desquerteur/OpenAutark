// B-058 (T7, Settings › Voice "Remove"): deletes one downloaded local speech model (speech to text or a voice)
// from this PC – its folder under <data>/models/speech (voice/local/store.ts) and a partial download left
// beside it. A model that is chosen is unchosen first (voice.localStt / localTts → ''), so dictation and
// reading move on at once and the automatic download (voice/local/auto.ts) remembers the removal as the
// person's own and does not fetch it again. Silero VAD stays (every speech-to-text model shares it, 1 MB).
// A model that is still unpacking is refused (its download is running). A resident model keeps answering
// from memory until the engine unloads it (sherpa reads the files whole; nothing stays open).
// Owns: this removal. Never: removes the audio tagger or the VAD, downloads, or touches other settings.

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { RuntimeServices } from '../contracts.ts';
import { localSpeechModel } from '../../shared/model/local-speech-models.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { isInstalled, modelDir, partFile, unpackDir } from '../voice/local/store.ts';

export type RemoveServices = Pick<RuntimeServices, 'paths' | 'settings' | 'log'>;

/** voice.removeLocal: removes the downloaded model `id` (see the header). */
export async function removeLocalModel(s: RemoveServices, id: string): Promise<{ ok: true }> {
  const model = localSpeechModel(id);
  if (!model || (model.purpose !== 'stt' && model.purpose !== 'tts')) throw new WorkforceError('bad_request', `Unknown local speech model: ${id}.`);
  const data = s.paths.data;
  if (existsSync(unpackDir(data, model))) throw new WorkforceError('conflict', `${model.label} is still being downloaded. Try again when it is done.`);
  if (!isInstalled(data, model) && !existsSync(modelDir(data, model)) && !existsSync(partFile(data, model))) return { ok: true };
  const voice = s.settings.get().voice;
  if (model.purpose === 'stt' && voice?.localStt === model.id) s.settings.update({ voice: { localStt: '' } });
  if (model.purpose === 'tts' && voice?.localTts === model.id) s.settings.update({ voice: { localTts: '' } });
  try {
    await rm(modelDir(data, model), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    await rm(partFile(data, model), { force: true });
  } catch (error) {
    s.log.warn('local speech model not removed', { model: model.id, error: String(error) });
    throw new WorkforceError('unavailable', `${model.label} could not be removed from this PC. Close what uses it and try again.`);
  }
  s.log.info('local speech model removed', { model: model.id });
  return { ok: true };
}
