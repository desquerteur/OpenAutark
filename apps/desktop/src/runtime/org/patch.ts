// An edit of an agent (OrgService.update): the patch's
// fields validated and applied to a copy. Generated initials follow a rename; their color (picked
// or given at hire) and custom avatars stay – the same rule as org/restore.ts. An absent or null
// optional field clears it.
// Owns: field-level checks of an edit and the org checks it needs from its caller (unique name,
// existing space, an active manager that is not the agent itself or one of its reports).
// Never: saves or emits events (org/service.ts), or decides who may edit.

import { WorkforceError } from '../../shared/errors.ts';
import type { Agent, AgentStatus } from '../../shared/model/org.ts';
import { defaultAvatar } from './avatar.ts';
import { checkAvatar } from './avatar-files.ts';
import { cleanAvatar, cleanMode, cleanName, cleanObject, cleanSkills, cleanText, cleanVoice } from './validate.ts';

export const STATUSES: readonly AgentStatus[] = ['idle', 'working', 'waiting', 'paused', 'error'];

/** What an edit needs to know about the rest of the org. */
export interface PatchRules {
  nameTaken(name: string): boolean;
  spaceExists(id: string): boolean;
  /** Throws unless `managerId` may manage this agent (active, no cycle). */
  checkManager(managerId: string): void;
}

/** `agent` with `patch` applied after validation; `updatedAt` stays for the caller to set. */
export function patchedAgent(agent: Agent, patch: Partial<Agent>, rules: PatchRules): Agent {
  const next: Agent = { ...agent };
  const has = (key: keyof Agent) => Object.hasOwn(patch, key);
  const cleared = (key: keyof Agent) => has(key) && (patch[key] === undefined || patch[key] === null);

  if (has('name')) {
    next.name = cleanName(patch.name);
    if (next.name.toLocaleLowerCase() !== agent.name.toLocaleLowerCase() && rules.nameTaken(next.name)) {
      throw new WorkforceError('conflict', 'Choose a different agent name.');
    }
    if (agent.avatar.kind === 'initials' && !has('avatar')) {
      const letters = defaultAvatar(agent.id, next.name);
      next.avatar = agent.avatar.color === undefined ? letters : { ...letters, color: agent.avatar.color };
    }
  }
  if (has('role')) next.role = cleanText(patch.role ?? '', 'role', 80).trim();
  if (has('avatar')) next.avatar = checkAvatar(cleanAvatar(patch.avatar));
  if (has('instructions')) next.instructions = cleanText(patch.instructions ?? '', 'instructions', 20000);
  if (has('mode')) next.mode = cleanMode(patch.mode);
  if (has('skills')) next.skills = cleanSkills(patch.skills ?? []);
  if (has('modelPolicy')) next.modelPolicy = cleanObject(patch.modelPolicy ?? {}, 'model policy');
  if (has('team')) next.team = cleared('team') ? undefined : cleanText(patch.team, 'team', 80).trim() || undefined;
  if (has('deviceId')) next.deviceId = cleared('deviceId') ? undefined : cleanText(patch.deviceId, 'device', 80);
  if (has('voice')) next.voice = cleared('voice') || patch.voice === '' ? undefined : cleanVoice(patch.voice);
  if (has('statusNote')) next.statusNote = cleared('statusNote') ? undefined : cleanText(patch.statusNote, 'status', 200);
  if (has('status')) {
    if (!STATUSES.includes(patch.status as AgentStatus)) throw new WorkforceError('bad_request', 'Invalid agent status.');
    next.status = patch.status as AgentStatus;
  }
  if (has('spaceId')) {
    next.spaceId = cleared('spaceId') ? undefined : patch.spaceId;
    if (next.spaceId && !rules.spaceExists(next.spaceId)) throw new WorkforceError('not_found', 'This space no longer exists.');
  }
  if (has('managerId')) {
    next.managerId = cleared('managerId') ? undefined : patch.managerId;
    if (next.managerId) rules.checkManager(next.managerId);
  }
  return next;
}
