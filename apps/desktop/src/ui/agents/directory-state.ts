// AF-017: the agent directory's live state – its entries built from the store's agents, the shared project list
// (lib/projects.ts), the spaces and the live runs; which agents the person opened already (their "new" mark goes,
// remembered per device), and the actions every place shares: open an agent's
// chat, its page, its project.
// Owns: these signals and actions. Never: renders, or keeps a second copy of agents or projects.

import { computed, signal } from '@preact/signals';
import { agents, knownAgentMap } from '../lib/store.ts';
import { openProjectPage, projectList, watchProjects } from '../lib/projects.ts';
import { go } from '../lib/router.ts';
import { messageMember } from '../chat/direct.ts';
import { ensureSpaces, liveByAgent, spaces } from '../team/org-state.ts';
import { buildDirectory } from './directory-model.ts';
import { rpc } from '../lib/rpc.ts';
import { isOwner } from '../lib/session.ts';
import '../../shared/api/methods-projects.ts';
import '../../shared/api/methods-folder-agents.ts';

const SEEN_KEY = 'wf.agentsSeen';
const SEEN_MAX = 200;

function readSeen(): string[] {
  try { const list = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'); return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []; } catch { return []; }
}

/** Agents whose "new" mark is gone (opened here). */
export const seenAgents = signal<ReadonlySet<string>>(new Set(typeof localStorage === 'undefined' ? [] : readSeen()));

/** The person opened this agent (its page or chat): it is no longer "new". */
export function markAgentSeen(agentId: string): void {
  if (seenAgents.peek().has(agentId)) return;
  const next = [...seenAgents.peek(), agentId].slice(-SEEN_MAX);
  seenAgents.value = new Set(next);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

/** The clock "new" is measured against; moved on every read of the directory so marks expire without a timer. */
const now = signal(Date.now());
export function tickDirectory(): void { now.value = Date.now(); }

let wired = false;
let reload: ReturnType<typeof setTimeout> | undefined;

/** An agent's home folder decides its project, and the runtime announces no project for it: read the list again. */
function projectsAgain(): void {
  if (!isOwner()) return;
  clearTimeout(reload);
  reload = setTimeout(() => {
    rpc.call('projects.list').then((list) => { projectList.value = list; }).catch(() => undefined);
  }, 400);
}

/** Loads what the directory needs beyond the store and keeps the agents' projects fresh (idempotent). */
export function watchDirectory(): void {
  ensureSpaces();
  watchProjects();
  if (wired) return;
  wired = true;
  rpc.on('agentCore.changed', projectsAgain); // a home folder set or changed (AF-014)
  rpc.on('agent.upserted', projectsAgain); // a hire, a rename, an archive
}

export const directoryEntries = computed(() => buildDirectory({
  agents: agents.value,
  projects: projectList.value,
  spaces: spaces.value,
  live: liveByAgent.value,
  nameOf: (id) => knownAgentMap.value.get(id)?.name,
  seen: seenAgents.value,
  now: now.value,
}));


export function openAgentChat(agentId: string): void {
  markAgentSeen(agentId);
  messageMember(agentId);
}

export function openAgentPage(agentId: string): void {
  markAgentSeen(agentId);
  go.agent(agentId);
}

export function showInProject(projectId: string): void {
  openProjectPage(projectId);
}
