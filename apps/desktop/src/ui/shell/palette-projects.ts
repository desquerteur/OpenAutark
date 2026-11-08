// AF-018: the command palette's project entries – "Open project: <name>" and "New session in <name>" per project
// (both open the project's page, where the new session's prompt is typed), then "Add project…" (the folder dialog,
// then projects.add) where this window can choose a folder. Owner only: anyone else gets none. Pure – the palette
// (CommandPalette.tsx) attaches what each entry does.
// Owns: which entries there are and their words. Never: runs them, loads projects or reads folders.

import type { Project } from '../../shared/model/project.ts';

export type ProjectEntryKind = 'open' | 'new-session' | 'add';

export interface ProjectEntry {
  id: string;
  kind: ProjectEntryKind;
  label: string;
  /** The folder's last two parts, so two projects of one name can be told apart. */
  hint?: string;
  projectId?: string;
}

export const PROJECTS_GROUP = 'Projects';

/** A folder's last two parts ('C:\\code\\autark' → 'code\\autark'), keeping its own separator. */
export function shortFolder(folder: string): string {
  const separator = folder.includes('\\') ? '\\' : '/';
  return folder.split(/[\\/]/).filter(Boolean).slice(-2).join(separator);
}

/** The palette's project entries: per project open and new session (the runtime's order), then Add project…. */
export function projectEntries(projects: readonly Project[], options: { owner: boolean; canPick: boolean }): ProjectEntry[] {
  if (!options.owner) return [];
  const entries: ProjectEntry[] = [];
  for (const project of projects) {
    const hint = project.missing ? 'Folder missing' : shortFolder(project.folder);
    entries.push({ id: `p:${project.id}`, kind: 'open', label: `Open project: ${project.name}`, hint, projectId: project.id });
    if (!project.missing) entries.push({ id: `p:${project.id}:new`, kind: 'new-session', label: `New session in ${project.name}`, projectId: project.id });
  }
  if (options.canPick) entries.push({ id: 'p:add', kind: 'add', label: 'Add project…' });
  return entries;
}
