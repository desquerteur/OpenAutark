// The runtime's edits of <data>/side-tabs.json. Main owns that file and follows outside edits like any other
// (main/workspace-tabs.ts reload): what changes here reaches its window within a second, with the window open or closed.
// A deleted chat's space leaves the file (nothing else changes, and it is rewritten only when it held that space); the
// side pane of a linked PC and of this PC's phone come in as whole spaces (devices/sync/tabs.ts, B-076) through
// readSideTabs / writeSideTabs – the spaces as main writes them, `{version: 2, spaces}`. A file that is no tab file
// (half written, broken by hand) is never written over.
// Owns: these edits and that read. Never: closes a page itself, or decides what a space holds.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chatSpace, isSpace, type SideEntry, type SideSpaces } from '../../shared/api/workspace-browser.ts';
import { ROOT_SIDE_TABS } from './layout.ts';
import { writeAtomic } from './text-doc.ts';

const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** <data>/side-tabs.json */
export const sideTabsFile = (dataDir: string): string => path.join(dataDir, ROOT_SIDE_TABS);

/** The spaces in the file ({} without one); undefined when it is no tab file, so nothing is written over it. */
export function readSideTabs(file: string): SideSpaces | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : undefined; }
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return undefined; }
  if (!plain(doc) || !plain(doc.spaces)) return undefined;
  const out: SideSpaces = {};
  for (const [key, space] of Object.entries(doc.spaces)) {
    if (!isSpace(key) || !plain(space) || !Array.isArray(space.tabs)) continue;
    const tabs = space.tabs.filter((item): item is SideEntry => plain(item) && typeof item.id === 'string');
    if (tabs.length) out[key] = { ...(typeof space.shown === 'string' ? { shown: space.shown } : {}), tabs };
  }
  return out;
}

/** Writes the spaces atomically, in main's own form. */
export function writeSideTabs(file: string, spaces: SideSpaces): void {
  writeAtomic(file, `${JSON.stringify({ version: 2, spaces }, null, 1)}\n`);
}

/** Takes the chat's space out of the file's text; undefined when there is nothing to take out. */
export function withoutChatSpace(text: string, chatId: string): string | undefined {
  const doc = JSON.parse(text) as { spaces?: Record<string, unknown> };
  const key = chatSpace(chatId);
  if (!doc.spaces || !Object.hasOwn(doc.spaces, key)) return undefined;
  delete doc.spaces[key];
  return `${JSON.stringify(doc, null, 1)}\n`;
}

export interface SideTabsOptions {
  bus: { on(event: 'conversation.removed', listener: (data: { id: string }) => void): unknown };
  dataDir: string;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/** From now on a deleted chat's space leaves the file. */
export function watchRemovedChats(options: SideTabsOptions): void {
  const file = path.join(options.dataDir, ROOT_SIDE_TABS);
  options.bus.on('conversation.removed', ({ id }) => {
    try {
      const next = withoutChatSpace(readFileSync(file, 'utf8'), id);
      if (next) writeAtomic(file, next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.log?.warn('side-tabs.json: a deleted chat stays listed', { id, error: String(error) });
    }
  });
}
