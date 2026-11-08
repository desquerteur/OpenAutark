// AF-018: the Projects tab's pure helpers – the list's order, a project's one-line git state, the session rows'
// texts and the composer's placeholder – so the views stay thin and the rules are testable without a DOM.
// Owns: these derivations. Never: reads stores, calls the runtime or renders.

import type { Project, ProjectGit } from '../../shared/model/project.ts';

/** Pinned first, then the newest activity, then by name – the runtime sends this order; a live upsert keeps it. */
export function orderProjects(list: readonly Project[]): Project[] {
  return [...list].sort((a, b) =>
    Number(b.pinned) - Number(a.pinned)
    || b.lastActiveAt - a.lastActiveAt
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Puts `project` into the list (replacing the same id) and keeps the order. */
export function upsertProject(list: readonly Project[], project: Project): Project[] {
  return orderProjects([...list.filter((entry) => entry.id !== project.id), project]);
}

export function removeProject(list: readonly Project[], id: string): Project[] {
  return list.filter((entry) => entry.id !== id);
}

/** "3 changed" / "1 changed" ('' when the tree is clean). */
export function changedLabel(dirty: number): string {
  return dirty > 0 ? `${dirty} changed` : '';
}

/** "↑2 ↓1" against the upstream ('' when even with it or without one). */
export function syncLabel(git: Pick<ProjectGit, 'ahead' | 'behind'>): string {
  return [git.ahead > 0 ? `↑${git.ahead}` : '', git.behind > 0 ? `↓${git.behind}` : ''].filter(Boolean).join(' ');
}

/** The branch name, or the short sha for a detached HEAD. */
export function branchLabel(git: Pick<ProjectGit, 'branch' | 'head'>): string {
  return git.branch ?? (git.head ? `detached at ${git.head}` : 'no commits yet');
}

/** The list row's second line: branch · changes · sync, or why there is no git state. */
export function projectLine(project: Pick<Project, 'git' | 'missing' | 'folder'>): string {
  if (project.missing) return 'Folder not found';
  const git = project.git;
  if (!git) return 'Not a git repository';
  return [branchLabel(git), changedLabel(git.dirty), syncLabel(git)].filter(Boolean).join(' · ');
}

/** Sessions with an agent answering right now. */
export function workingCount(project: Pick<Project, 'sessions'>): number {
  return project.sessions.filter((session) => session.working).length;
}

/** The big composer's placeholder. */
export function composerPlaceholder(name: string): string {
  return `What should happen in ${name}?`;
}

/** The folder's last segment (a name for a path the person typed or dropped before the runtime answered). */
export function folderName(folder: string): string {
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || folder;
}

/** Who works in the project, for the page's line: "Nobody yet – a new session hires an agent from the folder." */
export function agentsLine(project: Pick<Project, 'agents'>): string {
  if (!project.agents.length) return 'Nobody yet – your first session hires an agent from this folder.';
  return project.agents.map((agent) => agent.name).join(', ');
}
