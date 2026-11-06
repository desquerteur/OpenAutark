// vector.embed: a model makes files or folders searchable with vector.search on purpose; they stay embedded.
// Owns: the tool's wording, argument shape and result text. Never: picks what is embedded (runtime/vectors does the work).

import path from 'node:path';
import type { VectorEmbedResult } from '../../../shared/model/vectors.ts';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool } from './util.ts';
import { readPath } from './files.ts';
import '../../contracts/vectors.ts';

const LISTED = 20;

/** "memory…" and "catalog…" (the knowledge catalog's virtual entries) as they are; anything else as files.read would find it. */
export async function placePath(ctx: ToolContext, given: string): Promise<string> {
  const place = given.trim();
  return place === 'memory' || /^memory[\\/]/.test(place) || place === 'catalog' || place.startsWith('catalog/') ? place : path.resolve(await readPath(ctx, place));
}

function report(result: VectorEmbedResult): string {
  const lines = [`Embedded ${result.embedded}, re-embedded ${result.reembedded}, already embedded ${result.unchanged}.`];
  const shown = result.skipped.slice(0, LISTED).map((entry) => `- ${entry.path}: ${clip(entry.reason, 120)}`);
  if (shown.length) lines.push(`Left out:`, ...shown);
  if (result.skipped.length > LISTED) lines.push(`… and ${result.skipped.length - LISTED} more.`);
  if (result.remaining) lines.push(`${result.remaining} files not finished: call vector.embed again with the same paths to go on.`);
  return lines.join('\n');
}

export const vectorEmbed: ToolDef = defineTool<{ paths: string[] }>({
  name: 'vector.embed',
  description: 'Makes files or folders searchable with vector.search: embeds whole files and keeps them, at a cost in time, so I embed what my work keeps coming back to; a file or two is quicker read. Unchanged files are not redone. Folders skip binaries, dependency folders, caches and secrets. Big folders: call again for the rest.',
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1024 } } },
    required: ['paths'], additionalProperties: false,
  },
  category: 'read',
  anyMode: true,
  describe: (args) => ({ summary: `Embed ${clip(args.paths.join(', '), 120)}`, resource: args.paths[0], reversible: true, external: false }),
  async run(args, ctx) {
    if (ctx.fromPc !== undefined) return failure('vector.embed runs only for agents of this PC.');
    if (!ctx.services.vectors.available()) return failure('No embedding model is available (Settings: Embeddings). Search with files.search instead.');
    const places = await Promise.all(args.paths.map((given) => placePath(ctx, given)));
    return text(report(await ctx.services.vectors.embed(places)));
  },
});
