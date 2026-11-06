// Agent core folder (wave 3): every agent has one folder <data>/agents/<agentId>/ in the app's data
// folder (outside the agent-writable workspace) with
//   agent.json      a readable label (id, name, role) written by the app, plus (B-044) `home`: the agent's
//                   home project – the ONE place it is stored, so a disk edit counts as the person's edit
//   SYSTEM.md       the agent's instructions: the ONE text the runtime prompt and the agent editor use
//   skills/<name>/SKILL.md  its Main Skills (agentskills.io front matter name + description, like every skill)
// Shapes for agents.core / agents.saveMainSkill / agents.setHome and the 'agentCore.changed' event, and the limits.
// Owns: these shapes and constants. Never: behaviour (runtime/agent-core).

import type { SkillInfo } from './knowledge.ts';

export const AGENT_CORE_DIR = 'agents';
export const SYSTEM_FILE = 'SYSTEM.md';
export const CORE_MANIFEST = 'agent.json';
export const MAIN_SKILLS_DIR = 'skills';
/** Same cap as an agent's instructions (org/patch.ts). */
export const SYSTEM_MAX_CHARS = 20_000;
/** Larger files are not read at all (20 000 characters are at most 80 KB in UTF-8). */
export const SYSTEM_MAX_BYTES = 128 * 1024;
/** Main Skills listed in the agent's prompt (name + description); beyond, skills.list names them. */
export const MAIN_SKILLS_IN_PROMPT = 40;
/** A SKILL.md in the Main Skills folder larger than this is named as a problem (agents.saveMainSkill stays below it). */
export const MAIN_SKILL_MAX_BYTES = 1024 * 1024;

/**
 * Why SYSTEM.md is not used as it is: missing (written again from the last good instructions),
 * too large, not UTF-8 text, unreadable (a link instead of a file too), the app could not write it,
 * or the agent's id cannot name a folder (an old imported id: its instructions stay in the app only).
 */
export type AgentCoreProblem = 'missing' | 'too-large' | 'not-text' | 'unreadable' | 'unwritable' | 'no-folder';

export interface AgentCoreNotice {
  problem: AgentCoreProblem;
  /** One short sentence for the person (no paths, no file content). */
  text: string;
  at: number;
}

/**
 * Why a SKILL.md in the Main Skills folder is not (fully) usable (runtime/skills/discover.ts, agent-core/info.ts):
 * the file itself, `misplaced` (not directly in skills/<name>/) or `name-taken` (another skill with its name
 * wins for this agent, so this one is not used).
 */
export type MainSkillProblem = 'too-large' | 'not-text' | 'no-name' | 'no-description' | 'duplicate' | 'unreadable' | 'misplaced' | 'name-taken';

/** Longest home project path accepted (agents.update home, agents.setHome). */
export const HOME_MAX_CHARS = 1024;

/**
 * B-044: the agent's home project – the folder its turns start in when the task has no worktree of its own
 * (like a coding agent opened in a source folder); it still works anywhere. Set by the agent (agents.update
 * home – a folder outside the workspace needs approval once) or the person (agents.setHome, agent.json).
 * `missing`: the folder is not there (another PC, deleted); `refused`: no folder a turn may write in (inside
 * the data folder, containing the home folder, a CLI's settings folder, a network folder …) – turns then start
 * in the workspace.
 */
export type AgentHomeProblem = 'missing' | 'refused';

export interface AgentHome {
  /** Absolute folder on this PC – '' outside the owner scope. */
  path: string;
  /** Inside the workspace (setting it needed no approval). */
  inWorkspace: boolean;
  problem?: AgentHomeProblem;
  /** One short sentence when there is a problem: why, and that turns start in the workspace. */
  text?: string;
}

export interface AgentCoreInfo {
  agentId: string;
  /** Absolute folder on this PC – only for the person on the PC (owner scope), for "Open folder". */
  folder?: string;
  /** B-044: the home project; absent = not set. */
  home?: AgentHome;
  /** False while SYSTEM.md cannot be used: the last good instructions stay in use (see notice). */
  inUse: boolean;
  notice?: AgentCoreNotice;
  /** The agent's Main Skills, alphabetical (also ones waiting for review: `disabled`); `path` is '' outside the owner scope. */
  mainSkills: SkillInfo[];
  /** SKILL.md files in its skills folder that need a fix (folder relative to skills/); absent = none. */
  skillProblems?: Array<{ folder: string; problem: MainSkillProblem }>;
}

declare module '../api/events.ts' {
  interface EventMap {
    /** Wave 3: an agent's core folder changed state (a notice came or went, Main Skills changed on disk, B-044: its home project). Topic: system, owner. */
    'agentCore.changed': { agentId: string };
  }
}
