// AF-013: an engine turn's access (EngineTurnInput.access) – the mode, the folders a project turn may change, whether
// the network is on, and `decide` for the engine's own steps (Claude Code's prompts arrive through the hub instead:
// access/prompt-tool.ts). Absent (undefined) for full access without rules: every engine then runs exactly as before.
// Owns: building that policy. Never: engine flags (engines/claude/access.ts, engines/codex/access.ts).

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/access.ts';
import type { TurnAccessPolicy } from '../engines/types.ts';
import type { AccessScope } from './service.ts';

export function turnAccessPolicy(services: Pick<RuntimeServices, 'access'>, scope: AccessScope): TurnAccessPolicy | undefined {
  const access = services.access;
  if (!access) return undefined;
  let effective;
  try {
    if (access.unlimited(scope)) return undefined;
    effective = access.effective(scope);
  } catch { return undefined; }
  return {
    mode: effective.mode,
    writable: [...(effective.rules.folders?.write ?? [])],
    network: effective.rules.network !== 'deny' && effective.rules.network !== 'ask',
    networkDenied: effective.rules.network === 'deny',
    decide: async (via, actions, signal) => {
      const decision = await access.decide(scope, actions, via, signal);
      return { allow: decision.allow, message: decision.message };
    },
  };
}
