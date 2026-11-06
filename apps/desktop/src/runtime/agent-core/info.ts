// What agents.core says about one agent folder (wave 3, service.ts info): the notice texts for SYSTEM.md
// and the SKILL.md files in skills/ that need a fix – checked with the shared discovery helper
// (skills/discover.ts) at the skill library's own rules (skills/service.ts): one folder per skill directly
// in skills/, a usable name and a description, at most MAIN_SKILL_MAX_BYTES, and a name no other skill of its own
// folder wins ('name-taken': this one is not used). An own copy of a shared name hides nothing from others (B-066 routes).
// Owns: these checks and texts. Never: writes, reads outside the agent's skills folder, or decides what wins.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MAIN_SKILL_MAX_BYTES, SYSTEM_MAX_CHARS, type AgentCoreProblem, type MainSkillProblem } from '../../shared/model/agent-core.ts';
import type { SkillInfo } from '../../shared/model/knowledge.ts';
import { discoverSkills } from '../skills/discover.ts';

export const NOTICES: Record<AgentCoreProblem, string> = {
  missing: 'SYSTEM.md was missing. It was written again from the last saved instructions.',
  'too-large': `SYSTEM.md is longer than ${SYSTEM_MAX_CHARS.toLocaleString('en-US')} characters. The last good instructions stay in use.`,
  'not-text': 'SYSTEM.md is not UTF-8 text. The last good instructions stay in use.',
  unreadable: 'SYSTEM.md could not be read (or is a link instead of a file). The last good instructions stay in use.',
  unwritable: 'SYSTEM.md could not be written. The instructions saved in the app stay in use.',
  'no-folder': 'This agent\'s id cannot be used as a folder name, so it has no SYSTEM.md. Its instructions are kept in the app.',
};

/** The library as this check reads it (SkillLibrary). */
export interface LibraryView {
  list(viewerId?: string): SkillInfo[];
}

export type SkillProblem = { folder: string; problem: MainSkillProblem };

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

const joined = (folder: string, route: string): string => (route ? `${folder}/${route}` : folder);

/** The SKILL.md files in `skillsDir` (the agent's Main Skills folder) that need a fix, in folder order. */
export function mainSkillProblems(skillsDir: string, agentId: string, library: LibraryView | undefined): SkillProblem[] {
  const problems: SkillProblem[] = [];
  if (existsSync(path.join(skillsDir, 'SKILL.md'))) problems.push({ folder: '', problem: 'misplaced' });
  const own = new Map((library?.list(agentId) ?? []).filter((info) => info.main === true && info.ownerAgentId === agentId).map((info) => [path.resolve(info.path), info]));
  for (const child of subfolders(skillsDir)) {
    const found = discoverSkills(path.join(skillsDir, child), { authority: 'agent', maxDepth: 2, maxSkills: 20, maxBytes: MAIN_SKILL_MAX_BYTES });
    for (const entry of found.problems) problems.push({ folder: joined(child, entry.route), problem: entry.problem });
    for (const skill of found.skills) {
      const folder = joined(child, skill.route);
      if (skill.route) { problems.push({ folder, problem: 'misplaced' }); continue; } // the library reads skills/<name>/SKILL.md only
      const info = own.get(path.resolve(skill.folder));
      if (!info) problems.push({ folder, problem: 'name-taken' });
      else if (info.name !== skill.name) problems.push({ folder, problem: 'no-name' }); // not lowercase-with-hyphens
    }
  }
  return problems;
}
