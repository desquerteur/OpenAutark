// AF-018: the Projects tab's main zone. Without a project: a short start page (what a project is, Add project, the
// recent projects as cards). With one: its page – name (rename), folder, branch / changes / sync, the newest commit,
// who works in it, its sessions, and the big "What should happen in <project>?" field that starts a new session
// (projects.startSession: a new chat with a project agent, hired from the folder when there is none) and opens it.
// Owns: these two pages. Never: git or folder reads, the session logic (runtime/projects).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { Project } from '../../shared/model/project.ts';
import { Header } from '../lib/header.tsx';
import { backCell } from '../lib/header.tsx';
import { go } from '../lib/router.ts';
import { isMobile } from '../lib/platform.ts';
import { relative } from '../lib/format.ts';
import { toastError } from '../lib/toasts.ts';
import { Button, EmptyState, Icon, Spinner, askText, confirm } from '../lib/ui.tsx';
import { agentsLine, branchLabel, changedLabel, composerPlaceholder, projectLine, syncLabel } from './projects-model.ts';
import { loadProjects, pinProject, projectList, projectMap, projectsLoaded, refreshProject, removeProjectFromList, renameProject, startSession } from './projects-store.ts';
import { addDroppedProject, canPickFolder, pickAndAddProject } from './ProjectsNav.tsx';
import { mayHoldFolder } from '../team/folder-agent.ts';

/** The start page: no project open. */
export function ProjectsHome() {
  useEffect(() => { void loadProjects(); }, []);
  const [over, setOver] = useState(false);
  const list = projectList.value;
  return (
    <div class={`projects-view${over ? ' drag-over' : ''}`}
      onDragOver={(event) => { if (mayHoldFolder(event.dataTransfer)) { event.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => { event.preventDefault(); setOver(false); void addDroppedProject(event.dataTransfer); }}>
      {!isMobile.value && <Header zone="main" title="Projects" />}
      <div class="projects-scroll">
        <div class="projects-intro">
          <h1 class="projects-title">Your projects</h1>
          <p class="projects-lead">A project is a folder you code in. Open one, say what should happen, and an agent works on it in its own session.</p>
          {canPickFolder()
            ? <Button variant="primary" icon="plus" onClick={() => void pickAndAddProject()}>Add project</Button>
            : <p class="projects-hint">Add projects in the Autark app on your PC.</p>}
          {canPickFolder() && <p class="projects-hint">Or drop a folder here.</p>}
        </div>
        {!projectsLoaded.value && !list.length && <div class="projects-loading"><Spinner /></div>}
        {list.length > 0 && (
          <div class="projects-cards">
            {list.map((project) => (
              <button key={project.id} type="button" class="project-card" onClick={() => go.project(project.id)} title={project.folder}>
                <span class="project-card-name"><Icon name="folder" size={16} />{project.name}</span>
                <span class="project-card-line">{projectLine(project)}</span>
                {project.about && <span class="project-card-about">{project.about}</span>}
                <span class="project-card-foot">{project.sessions.length ? `${project.sessions.length} session${project.sessions.length === 1 ? '' : 's'}` : 'No sessions yet'}{project.lastActiveAt ? ` · ${relative(project.lastActiveAt)}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionComposer(props: { project: Project }) {
  const { project } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); }, [project.id]);
  const send = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    try {
      const result = await startSession({ projectId: project.id, prompt });
      setText('');
      go.chat(result.conversation.id);
    } catch (error) {
      toastError(error, 'Could not start the session');
    } finally { setBusy(false); }
  };
  const disabled = !!project.missing;
  return (
    <div class="project-composer" data-tour="project-composer">
      <textarea ref={field} class="project-composer-field" rows={4} value={text} disabled={disabled || busy}
        placeholder={disabled ? 'The folder is missing.' : composerPlaceholder(project.name)}
        aria-label={composerPlaceholder(project.name)}
        onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || !event.shiftKey) && !event.isComposing) { event.preventDefault(); void send(); } }} />
      <div class="project-composer-foot">
        <span class="project-composer-who">{project.agents.length ? `Runs with ${project.agents[0]!.name}` : 'A new agent is hired from this folder'}</span>
        <Button variant="primary" icon="arrow-up" busy={busy} disabled={!text.trim() || disabled} onClick={() => void send()}>Start session</Button>
      </div>
    </div>
  );
}

/** One project's page. */
export function ProjectPage(props: { projectId: string }) {
  useEffect(() => { void loadProjects(); void refreshProject(props.projectId); }, [props.projectId]);
  const project = projectMap.value.get(props.projectId);
  const back = isMobile.value ? backCell(() => go.project()) : undefined;
  if (!project) {
    return (
      <div class="projects-view">
        <Header zone="main" title="Project" lead={back} />
        <div class="projects-scroll">{projectsLoaded.value ? <EmptyState>This project is no longer on the list.</EmptyState> : <div class="projects-loading"><Spinner /></div>}</div>
      </div>
    );
  }
  const git = project.git;
  const rename = async () => {
    const name = await askText({ title: 'Rename project', label: 'Name (empty = the folder name)', value: project.name });
    if (name !== null) await renameProject(project.id, name).catch((error) => toastError(error));
  };
  const remove = async () => {
    if (!await confirm({ title: `Remove ${project.name} from the list?`, body: 'The folder, its agents and its chats stay as they are.', confirmLabel: 'Remove' })) return;
    try { await removeProjectFromList(project.id); go.project(); } catch (error) { toastError(error); }
  };
  return (
    <div class="projects-view">
      <Header zone="main" title={project.name} sub={project.folder} twoLine lead={back} cells={[
        { id: 'pin', icon: 'push-pin', label: project.pinned ? 'Unpin' : 'Pin to top', pressed: project.pinned, onClick: () => void pinProject(project.id, !project.pinned).catch((error) => toastError(error)) },
        { id: 'rename', icon: 'pencil-simple', label: 'Rename', onClick: () => void rename() },
        { id: 'refresh', icon: 'arrow-clockwise', label: 'Refresh', onClick: () => void refreshProject(project.id) },
        { id: 'remove', icon: 'trash', label: 'Remove from list', onClick: () => void remove() },
      ]} />
      <div class="projects-scroll">
        <div class="project-page">
          {project.about && <p class="project-about">{project.about}</p>}
          {project.missing && <p class="project-warn"><Icon name="warning-circle" size={14} /> The folder is gone: {project.folder}</p>}
          <SessionComposer project={project} />
          <div class="project-facts">
            <div class="project-fact"><span class="project-fact-label">Branch</span>
              <span class="project-fact-value">{git ? <><Icon name="git-branch" size={14} /> {branchLabel(git)}{git.upstream ? <span class="project-muted"> → {git.upstream}</span> : null}</> : <span class="project-muted">Not a git repository</span>}</span></div>
            {git && <div class="project-fact"><span class="project-fact-label">Changes</span>
              <span class="project-fact-value">{changedLabel(git.dirty) || 'Clean'}{syncLabel(git) ? <span class="project-sync tabular"> · {syncLabel(git)}</span> : null}</span></div>}
            {git?.lastCommit && <div class="project-fact"><span class="project-fact-label">Last commit</span>
              <span class="project-fact-value"><code class="project-sha">{git.lastCommit.sha}</code> {git.lastCommit.subject} <span class="project-muted">· {relative(git.lastCommit.at)}</span></span></div>}
            <div class="project-fact"><span class="project-fact-label">Agents</span>
              <span class="project-fact-value">{project.agents.length
                ? project.agents.map((agent, index) => <span key={agent.id}>{index > 0 && ', '}<button type="button" class="text-button" onClick={() => go.agent(agent.id)}>{agent.name}</button></span>)
                : <span class="project-muted">{agentsLine(project)}</span>}</span></div>
          </div>
          <h2 class="project-section">Sessions</h2>
          {project.sessions.length ? (
            <div class="project-session-list">
              {project.sessions.map((session) => (
                <button key={session.conversationId} type="button" class="project-session-card" onClick={() => go.chat(session.conversationId)}>
                  {session.working ? <Spinner size={12} /> : <Icon name="chat-circle" size={14} />}
                  <span class="row-title">{session.title || 'Untitled session'}</span>
                  <span class="project-muted tabular">{session.working ? 'working' : relative(session.lastAt)}</span>
                </button>
              ))}
            </div>
          ) : <p class="project-muted">No sessions yet – write above what should happen.</p>}
        </div>
      </div>
    </div>
  );
}
