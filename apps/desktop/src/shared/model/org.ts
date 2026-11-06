// Organization model: spaces (life areas), agents and their place in the company.
// Owns: the plain-data shapes shared by runtime, UI, PWA and peers.
// Never: contains behaviour; validation lives in the runtime services.

import type { Effort, ModelPolicy } from './providers.ts';

/** A life area the person manages: their company, personal brand, private life … */
export interface Space {
  id: string;
  name: string;
  kind: 'company' | 'brand' | 'private' | 'custom';
  color?: string; // token name or #rrggbb
  sort: number;
  createdAt: number;
  archivedAt?: number;
}

export interface Avatar {
  kind: 'initials' | 'emoji' | 'image';
  value: string; // initials/emoji text, or a file id for an image
  color?: number; // palette index 0..5 (UI maps to the Codex-like avatar palette)
}

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'paused' | 'error';

/** A long-lived AI colleague. Identity survives model/engine changes. */
export interface Agent {
  id: string;
  name: string;
  role: string; // job title, e.g. "Video editor"
  avatar: Avatar;
  spaceId?: string;
  managerId?: string; // reports to; undefined = reports to the human
  team?: string; // free text team name, e.g. "Marketing"
  instructions: string; // short persona/prompt addition written by user or manager
  mode: string; // default mode key (resources/modes)
  skills: string[]; // extra skill names beyond the mode's skills
  modelPolicy: ModelPolicy;
  deviceId?: string; // device whose engines/tools this agent uses by default (undefined = home)
  status: AgentStatus;
  statusNote?: string; // one short live line, e.g. "rendering intro (2/5)"
  template?: string; // template key it was hired from
  /** Speaking voice of the speech model (e.g. "nova"), the default of media.speak (MM3); undefined = the model's default. */
  voice?: string;
  createdBy: string; // 'human' or an agent id
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** Template used by managers to hire agents (resources/agents/<key>.md front matter). */
export interface AgentTemplate {
  key: string;
  name: string; // default display name
  role: string;
  description: string;
  mode: string;
  skills: string[];
  spaceKind?: Space['kind'];
  instructions: string;
  effort?: Effort;
  /** 'human': hired agents report to the person, never into the hiring manager's branch (the secretary). */
  reportsTo?: 'human';
}

/** Org tree node returned to the UI (agents nested under their manager). */
export interface OrgNode {
  agent: Agent;
  reports: OrgNode[];
}
