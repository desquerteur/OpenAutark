// AF-018: the window's list of projects for the places outside the Projects tab – the chat header's project chip,
// the command palette, "Open as project" on the agent page and in the Agent-from-folder dialog. Owner only: a linked
// device or phone without the owner's right never loads it (projects and folders stay on the PC). Loaded on first
// use and on every connect, kept fresh by project.upserted / project.removed (topic org). Navigation to a project's
// page goes through its hash (#/projects/<id>) – the Projects route lives in the Projects tab's own code.
// Owns: this signal, its loading and the add-and-open call. Never: renders, reads folders or git itself.

import { signal } from '@preact/signals';
import '../../shared/api/methods-projects.ts';
import type { Project } from '../../shared/model/project.ts';
import { rpc } from './rpc.ts';
import { isOwner } from './session.ts';

/** Every project (pinned first, then by activity – the runtime's order); empty for anyone but the owner. */
export const projectList = signal<Project[]>([]);

/** The hash of a project's page. */
export function projectHash(id: string): string {
  return `#/projects/${encodeURIComponent(id)}`;
}

/** Opens a project's page. */
export function openProjectPage(id: string): void {
  location.hash = projectHash(id); // the router follows hashchange
}

/** The list after one project changed: replaced in place, or a new one at the end until the next full load. */
export function withProject(list: readonly Project[], project: Project): Project[] {
  const index = list.findIndex((entry) => entry.id === project.id);
  if (index < 0) return [...list, project];
  const next = [...list];
  next[index] = project;
  return next;
}

async function load(): Promise<void> {
  if (!isOwner()) { projectList.value = []; return; }
  try { projectList.value = await rpc.call('projects.list'); } catch { /* an older runtime: no projects, no chips */ }
}

let wired = false;
/** Loads the list once and keeps it fresh (callers: the chip, the palette, the links). */
export function watchProjects(): void {
  if (wired) return;
  wired = true;
  rpc.on('project.upserted', (project) => { if (isOwner()) projectList.value = withProject(projectList.peek(), project); });
  rpc.on('project.removed', ({ id }) => { projectList.value = projectList.peek().filter((entry) => entry.id !== id); });
  rpc.onOpen(() => { void load(); });
  void load();
}

/** Adds `folder` as a project (adding it again answers the same one) and opens its page. */
export async function addAndOpenProject(folder: string): Promise<Project> {
  const project = await rpc.call('projects.add', { folder });
  projectList.value = withProject(projectList.peek(), project);
  openProjectPage(project.id);
  return project;
}

/** A folder's own name (its last part), as the rows show it. */
export function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}
