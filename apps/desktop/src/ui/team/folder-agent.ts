// AF-014: opening "Agent from folder" – from the Team's Add menu, a folder dropped on the window or the Team list, and
// the Explorer's right-click menu (main sends the folder as a navigate request). A dropped folder's path comes from the
// desktop bridge (Electron's webUtils.getPathForFile); a `file://` URL in the drop (other file managers, tests) works too.
// Also the sidebar's "Group agents by folder" switch (kept in this window's localStorage) and its grouping.
// Owns: these signals and the drop reading. Never: renders or creates agents (FolderAgentDialog.tsx).

import { signal } from '@preact/signals';
import { bridge } from '../lib/platform.ts';
import type { Agent } from '../../shared/model/org.ts';

/** The open dialog (null: closed); `folder` prefilled when it came from a drop or the Explorer. */
export const folderAgentRequest = signal<{ folder?: string } | null>(null);

export function openFolderAgent(folder?: string): void {
  folderAgentRequest.value = folder ? { folder } : {};
}

const GROUP_KEY = 'wf.teamByFolder';
function readGrouped(): boolean {
  try { return localStorage.getItem(GROUP_KEY) === '1'; } catch { return false; }
}
export const groupByFolder = signal<boolean>(readGrouped());
export function setGroupByFolder(on: boolean): void {
  groupByFolder.value = on;
  try { localStorage.setItem(GROUP_KEY, on ? '1' : '0'); } catch { /* this window only */ }
}

/** A `file://` URL as a local path ('' when it is none). */
export function fileUrlPath(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'file:') return '';
    const raw = decodeURIComponent(parsed.pathname);
    return /^\/[a-zA-Z]:\//.test(raw) ? raw.slice(1).replace(/\//g, '\\') : raw;
  } catch { return ''; }
}

/** Whether a drag carries something that may be a folder (files or a file URL). */
export function mayHoldFolder(data: DataTransfer | null): boolean {
  const types = data ? [...data.types] : [];
  return types.includes('Files') || types.includes('text/uri-list');
}

/** The folder a drop holds: the first dropped directory's path, else a file:// URL; undefined when none. */
export function droppedFolder(data: DataTransfer | null): string | undefined {
  if (!data) return undefined;
  const items = [...(data.items ?? [])];
  for (const [index, item] of items.entries()) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.();
    if (!entry?.isDirectory) continue;
    const file = item.getAsFile() ?? data.files[index];
    const found = file ? bridge?.files.pathOf?.(file) : undefined;
    if (found) return found;
  }
  const url = (data.getData('text/uri-list') || '').split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  const fromUrl = url ? fileUrlPath(url) : '';
  return fromUrl || undefined;
}

/** A home project as folderAgents.homes lists it. */
export type Home = { agentId: string; folder: string; label: string };

/** Agents by folder (folders by name, agents by name), then those without one. */
export function folderGroups(agents: readonly Agent[], homes: readonly Home[]): Array<{ folder?: string; label: string; agents: Agent[] }> {
  const byAgent = new Map(homes.map((home) => [home.agentId, home]));
  const groups = new Map<string, { folder: string; label: string; agents: Agent[] }>();
  const rest: Agent[] = [];
  for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
    const home = byAgent.get(agent.id);
    if (!home) { rest.push(agent); continue; }
    const key = home.folder.toLowerCase();
    const group = groups.get(key) ?? { folder: home.folder, label: home.label, agents: [] };
    group.agents.push(agent);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.folder.localeCompare(b.folder));
  return [...sorted, ...(rest.length ? [{ label: 'No folder', agents: rest }] : [])];
}
