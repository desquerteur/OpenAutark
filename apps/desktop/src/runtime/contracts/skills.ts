// Runtime service contract additions to SkillService (contracts/models.ts, by module augmentation): skill modes
// on save, a new skill into the owner's Main Skills (wave 3) and (MM8) skills that arrive with an agent file.
// Re-exported by ../contracts.ts (import from there). Implemented by skills/service.ts.
// Owns: interface shapes only. Keep methods few and meaningful; add, never silently change.

import type { ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import type { Agent } from '../../shared/model/org.ts';

export interface SkillSaveInput {
  name: string;
  description: string;
  body: string;
  ownerAgentId?: string;
  /** Modes whose skill index lists the skill ([] = every mode); absent keeps the current ones. */
  modes?: string[];
  /** Wave 3: a new skill goes into the owner's Main Skills (<data>/agents/<owner>/skills; needs ownerAgentId, a taken name is refused). A Main Skill saved again stays one either way. */
  main?: boolean;
}

/** MM8: one skill from an agent file (SKILL.md only), stored as `ownerAgentId`'s own; without an owner in the shared library. */
export interface SkillImportInput {
  name: string;
  description: string;
  body: string;
  modes: readonly string[];
  ownerAgentId?: string;
  /** Wave 3: into the owner's Main Skills (agent file v3 `main: true`). */
  main?: boolean;
}

declare module './models.ts' {
  interface SkillService {
    /** Addition (CTX4): `modes` replaces the skill's modes ([] = every mode); absent keeps them. */
    save(input: SkillSaveInput): SkillInfo;
    /**
     * Addition (MM8), optional so simple fakes stay valid: writes an agent file's skill as the owner's own and
     * returns it under its final, free name (a taken name gets -2, -3 …).
     */
    importSkill?(input: SkillImportInput): SkillInfo;
    /** B-066, optional so simple fakes stay valid: the few `metadata.always` skills this agent's route reaches in this mode. */
    alwaysFor?(agent: Agent, mode: ModeInfo): SkillInfo[];
    /** B-066, optional so simple fakes stay valid: every copy of every skill, also those another copy of the name hides. */
    every?(): SkillInfo[];
    /** AF-007, optional so simple fakes stay valid: the folder a new skill of this name gets (an agent's own skills, else the shared library). */
    folderFor?(name: string, ownerAgentId?: string): string;
  }
}
