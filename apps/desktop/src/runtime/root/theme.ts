// <data>/theme.css – the app's look as one plain file. The person or any agent edits it with a normal file write;
// the RootWatcher hands the change here and every window gets the new text at once ('theme.updated'; the desktop
// window and phones put it in a <style> after the app's own styles, ui/main.tsx). Going back = editing or deleting
// the file. On the first start after the versioned overlay went, <data>/custom/theme.css moves here once.
// Owns: reading the file (bounded), the event and that one move. Never: checks, rewrites or versions the CSS.

import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.ts';
import type { Logger } from '../contracts.ts';
import { ROOT_THEME } from './layout.ts';
import { readText } from './text-doc.ts';
import type { RootWatcher } from './watcher.ts';

/** A larger theme.css is not applied (logged). */
export const THEME_MAX_BYTES = 512 * 1024;

/** The CSS of <data>/theme.css ('' when there is none or it cannot be used). */
export function readTheme(dataDir: string, log?: Logger): string {
  const read = readText(path.join(dataDir, ROOT_THEME), { maxBytes: THEME_MAX_BYTES });
  if (read.kind === 'problem') log?.warn('theme.css not applied', { problem: read.problem });
  return read.kind === 'ok' ? read.text : '';
}

export interface ThemeDeps {
  dataDir: string;
  root: Pick<RootWatcher, 'register'>;
  bus: Pick<Bus, 'emit'>;
  log?: Logger;
}

/** Makes theme.css a watched entry: every change (also its removal) emits 'theme.updated'. Returns the stop function. */
export function watchTheme(deps: ThemeDeps): () => void {
  moveOldTheme(deps.dataDir, deps.log);
  return deps.root.register(ROOT_THEME, () => deps.bus.emit('theme.updated', { css: readTheme(deps.dataDir, deps.log) }));
}

/** <data>/custom/theme.css of the old overlay becomes <data>/theme.css (only while there is none). */
function moveOldTheme(dataDir: string, log?: Logger): void {
  const old = path.join(dataDir, 'custom', 'theme.css');
  const file = path.join(dataDir, ROOT_THEME);
  if (!existsSync(old) || existsSync(file)) return;
  try { renameSync(old, file); } catch (error) { log?.warn('old theme.css not moved', { error: String(error) }); }
}
