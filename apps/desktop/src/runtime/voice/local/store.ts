// B-047 D14: where the local speech models live – <data>/models/speech/<id>/ with the model's files and a
// manifest (.installed.json: id and the archive's SHA-256) written last by the download (download.ts), so
// a folder counts as installed only when the manifest names the catalog's current archive and every file
// the model needs is there and not empty. Partial downloads and unpack folders sit next to it as
// .<id>.part and .<id>.unpack (download.ts removes or resumes them).
// Owns: the paths and the installed check. Never: downloads, deletes or loads a model.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LocalSpeechModel } from '../../../shared/model/local-speech-models.ts';

export const MANIFEST = '.installed.json';

/** <data>/models/speech – every local speech model's parent folder. */
export const speechRoot = (dataDir: string) => path.join(dataDir, 'models', 'speech');

/** The folder of one model. */
export const modelDir = (dataDir: string, model: Pick<LocalSpeechModel, 'id'>) => path.join(speechRoot(dataDir), model.id);

/** The partial download and the unpack folder of one model. */
export const partFile = (dataDir: string, model: Pick<LocalSpeechModel, 'id'>) => path.join(speechRoot(dataDir), `.${model.id}.part`);
export const unpackDir = (dataDir: string, model: Pick<LocalSpeechModel, 'id'>) => path.join(speechRoot(dataDir), `.${model.id}.unpack`);

const nonEmpty = (file: string): boolean => {
  try { return statSync(file).size > 0; } catch { return false; }
};

/** The model is downloaded (current archive) and complete. */
export function isInstalled(dataDir: string, model: LocalSpeechModel): boolean {
  const dir = modelDir(dataDir, model);
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')) as { id?: unknown; sha256?: unknown };
    if (manifest.id !== model.id || manifest.sha256 !== model.download.sha256) return false;
  } catch { return false; }
  return model.files.every((file) => nonEmpty(path.join(dir, file)));
}
