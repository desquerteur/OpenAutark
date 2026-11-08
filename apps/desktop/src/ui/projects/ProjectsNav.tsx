// AF-018: the Projects tab's sidebar – every project (pinned first, then by activity) with its git line and, under the
// open one, its sessions; "+" adds a folder (the folder dialog), and a folder dropped anywhere on the list adds it too.
// The header data (projectsNavHeader) is drawn by the frame (shell/views.ts). On the phone it is the tab's root list.
// Owns: the sidebar's rows, the add button and the drop target. Never: git or folder reads, header markup.

import { useEffect, useState } from 'preact/hooks';
import type { Project } from '../../shared/model/project.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import type { HeaderProps } from '../lib/header.tsx';
import { route, go } from '../lib/router.ts';
import { bridge } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { Icon, Spinner } from '../lib/ui.tsx';
import { droppedFolder, mayHoldFolder } from '../team/folder-agent.ts';
import { projectLine, workingCount } from './projects-model.ts';
import { addProject, loadProjects, pinProject, projectList, projectsLoaded, removeProjectFromList } from './projects-store.ts';

/** True when this window can open the folder dialog (the desktop app, not a browser or phone). */
export const canPickFolder = (): boolean => !!bridge?.files.pickFolder;

/** Opens the folder dialog and adds the chosen folder as a project, then opens its page. */
export async function pickAndAddProject(): Promise<void> {
  try {
    const folder = await bridge?.files.pickFolder?.('project');
    if (!folder) return;
    const project = await addProject(folder);
    go.project(project.id);
  } catch (error) { toastError(error, 'Could not add the project'); }
}

/** Adds a dropped folder as a project and opens it. */
export async function addDroppedProject(data: DataTransfer | null): Promise<void> {
  const folder = droppedFolder(data);
  if (!folder) { toastError(new Error('Drop a folder, not a file.'), 'Could not add the project'); return; }
  try { go.project((await addProject(folder)).id); } catch (error) { toastError(error, 'Could not add the project'); }
}

export function projectsNavHeader(): HeaderProps {
  return {
    title: DESTINATIONS.projects,
    cells: canPickFolder() ? [{ id: 'add', icon: 'plus', label: 'Add project', onClick: () => void pickAndAddProject() }] : [],
  };
}

function ProjectRow(props: { project: Project; open: boolean }) {
  const { project } = props;
  const working = workingCount(project);
  const menu = useContextMenu(() => [{
    items: [
      { label: project.pinned ? 'Unpin' : 'Pin to top', onSelect: () => void pinProject(project.id, !project.pinned).catch((error) => toastError(error)) },
      { label: 'Remove from list', onSelect: () => void removeProjectFromList(project.id).catch((error) => toastError(error)) },
    ],
  }]);
  return (
    <div class="project-group">
      <div class={`project-row${props.open ? ' active' : ''}${project.missing ? ' missing' : ''}`} {...menu}>
        <button type="button" class="project-row-open" aria-current={props.open ? 'page' : undefined} title={project.folder} onClick={() => go.project(project.id)}>
          <span class="project-row-line">
            <Icon name="folder" size={16} class="project-row-icon" />
            <span class="row-title">{project.name}</span>
            {project.pinned && <Icon name="push-pin" size={12} class="project-row-pin" title="Pinned" />}
            {working > 0 && <span class="project-working" title={`${working} working`}><Spinner size={12} /></span>}
            {!!project.git?.dirty && <span class="project-dirty tabular" title={`${project.git.dirty} changed files`}>{project.git.dirty}</span>}
          </span>
          <span class="row-preview">{projectLine(project)}</span>
        </button>
      </div>
      {props.open && project.sessions.length > 0 && (
        <div class="project-sessions" role="group" aria-label={`Sessions of ${project.name}`}>
          {project.sessions.slice(0, 8).map((session) => (
            <button key={session.conversationId} type="button" class="project-session" onClick={() => go.chat(session.conversationId)}>
              {session.working ? <Spinner size={10} /> : <span class="project-session-dot" aria-hidden="true" />}
              <span class="row-title">{session.title || 'Untitled session'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectsNav() {
  useEffect(() => { void loadProjects(); }, []);
  const [over, setOver] = useState(false);
  const current = route.value;
  const openId = current.view === 'projects' ? current.id : undefined;
  const list = projectList.value;
  const menu = useContextMenu(() => canPickFolder() ? [{ items: [{ label: 'Add project…', onSelect: () => void pickAndAddProject() }] }] : []);
  return (
    <div class={`sidebar-section projects-nav${over ? ' drag-over' : ''}`} data-tour="project-list" {...menu}
      onDragOver={(event) => { if (mayHoldFolder(event.dataTransfer)) { event.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { event.preventDefault(); setOver(false); void addDroppedProject(event.dataTransfer); }}>
      {list.map((project) => <ProjectRow key={project.id} project={project} open={project.id === openId} />)}
      {projectsLoaded.value && !list.length && (
        <p class="empty-state projects-nav-empty">No projects yet. Add a folder you code in{canPickFolder() ? ' with +' : ''} or drop it here.</p>
      )}
    </div>
  );
}
