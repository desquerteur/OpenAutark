// F-51 start paths: the shapes of a team proposal (from a pattern or an imported agent system) and the local
// pattern library – shared by runtime (runtime/importers, runtime/patterns, org/team-proposal.ts) and UI. B-059: no start flag – the first run
// picks no team (B-047 D7).
// Owns: plain-data shapes, limits and labels. Never: parsing, validation or creation (runtime).

import type { Agent } from './org.ts';

/** Agent systems the importer reads (runtime/importers/detect.ts). */
export type ImportFormat = 'claude-agents' | 'codex-agents-md' | 'crewai' | 'workforce-agent' | 'json-roles' | 'markdown-roles';

export const FORMAT_LABELS: Readonly<Record<ImportFormat, string>> = {
  'claude-agents': 'Claude Code subagent',
  'codex-agents-md': 'Codex AGENTS.md',
  crewai: 'CrewAI crew',
  'workforce-agent': 'Autark agent file',
  'json-roles': 'JSON role list',
  'markdown-roles': 'Markdown role list',
};

/** A task definition an imported system kept with an agent (CrewAI tasks.yaml): stored as a procedure note. */
export interface ProposedTask { title: string; body: string }

/** One agent of a proposal – edited by the person before anything is created. */
export interface ProposedAgent {
  /** Stable within its proposal ("a1", "f0-a2"); `reportsTo` names another key. */
  key: string;
  name: string;
  role: string;
  instructions: string;
  /** A mode key of this app ('general' when nothing fits). */
  mode: string;
  /** An agent template of this app, when one is meant (its instructions are already in `instructions`). */
  template?: string;
  /** Skill names of this app only. */
  skills: string[];
  /** Key of the proposed agent this one reports to; absent = the root (the chosen manager, or the person). */
  reportsTo?: string;
  /** Key of the proposed agent whose work this one accompanies as companion (counter-role, runtime/companions). */
  companionOf?: string;
  /** Imported task definitions, stored as the agent's own procedure notes. */
  tasks?: ProposedTask[];
  /** false = shown but not created (the person may tick it). */
  include: boolean;
}

export type PatternSource = 'builtin' | 'saved' | 'imported';

/** Where an imported or saved pattern came from (shown with it; a URL can be checked again on request). */
export interface PatternProvenance {
  kind: 'url' | 'file' | 'org';
  /** The https URL or the file name (never a local path). */
  ref?: string;
  sha256: string;
  at: number;
  /** The previous content's hash after an update. */
  previousSha256?: string;
}

export interface PatternSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  source: PatternSource;
  provenance?: PatternProvenance;
  tags: string[];
  agentCount: number;
  /** Optional patterns are offered, never applied without the person's choice (e.g. a CEO assistant). */
  optional: boolean;
  updatedAt: number;
}

/** What a pattern kept and what it left out – never values of secrets. */
export interface CompatibilityReport {
  mapped: string[];
  dropped: string[];
}

/** A pattern with its editable proposal and the notes for the manager. */
export interface TeamPattern extends PatternSummary {
  guide: string;
  agents: ProposedAgent[];
  report: CompatibilityReport;
}

export interface CreatedTeam { agents: Agent[] }

export const MAX_PROPOSAL_AGENTS = 30;
export const PATTERN_MAX_CHARS = 200_000;
