// AF-019: the update source of this PC (Settings › Updates) in `<data>/update-source.json`:
// { "repository": "owner/name", "channel": "stable" | "prerelease", "autoCheck": true }.
// It belongs to the PC like the installed app (updates are PC-only), so it is not part of settings.json, which syncs.
// A missing or broken file means this build's defaults (source.ts).
// Owns: reading and the atomic write of that file. Never: talks to the updater or the network.

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SOURCE, normalizeSource } from './source.ts';
import type { UpdateSource } from './source.ts';

export const SOURCE_FILE = 'update-source.json';

export function sourceFile(dataDir: string): string { return path.join(dataDir, SOURCE_FILE); }

export async function loadUpdateSource(dataDir: string): Promise<UpdateSource> {
  try {
    const text = await readFile(sourceFile(dataDir), 'utf8');
    if (text.length > 4096) return { ...DEFAULT_SOURCE };
    return normalizeSource(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SOURCE };
  }
}

let writing: Promise<void> = Promise.resolve(); // one write at a time, in call order

/** Temp file + rename; resolves once written (a failure rejects: the settings page says it could not save). */
export function saveUpdateSource(dataDir: string, source: UpdateSource): Promise<void> {
  const file = sourceFile(dataDir);
  const run = async () => {
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(normalizeSource(source), null, 2)}\n`, 'utf8');
    await rename(temp, file);
  };
  const next = writing.then(run, run);
  writing = next.catch(() => {});
  return next;
}
