// <data>/pages/<name>.html|js – views anyone adds to the app: a file there is a tab on the pane's "+" page, shown in a frame that
// talks through the existing RPC (ui/workspace/PageView.tsx, wf.rpc). A .js file is a module in an empty page. The
// RootWatcher hands a change here and every window gets the new list at once ('pages.updated'; an edited page reloads).
// Owns: which files are pages, reading one and that event. Never: checks, reviews or versions what a page does.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { WorkforceError } from '../../shared/errors.ts';
import type { PageInfo } from '../../shared/api/methods-pages.ts';
import type { Bus } from '../bus.ts';
import { ROOT_PAGES } from './layout.ts';
import { readText } from './text-doc.ts';
import type { RootWatcher } from './watcher.ts';

const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const PAGE_FILE = /^([^.][^/\\]*)\.(html|js)$/i;

/** Every page in <data>/pages, by name (a name with both files is its .html). */
export function listPages(dataDir: string): PageInfo[] {
  const dir = path.join(dataDir, ROOT_PAGES);
  const pages = new Map<string, PageInfo>();
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const file of names.sort()) {
    const match = PAGE_FILE.exec(file);
    if (!match) continue;
    const name = match[1];
    if (pages.has(name) && !/\.html$/i.test(file)) continue;
    try {
      const info = statSync(path.join(dir, file));
      if (info.isFile()) pages.set(name, { name, path: path.join(dir, file), updatedAt: info.mtimeMs });
    } catch { /* gone meanwhile */ }
  }
  return [...pages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What the frame loads for page `name`: an .html as it is, a .js as a module in an empty page. */
export function pageHtml(dataDir: string, name: string): string {
  const page = listPages(dataDir).find((item) => item.name === name);
  if (!page) throw new WorkforceError('not_found', `There is no page "${name}" in ${path.join(dataDir, ROOT_PAGES)}.`);
  const read = readText(page.path, { maxBytes: PAGE_MAX_BYTES });
  if (read.kind !== 'ok') throw new WorkforceError('not_found', `Page "${name}" cannot be read.`);
  if (/\.html$/i.test(page.path)) return read.text;
  return `<!doctype html><html><head><title>${name.replace(/[<&]/g, '')}</title></head><body><script type="module">${read.text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}

export interface PagesDeps {
  dataDir: string;
  root: Pick<RootWatcher, 'register'>;
  bus: Pick<Bus, 'emit'>;
}

/** Makes <data>/pages a watched entry: every change emits the new list. Returns the stop function. */
export function watchPages(deps: PagesDeps): () => void {
  return deps.root.register(ROOT_PAGES, () => deps.bus.emit('pages.updated', { pages: listPages(deps.dataDir) }));
}
