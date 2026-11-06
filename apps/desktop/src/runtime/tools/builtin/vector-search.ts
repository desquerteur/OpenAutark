// vector.search: grep over meaning. Embeds only the query and compares it with what is already embedded under the places;
// B-078: `hops` (vectors/hops.ts) and the "catalog" place (the knowledge catalog's virtual entries).
// Owns: the tool's wording, argument shape and result text. Never: embeds files itself (a model does, with vector.embed).

import path from 'node:path';
import type { VectorHit } from '../../../shared/model/vectors.ts';
import type { ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool } from './util.ts';
import { MAX_K } from '../../vectors/service.ts';
import { MAX_HOPS } from '../../vectors/hops.ts';
import { placePath, vectorEmbed } from './vector-embed.ts';
import '../../contracts/vectors.ts';

function line(hit: VectorHit): string {
  const where = hit.lines ? `${hit.path}:${hit.lines[0]}-${hit.lines[1]}` : `${hit.path} #${hit.chunk}`;
  return `${hit.score.toFixed(2)} ${where}${hit.via ? ` (via ${hit.via})` : ''}\n  ${clip(hit.snippet.replace(/\s+/g, ' ').trim(), 240)}`;
}

export const vectorSearch: ToolDef = defineTool<{ query: string; in: string[]; k?: number; hops?: number }>({
  name: 'vector.search',
  description: 'Searches by meaning, like grep for ideas, in what is embedded under `in` (files, folders, "memory/<folder>", "catalog": skills, home project, public library). The words a matching text holds find it; a question blurs it. hops 1–2: my best hits search on, so what lies close to them comes too. Exact words: files.search.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000 },
      in: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1024 } },
      k: { type: 'integer', minimum: 1, maximum: MAX_K },
      hops: { type: 'integer', minimum: 0, maximum: MAX_HOPS },
    },
    required: ['query', 'in'], additionalProperties: false,
  },
  category: 'read',
  anyMode: true,
  describe: (args) => ({ summary: `Search by meaning for "${clip(args.query, 80)}" in ${clip(args.in.join(', '), 80)}`, resource: args.in[0], reversible: true, external: false }),
  async run(args, ctx) {
    if (ctx.fromPc !== undefined) return failure('vector.search runs only for agents of this PC.');
    const query = args.query.trim();
    if (!query) return failure('Say what to search for.');
    const places = await Promise.all(args.in.map((given) => placePath(ctx, given)));
    const result = await ctx.services.vectors.search({ query, in: places, ...(args.k ? { k: args.k } : {}), ...(args.hops ? { hops: args.hops } : {}) });
    const lines: string[] = [];
    if (result.note) lines.push(result.note);
    lines.push(`${result.hits.length} hits.`);
    lines.push(...result.hits.map(line));
    if (result.hits.some((hit) => hit.path.startsWith('memory/'))) lines.push(`memory/ is ${path.join(ctx.services.paths.data, 'memory')}`);
    return text(lines.join('\n'));
  },
});

export const vectorTools: ToolDef[] = [vectorEmbed, vectorSearch];
