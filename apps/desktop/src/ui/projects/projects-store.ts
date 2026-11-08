// AF-018: the Projects tab's actions on the one project list of the window (lib/projects.ts `projectList` – the chip,
// the palette and this tab share it, loaded on connect and kept fresh by project.upserted / project.removed). Here:
// add, rename, pin, remove, refresh one and start a session. The views read `projectList` and call these.
// Owns: these actions and the "first load answered" flag. Never: a second copy of the list, renders, reads folders.

import { computed, signal } from '@preact/signals';
import '../../shared/api/methods-projects.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Project, StartSessionInput } from '../../shared/model/project.ts';
import { projectList, watchProjects } from '../lib/projects.ts';
import { rpc } from '../lib/rpc.ts';
import { orderProjects, removeProject, upsertProject } from './projects-model.ts';

export { projectList } from '../lib/projects.ts';

/** The tab's first own load has answered (the empty state waits for it, so it never flashes). */
export const projectsLoaded = signal(false);
export const projectMap = computed(() => new Map(projectList.value.map((project) => [project.id, project])));

/** Wires the shared list (once) and loads it fresh for the tab. */
export async function loadProjects(): Promise<void> {
  watchProjects();
  try { projectList.value = orderProjects(await rpc.call('projects.list')); } catch { /* keep what is shown; the next connect loads again */ }
  projectsLoaded.value = true;
}

function put(project: Project): Project {
  projectList.value = upsertProject(projectList.peek(), project);
  return project;
}

/** Reads one project's git state fresh (opening its page). */
export async function refreshProject(id: string): Promise<Project | undefined> {
  try { return put(await rpc.call('projects.get', { id })); } catch { return undefined; }
}

export async function addProject(folder: string, name?: string): Promise<Project> {
  return put(await rpc.call('projects.add', { folder: folder.trim(), ...(name ? { name } : {}) }));
}

export async function renameProject(id: string, name: string): Promise<Project> {
  return put(await rpc.call('projects.update', { id, name: name.trim() }));
}

export async function pinProject(id: string, pinned: boolean): Promise<Project> {
  return put(await rpc.call('projects.update', { id, pinned }));
}

export async function removeProjectFromList(id: string): Promise<void> {
  await rpc.call('projects.remove', { id });
  projectList.value = removeProject(projectList.peek(), id);
}

export async function startSession(input: StartSessionInput): Promise<{ project: Project; conversation: ConversationSummary; agentCreated: boolean }> {
  const result = await rpc.call('projects.startSession', { ...input, prompt: input.prompt.trim() });
  put(result.project);
  return result;
}
