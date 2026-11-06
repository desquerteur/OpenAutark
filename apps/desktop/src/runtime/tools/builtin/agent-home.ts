// B-044 AGENT-HOME: agents.update `home` (tools/builtin/agents.ts) – the agent sets its own home project (or a
// manager a report's): the folder its turns start in when the task has no worktree, kept in its agent.json
// (agent-core/home.ts). Checked when the call is described (a folder that cannot be one fails at once) and
// again when it is stored.
// Owns: the argument, the summary part and the result line. Never: writes into the folder or lets a
// folder agent-core/home.ts refuses (data folder, CLI settings, network, a hidden, app data or system folder …) through.

import type { ToolContext } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { HOME_MAX_CHARS } from '../../../shared/model/agent-core.ts';
import '../../contracts/agent-core.ts';

export const HOME_ARG = { type: 'string', maxLength: HOME_MAX_CHARS } as const;

export const HOME_HELP = "home: the project folder its turns start in ('' = none).";

function core(ctx: Pick<ToolContext, 'services'>) {
  const agentCore = ctx.services.agentCore;
  if (!agentCore) throw new WorkforceError('unavailable', 'Home projects are not available in this runtime.');
  return agentCore;
}

/** The summary part for a `home` value (throws 'bad_request' with the reason for a folder that cannot be one). */
export function homeAction(ctx: Pick<ToolContext, 'services'>, value: string): { part: string; resource?: string } {
  const dir = core(ctx).homes.resolve(value); // the agent core's own folders and rules, like setHome
  return dir ? { part: `home project ${dir}`, resource: dir } : { part: 'no home project' };
}

/** Stores it (agent.json); the result names the folder (`home`, '' = none), or why turns do not start there yet (`homeNote`). */
export function applyHome(ctx: Pick<ToolContext, 'services'>, agentId: string, value: string): { home: string; homeNote?: string } {
  const home = core(ctx).setHome(agentId, value);
  return home ? { home: home.path, ...(home.text ? { homeNote: home.text } : {}) } : { home: '' };
}
