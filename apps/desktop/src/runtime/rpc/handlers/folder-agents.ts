// RPC handlers (AF-014) of "Agent from folder": find (what the folder suggests), create (hire the agent with the folder
// as its home project and access mode 'project') and homes (who works in which folder). Owner only: these are folders
// of this PC. Owns: param checks. Never: business logic (runtime/folder-agents).

import path from 'node:path';
import { WorkforceError } from '../../../shared/errors.ts';
import '../../contracts/agent-core.ts';
import '../../../shared/api/methods-folder-agents.ts'; // the method shapes (module augmentation)
import { ACCESS_MODES } from '../../../shared/model/access.ts';
import { HOME_MAX_CHARS } from '../../../shared/model/agent-core.ts';
import { createFolderAgent, findFolder } from '../../folder-agents/create.ts';
import { input, onlyKeys, optOneOf, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('folderAgents.find', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['folder']);
    return findFolder(ctx.services, text(o, 'folder', { max: HOME_MAX_CHARS }));
  }, 'owner');
  table.add('folderAgents.create', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['folder', 'name', 'role', 'mode']);
    const mode = optOneOf(o, 'mode', ACCESS_MODES);
    return createFolderAgent(ctx.services, {
      folder: text(o, 'folder', { max: HOME_MAX_CHARS }),
      name: optText(o, 'name', { max: 80, allowEmpty: true }) ?? '',
      role: optText(o, 'role', { max: 80, allowEmpty: true }) ?? '',
      ...(mode ? { mode } : {}),
    });
  }, 'owner');
  table.add('folderAgents.homes', (params, ctx) => {
    if (params !== undefined && params !== null) onlyKeys(input(params), []);
    const homes = ctx.services.agentCore?.homes;
    if (!homes) throw new WorkforceError('unavailable', 'Agent folders are not available in this runtime.');
    return ctx.services.org.list().flatMap((agent) => {
      let folder: string | undefined;
      try { folder = homes.stored(agent.id); } catch { folder = undefined; }
      return folder ? [{ agentId: agent.id, folder, label: path.basename(folder) || folder }] : [];
    });
  }, 'owner');
}
