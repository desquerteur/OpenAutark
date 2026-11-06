// Session prompt key (SES2): what a native session was started with. A resumed Codex thread or
// Claude session keeps the system prompt and tool offer of its start, so a turn may resume it
// only while both are unchanged (a mode switch changes the mode section and the tools).
// Owns: the tools offered to an engine for a turn (native dynamic tools; the MCP hub's list,
// which the hub computes the same way), the key (sha256 of the stable prompt + sorted offered
// tool names) and the "Mode changed from X to Y" note.
// Never: reads or writes session rows, renews sessions (turn-prepare.ts) or starts engines.

import { createHash } from 'node:crypto';
import type { RuntimeServices } from '../contracts.ts';
import type { EngineCaps } from '../engines/types.ts';
import type { ToolSpec } from '../tools/types.ts';
import type { ModeInfo } from '../../shared/model/knowledge.ts';
import type { TurnPlan } from './turn-types.ts';
import { engineOffer } from '../tools/learned.ts'; // B-049 F4

export interface ToolOffer {
  /** Passed to engine.run as dynamic tools (engines with caps.dynamicTools). */
  native: ToolSpec[];
  /** Every tool name the engine is offered (native and via the MCP hub), sorted and unique. */
  names: string[];
}

/** The tools this turn offers, natively and through the MCP hub lease (hub.ts `specs`): B-049 F4 – the core set, the
 *  tools learned in this chat and tools.find / tools.call (tools/learned.ts engineOffer). */
export function offeredTools(services: RuntimeServices, plan: Pick<TurnPlan, 'agent' | 'mode' | 'conversationId'>, caps: Pick<EngineCaps, 'dynamicTools' | 'mcp' | 'ownTools'>): ToolOffer {
  const native = caps.dynamicTools ? engineOffer(services, plan.agent, plan.mode, { ownTools: caps.ownTools, via: 'native' }, plan.conversationId) : [];
  const viaHub = caps.mcp ? engineOffer(services, plan.agent, plan.mode, { ownTools: true, via: 'mcp' }, plan.conversationId) : [];
  const names = [...new Set([...native, ...viaHub].map((tool) => tool.name))].sort();
  return { native, names };
}

/** sha256 over the stable prompt and the sorted offered tool names. */
export function promptKey(stable: string, toolNames: readonly string[]): string {
  return createHash('sha256').update(stable).update('\u0000').update([...toolNames].sort().join('\n')).digest('hex');
}

function modeName(services: RuntimeServices, key: string): string {
  try { return services.modes.get(key).name || key; } catch { return key; }
}

/** Told to the agent when its session was renewed for a mode switch. */
export function modeChangeNote(services: RuntimeServices, from: string, to: ModeInfo): string {
  return `Mode changed from ${modeName(services, from)} to ${to.name || to.key}. My instructions and tools now follow the new mode.`;
}
