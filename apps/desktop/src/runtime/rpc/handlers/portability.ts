// RPC handlers: agents.export ("Export" – one file) and the installation's backup/restore (a copy of the data
// folder, put back at the next start). Duplicating an agent is the skill agent-duplicate, not a method.
// Owns: param checks. Agent export needs the 'manage' capability (like hiring); backup/restore are owner
// only (paths on this PC, absolute so they never resolve against the runtime's cwd).
// Never: portability logic (Portability via extras.portability).

import path from 'node:path';
import { bad, id, input, onlyKeys, optBool, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const MANAGE = { capability: 'manage' } as const;

function absolute(value: string, key: string): string {
  if (!path.isAbsolute(value)) bad(key, 'an absolute path');
  return value;
}

export function register(table: HandlerTable): void {
  table.add('agents.export', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'includeKnowledge']);
    return ctx.extras.portability.exportAgent(id(o), { includeKnowledge: optBool(o, 'includeKnowledge') ?? true });
  }, MANAGE);

  table.add('system.backup', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['dir']);
    const dir = optText(o, 'dir', { max: 4096 });
    return ctx.extras.portability.backup(dir === undefined ? undefined : absolute(dir, 'dir'));
  });
  table.add('system.restore', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['path']);
    return ctx.extras.portability.restore(absolute(text(o, 'path', { max: 4096 }), 'path'));
  });
}
