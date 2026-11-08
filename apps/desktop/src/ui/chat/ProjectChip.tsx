// AF-018: the chat header's project chip – beside the chat's name when an agent of the chat works in a project:
// "<project> · <branch> · N changed" (project-chip.ts), a click opens the project's page. Owner only (the list stays
// empty elsewhere) and not on the phone, whose title track has no room. Nothing is reserved for it: it sits after the
// name inside the fixed title track and only shortens the name's ellipsis.
// Owns: the chip's markup. Never: matches chats to projects itself or reads git.

import { useEffect } from 'preact/hooks';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { Icon } from '../lib/ui.tsx';
import { isMobile } from '../lib/store.ts';
import { openProjectPage, projectList, watchProjects } from '../lib/projects.ts';
import { chatProject, chipText } from './project-chip.ts';

export function ProjectChip(props: { chat: ConversationSummary }) {
  useEffect(() => { watchProjects(); }, []);
  const project = isMobile.value ? undefined : chatProject(props.chat, projectList.value);
  if (!project) return null;
  const text = chipText(project);
  return (
    <button type="button" class={`chat-project-chip${project.missing ? ' missing' : ''}`} title={text.title}
      aria-label={`Open project ${project.name}`} onClick={() => openProjectPage(project.id)}>
      <Icon name="folder" size={12} />
      <span class="chat-project-chip-text">{text.parts.join(' · ')}</span>
    </button>
  );
}
