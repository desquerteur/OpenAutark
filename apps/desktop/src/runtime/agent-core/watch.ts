// Live pick-up of edits in <data>/agents (wave 3; B-044: moved onto the data folder watcher). The agent core
// is the owner of the 'agents' entry of the RootWatcher (runtime/root/watcher.ts: one fs.watch on
// <data>, debounced per path, the app's own writes and temporary files dropped, armed again after an error).
// This file only turns what the watcher hands over into the agent and the part of its folder that changed:
// SYSTEM.md, its Main Skills, agent.json (B-044: its `home` – agent-core/home.ts), or the folder itself; an
// unknown change (no file name, armed again, agents/ itself created or removed) hands over every agent ('*').
// Owns: the path split and the registration. Never: reads files (service.ts reconciles), timers or a watch of its own.

import { CORE_MANIFEST, MAIN_SKILLS_DIR, SYSTEM_FILE } from '../../shared/model/agent-core.ts';
import { ROOT_AGENTS } from '../root/layout.ts';
import type { RootWatcher } from '../root/watcher.ts';
import { isCoreFolderName } from './layout.ts';

/** What changed in one agent folder. `all`: the folder itself (created, removed, renamed); `manifest`: agent.json. */
export interface CoreChange { system: boolean; skills: boolean; all: boolean; manifest?: true }

const ALL: CoreChange = { system: true, skills: true, all: true };

/** The agent and the part of its folder an event names (path relative to agents/, either separator). */
export function classify(rel: string): { agentId: string; change: CoreChange } | undefined {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const [agentId, second] = parts;
  if (!agentId || !isCoreFolderName(agentId)) return undefined;
  if (parts[parts.length - 1]?.endsWith('.tmp')) return undefined; // an atomic write in progress
  if (parts.length === 1) return { agentId, change: ALL };
  if (second === SYSTEM_FILE) return { agentId, change: { system: true, skills: false, all: false } };
  if (second === MAIN_SKILLS_DIR) return { agentId, change: { system: false, skills: true, all: false } };
  if (second === CORE_MANIFEST && parts.length === 2) return { agentId, change: { system: false, skills: false, all: false, manifest: true } }; // its home (the label is the app's)
  return undefined; // SYSTEM.rejected.md or other files
}

/** Registers the agent core as the owner of <data>/agents; returns the unregister function. */
export function watchCoreFolders(root: Pick<RootWatcher, 'register'>, onChange: (agentId: string, change: CoreChange) => void): () => void {
  return root.register(ROOT_AGENTS, (event) => {
    if (!event.parts?.length) { onChange('*', ALL); return; }
    const hit = classify(event.parts.join('/'));
    if (hit) onChange(hit.agentId, hit.change);
  });
}

/** Queues a finding of the service (a turn-time stat) for one agent's SYSTEM.md into the watcher's debounce. */
export function nudgeCore(root: Pick<RootWatcher, 'nudge'>, agentId: string): void {
  root.nudge(ROOT_AGENTS, [agentId, SYSTEM_FILE]);
}
