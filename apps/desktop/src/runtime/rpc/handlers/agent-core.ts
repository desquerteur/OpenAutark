// RPC handlers (wave 3) of the agent core folder: agents.core with 'chat' (a read like agents.get
// and skills.list; the folder path and the skills' paths only for the person on the PC – "Open folder"
// is files.openPath, owner only) and agents.saveMainSkill with 'manage' (like skills.save; `base` = the
// text the editor started from: a SKILL.md changed meanwhile is a conflict, never overwritten unseen).
// People of the organisation reach neither (no person variant). Removing a Main Skill is skills.delete (owner).
// B-044: agents.setHome (owner – a folder of this PC): the person sets or clears an agent's home project
// (agent-core/home.ts checks the folder; agents set their own through the agents.update tool), and
// agents.openHome (owner) opens exactly that folder while it is usable – files.openPath only opens the
// workspace and the data folder, and a home project usually lies elsewhere.
// Owns: param checks. Never: business logic (agent-core/service.ts, skills/service.ts); a runtime
// without the agent core answers 'unavailable'.

import { statSync } from 'node:fs';
import { WorkforceError } from '../../../shared/errors.ts';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/agent-core.ts';
import '../../../shared/api/methods-agent-core.ts'; // the method shapes (module augmentation)
import { isCoreFolderName } from '../../agent-core/layout.ts';
import { staleBase } from '../../root/text-doc.ts';
import { HOME_MAX_CHARS } from '../../../shared/model/agent-core.ts';
import { bad, id, input, onlyKeys, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;
const MANAGE = { capability: 'manage' } as const;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION = { max: 1024 } as const;
const BODY = { max: 200_000, multiline: true } as const; // ≤ 600 KB of UTF-8: below MAIN_SKILL_MAX_BYTES

function core(services: RuntimeServices) {
  if (!services.agentCore) throw new WorkforceError('unavailable', 'Agent folders are not available in this runtime.');
  return services.agentCore;
}

export function register(table: HandlerTable): void {
  table.add('agents.core', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId']);
    return core(ctx.services).info(id(o, 'agentId'), ctx.scope.kind === 'owner');
  }, CHAT);
  table.add('agents.saveMainSkill', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'name', 'description', 'body', 'base']);
    const agentId = id(o, 'agentId');
    const name = text(o, 'name', { max: 64 }).trim();
    if (!SKILL_NAME.test(name)) bad('name', 'a skill name (lowercase letters, digits and hyphens)');
    const description = text(o, 'description', DESCRIPTION);
    const body = text(o, 'body', BODY);
    const baseIn = o.base === undefined ? undefined : input(o.base);
    if (baseIn) onlyKeys(baseIn, ['description', 'body'], 'base');
    core(ctx.services);
    const agent = ctx.services.org.require(agentId);
    if (agent.archivedAt !== undefined) throw new WorkforceError('conflict', 'Restore this agent first.', { details: { id: agentId } });
    if (!isCoreFolderName(agentId)) throw new WorkforceError('conflict', 'This agent has no agent folder, so it cannot have main skills.');
    const current = baseIn ? ctx.services.skills.get(name, agentId) : undefined;
    if (baseIn && current) {
      const base = { description: text(baseIn, 'description', { ...DESCRIPTION, allowEmpty: true }), body: text(baseIn, 'body', { ...BODY, allowEmpty: true }) };
      if (staleBase(current.info.description, base.description, description) || staleBase(current.body, base.body, body)) {
        throw new WorkforceError('conflict', 'This main skill changed while you were editing (its SKILL.md or another save). Load the new text and save again.');
      }
    }
    return ctx.services.skills.save({ name, description, body, ownerAgentId: agentId, main: true });
  }, MANAGE);
  table.add('agents.setHome', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId', 'home']);
    if (!('home' in o)) bad('home', 'a folder path, or null to clear it');
    const home = optText(o, 'home', { max: HOME_MAX_CHARS, allowEmpty: true });
    const set = core(ctx.services).setHome(id(o, 'agentId'), home);
    return set ? { home: set } : {};
  }, 'owner');
  table.add('agents.openHome', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['agentId']);
    const agentId = id(o, 'agentId');
    ctx.services.org.require(agentId);
    const home = core(ctx.services).homes.usable(agentId);
    let folder = false;
    try { folder = home !== undefined && statSync(home).isDirectory(); } catch { /* gone since its last check */ }
    if (!home || !folder) throw new WorkforceError('not_found', 'This agent has no home project folder that can be opened.');
    await ctx.services.host.openPath(home, false);
    return { ok: true as const };
  }, 'owner');
}
