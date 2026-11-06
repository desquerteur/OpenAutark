// Learned from use (B-049 F4): a tool an agent ran through tools.call in a chat joins its directly offered tools in
// that chat – at the next fresh native session there (agents/turn-prepare.ts promotes after the session choice),
// never mid-session, so a resumed session keeps the offer and the prompt key it started with.
// State: kv ns 'tools.learned', key `<agentId>|<conversationId or ->`, value { core, used }: `core` is offered with
// the core set (at most MAX_LEARNED, the newest kept), `used` was run through tools.call since the last promotion
// (at most MAX_USED). Per agent and chat, not per engine: a promotion for one engine's fresh session renews another
// engine's session of that chat at its next turn (its key changed).
// Also the engine offer both the turn (agents/session-key.ts) and the MCP hub (mcp/hub.ts) use: the registry's
// offerFor with this list, or specsFor where a registry has no offerFor (simple fakes).
// Owns: that state, its bounds, the promotion and the engine offer. Never: changes `core` outside promoteLearned, or
// offers a tool the mode does not allow (the registry intersects with the mode's offer).

import type { RuntimeServices } from '../contracts.ts';
import type { Db } from '../db/database.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { ToolSpec } from './types.ts';
import { KvRepo } from '../store/kv.ts';

export const LEARNED_NS = 'tools.learned';
export const MAX_LEARNED = 8;
export const MAX_USED = 8;

interface Learned { core: string[]; used: string[] }

const keyOf = (agentId: string, conversationId: string | undefined): string => `${agentId}|${conversationId || '-'}`;
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 64) : []);

function read(db: Db, agentId: string, conversationId: string | undefined): Learned {
  const value = new KvRepo(db).get<Partial<Learned>>(LEARNED_NS, keyOf(agentId, conversationId));
  return { core: names(value?.core).slice(-MAX_LEARNED), used: names(value?.used).slice(-MAX_USED) };
}

/** The tools this agent learned in this chat (offered with its core set); [] when none or unreadable. */
export function learnedTools(db: Db, agentId: string, conversationId: string | undefined): string[] {
  try { return read(db, agentId, conversationId).core; } catch { return []; }
}

/** Records a tools.call target (it joins at the next promotion); a known name changes nothing. Best effort. */
export function noteLearned(services: Pick<RuntimeServices, 'db' | 'clock'>, agentId: string, conversationId: string | undefined, name: string): void {
  try {
    const state = read(services.db, agentId, conversationId);
    if (state.core.includes(name) || state.used.includes(name)) return;
    new KvRepo(services.db).set(LEARNED_NS, keyOf(agentId, conversationId), { core: state.core, used: [...state.used, name].slice(-MAX_USED) }, services.clock.now());
  } catch { /* learning is an optimisation: the tool stays reachable through tools.call */ }
}

/** Moves `used` into `core` (newest kept); true when the learned list changed. Called only where a fresh session starts. */
export function promoteLearned(services: Pick<RuntimeServices, 'db' | 'clock'>, agentId: string, conversationId: string | undefined): boolean {
  try {
    const db = services.db;
    const state = read(db, agentId, conversationId);
    if (!state.used.length) return false;
    const core = [...state.core.filter((name) => !state.used.includes(name)), ...state.used].slice(-MAX_LEARNED);
    new KvRepo(db).set(LEARNED_NS, keyOf(agentId, conversationId), { core, used: [] }, services.clock.now());
    return core.length !== state.core.length || core.some((name, index) => name !== state.core[index]);
  } catch {
    return false;
  }
}

/** What an engine is offered directly: the mode's core set, the learned tools and the meta tools (registry offerFor). */
export function engineOffer(services: RuntimeServices, agent: Agent, mode: ModeInfo, engine: { ownTools: boolean; via: 'mcp' | 'native' }, conversationId: string | undefined): ToolSpec[] {
  const tools = services.tools;
  if (!tools.offerFor) return tools.specsFor(agent, mode, engine);
  let learned: string[] = [];
  try { learned = learnedTools(services.db, agent.id, conversationId); } catch { /* no db: the core set alone */ }
  return tools.offerFor(agent, mode, engine, learned);
}
