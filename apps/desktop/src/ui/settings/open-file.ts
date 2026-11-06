// Opens a file or folder behind a Settings page, so it is one click away: in the pane's file tab (openInTab), or with the
// system's own app (openInData, files.openPath; also where a narrow window has no pane beside the page). A folder that does
// not exist yet opens the nearest one that does; a file that does not exist yet opens as a new file in the tab.
// Owns: joining the path and that fallback. Never: reads or writes the file.

import { isMobile } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { openFileTab, openFolderTab } from '../workspace/file-tabs.ts';
import { act } from './controls.tsx';

export const joined = (root: string, relative: string): string => {
  const slash = root.includes('\\') ? '\\' : '/';
  return `${root}${slash}${relative.split('/').join(slash)}`;
};

/** The paths to try, the wanted one first (pure). */
export function openCandidates(root: string, relative: string): string[] {
  const parts = relative.split('/');
  return parts.map((_, index) => joined(root, parts.slice(0, parts.length - index).join('/'))).concat(root);
}

/** Opens `relative` (forward slashes) under the data folder or the workspace in a tab of the pane. */
export function openInTab(relative: string, base: 'data' | 'workspace' = 'data'): Promise<unknown> {
  if (isMobile.peek()) return openInData(relative, base);
  return act(async () => {
    const info = await rpc.call('system.root');
    const root = base === 'workspace' ? info.workspace : info.path;
    if (/\.[^/]+$/.test(relative)) { openFileTab(joined(root, relative)); return; }
    for (const candidate of openCandidates(root, relative)) {
      if ((await rpc.call('files.listPath', { path: candidate })).missing) continue;
      openFolderTab(candidate);
      return;
    }
  }, 'Could not open it');
}

/** Opens `relative` (forward slashes) under the data folder or the workspace with the system's own app. */
export function openInData(relative: string, base: 'data' | 'workspace' = 'data'): Promise<unknown> {
  return act(async () => {
    const info = await rpc.call('system.root');
    const tries = openCandidates(base === 'workspace' ? info.workspace : info.path, relative);
    for (const [index, candidate] of tries.entries()) {
      try { return await rpc.call('files.openPath', { path: candidate }); }
      catch (error) { if (index === tries.length - 1) throw error; }
    }
    return undefined;
  }, 'Could not open it');
}
