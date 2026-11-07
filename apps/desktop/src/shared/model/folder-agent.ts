// AF-014: an agent made from a folder – what the app found in the folder (its suggested name and role, the instruction
// files and skills it will follow and see) and what the person confirms. The folder becomes the agent's home project
// and the agent starts in the access mode 'project' (shared/model/access.ts FOLDER_AGENT_MODE).
// Owns: these shapes. Never: reading folders (runtime/folder-agents) or creating agents.

import type { AccessMode } from './access.ts';

export interface FolderFinding {
  /** The absolute folder as the app resolved it. */
  folder: string;
  /** The folder's own name (a group heading in the sidebar). */
  label: string;
  /** Suggested agent name (from package.json, pyproject.toml, Cargo.toml, the README's heading or the folder name). */
  name: string;
  /** Suggested role, one line of at most 80 characters. */
  role: string;
  /** Where the suggestion came from ("package.json", "README.md", "folder name"). */
  source: string;
  /** What the project is about, from its README or manifest (at most 600 characters; '' when nothing says). */
  about: string;
  /** Instruction files the agent will follow (CLAUDE.md, AGENTS.md, .cursor/rules/… – relative, '/' separators). */
  instructions: string[];
  /** Skills found in the folder (.claude/skills, .codex/skills, .agents …) by name. */
  skills: string[];
  /** Other agent config the folder brings (.codex/config.toml, .claude/settings.json …) – named, never applied. */
  configs: string[];
  /** Agents that already have this folder as their home project (several per folder are fine). */
  agents: Array<{ id: string; name: string }>;
}

export interface FolderAgentInput {
  folder: string;
  name: string;
  role: string;
  /** Default: 'project' – changes only in this folder by itself. */
  mode?: AccessMode;
}
