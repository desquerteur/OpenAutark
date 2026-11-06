// Space tools: the person's areas (company, personal brand, private life, custom areas).
// Owns: spaces.list and spaces.save (create or rename a space).
// Never: archives spaces (only the human – the spaces.archive RPC; B-044: Settings › Agents went), changes a space's kind or renames
// an archived one, or moves agents between spaces (hiring places agents; the human changes an
// agent's space).

import type { ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { defineTool, internal } from './util.ts';

const SPACE_KINDS = ['company', 'brand', 'private', 'custom'] as const;

const listSpaces = defineTool<Record<string, never>>({
  name: 'spaces.list',
  description: 'List the active spaces (areas such as the company, the personal brand or private life) with id, name, kind and number of agents.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  category: 'read',
  describe: () => internal('List spaces'),
  async run(_args, ctx) {
    const agents = ctx.services.org.list();
    return json(ctx.services.org.spaces().map((space) => ({
      id: space.id, name: space.name, kind: space.kind,
      agents: agents.filter((agent) => agent.spaceId === space.id).length,
      yours: ctx.agent.spaceId === space.id || undefined,
    })));
  },
});

const saveSpace = defineTool<{ id?: string; name: string; kind?: typeof SPACE_KINDS[number] }>({
  name: 'spaces.save',
  description: 'Create a space (name and kind: company, brand, private or custom) or rename an active one by id (its kind stays). Hiring from a template creates its company/brand/private space by itself.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 80 }, kind: { type: 'string', enum: [...SPACE_KINDS] } },
    required: ['name'], additionalProperties: false,
  },
  category: 'agents',
  describe: (args, ctx) => {
    const old = args.id ? ctx.services.org.spaces().find((space) => space.id === args.id) : undefined;
    const summary = args.id ? `Rename space "${old?.name ?? args.id}" to "${args.name}"` : `Create ${args.kind ?? 'custom'} space "${args.name}"`;
    return { summary, resource: args.id, reversible: true, external: false };
  },
  async run(args, ctx) {
    if (args.id) {
      // A rename only: changing the kind would move the area's hires and knowledge (e.g. turn the
      // private space into a company space), which the approval for a rename never covers.
      const existing = ctx.services.org.spaces().find((space) => space.id === args.id);
      if (!existing) return failure('This space does not exist or is archived (spaces.list shows the active ones).');
      if (args.kind && args.kind !== existing.kind) return failure('A space keeps its kind. Create a new space for another kind.');
      const space = ctx.services.org.saveSpace({ id: existing.id, name: args.name });
      return json({ ok: true, spaceId: space.id, name: space.name, kind: space.kind });
    }
    const space = ctx.services.org.saveSpace({ name: args.name, ...(args.kind ? { kind: args.kind } : {}) });
    return json({ ok: true, spaceId: space.id, name: space.name, kind: space.kind });
  },
});

export const spaceTools: ToolDef[] = [listSpaces, saveSpace];
