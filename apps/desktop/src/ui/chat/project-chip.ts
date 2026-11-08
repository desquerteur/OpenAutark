// AF-018: which project a chat belongs to and what its header chip says ("Autark · main · 3 changed"). A chat is in
// a project when the project lists it as one of its sessions, else when one of the chat's agents (current members)
// works in the project's folder; with several, the one whose agent is answering right now wins, then the list's
// order (pinned first, then by activity). Pure – ProjectChip.tsx renders it.
// Owns: the matching and the chip's text. Never: loads projects or navigates.

import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Project } from '../../shared/model/project.ts';

type ChatLike = Pick<ConversationSummary, 'id' | 'members' | 'working'>;

/** The chat's agents that are still in it. */
function chatAgents(chat: ChatLike): Set<string> {
  return new Set(chat.members.filter((member) => member.kind === 'agent' && member.leftAt === undefined).map((member) => member.memberId));
}

/** The project the chat works in, or undefined. */
export function chatProject(chat: ChatLike, projects: readonly Project[]): Project | undefined {
  const listed = projects.find((project) => project.sessions.some((session) => session.conversationId === chat.id));
  if (listed) return listed;
  const agents = chatAgents(chat);
  if (!agents.size) return undefined;
  const candidates = projects.filter((project) => project.agents.some((agent) => agents.has(agent.id)));
  const working = new Set(chat.working);
  return candidates.find((project) => project.agents.some((agent) => working.has(agent.id))) ?? candidates[0];
}

export interface ChipText {
  /** Shown: the name, then the branch and the changed files when there are any. */
  parts: string[];
  /** The tooltip: the folder and the full state. */
  title: string;
}

/** "N changed" for a working tree with changes; '' for a clean one. */
export function changedText(dirty: number): string {
  return dirty > 0 ? `${dirty} changed` : '';
}

export function chipText(project: Project): ChipText {
  const git = project.git;
  const branch = git ? (git.branch ?? git.head) : ''; // detached: the short sha
  const changed = git ? changedText(git.dirty) : '';
  const parts = [project.name, branch, changed].filter(Boolean);
  const where = git && branch ? (git.branch ? `On ${branch}` : `Detached at ${branch}`) : '';
  const state = project.missing ? 'The folder no longer exists' : git ? [where, changed || 'No changes'].filter(Boolean).join(' · ') : 'Not a git repository';
  return { parts, title: `${project.folder}\n${state}\nOpen the project` };
}
