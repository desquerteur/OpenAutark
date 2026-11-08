// AF-018: a project – one folder on this PC (usually a git repo) the person codes in, like a project in Codex or
// Claude Code. The Projects tab lists them; each shows its git state, the agents working in it (their home project
// is this folder, AF-014) and its sessions (the chats of those agents). A project is either added by the person or
// follows from an agent's home folder. Owns: these shapes. Never: reading folders or git (runtime/projects).

export interface ProjectGit {
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
  /** Short sha of HEAD ('' in a repo without commits). */
  head: string;
  /** Changed, added or untracked paths in the working tree (git status --porcelain lines). */
  dirty: number;
  /** Commits ahead of / behind the upstream (0 without one). */
  ahead: number;
  behind: number;
  /** The upstream, e.g. "origin/main" (absent without one). */
  upstream?: string;
  /** The newest commit on HEAD. */
  lastCommit?: { sha: string; subject: string; at: number };
  /** Local branches (at most 50, the checked-out one included). */
  branches: string[];
}

export interface ProjectSession {
  conversationId: string;
  title: string;
  /** The chat's agents that work in this project. */
  agentIds: string[];
  /** Last activity (ms). */
  lastAt: number;
  /** An agent is answering in it right now. */
  working: boolean;
}

export interface Project {
  /** Stable id derived from the folder (same folder = same id). */
  id: string;
  /** Absolute folder. */
  folder: string;
  /** Display name: the person's own, else the folder's name. */
  name: string;
  /** 'added': the person added it; 'agent': it follows from an agent's home folder only. */
  source: 'added' | 'agent';
  pinned: boolean;
  addedAt: number;
  /** Newest session activity or git commit (ms; 0 when unknown) – the list's order after pinned ones. */
  lastActiveAt: number;
  /** The folder no longer exists. */
  missing?: boolean;
  /** Absent when the folder is no git repository (or git is unavailable). */
  git?: ProjectGit;
  /** Agents whose home project is this folder. */
  agents: Array<{ id: string; name: string }>;
  /** Its sessions, newest first (at most 30). */
  sessions: ProjectSession[];
  /** One line about the project from its README or manifest ('' when nothing says). */
  about: string;
}

export interface StartSessionInput {
  projectId: string;
  /** The first message of the session – the work to do. */
  prompt: string;
  /** The project agent to run it; default: the project's first agent, or a new one hired from the folder. */
  agentId?: string;
  /** The chat's title (default: from the prompt). */
  title?: string;
}
