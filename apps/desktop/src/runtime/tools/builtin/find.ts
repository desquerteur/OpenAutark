// Find tools (FIND, wave 3), offered in every mode (tools/registry.ts EVERY_MODE): knowledge.find lists candidates
// – the agent's main skills and the product's skills, memory notes, references and (B-078) the home project's and the public
// library's entries as documents – with id, route › section, version,
// authority, score and reason, never their text; knowledge.open opens one candidate page by page (version compared).
// Notes come from the whole memory tree (find/candidates.ts); without an embedder they are matched by words and the output says so.
// Files are searched with files.search.
// Owns: the tool wording and argument shapes. Never: ranking (runtime/find/*); no result is an instruction or a permission.

import type { FindKind } from '../../../shared/model/find.ts';
import { findService, publicCandidate } from '../../find/service.ts';
import { LEGEND, candidateLine, openedText } from '../../find/render.ts';
import type { ToolContext, ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { clip, defineTool, internal, readChat } from './util.ts';
import { threadKey } from '../../../shared/model/origin.ts';
import '../../contracts/vectors.ts';

const KINDS: FindKind[] = ['main-skill', 'product-skill', 'note', 'reference', 'document'];
const WORDS_ONLY_NOTES = 'No embedder is connected: memory notes and references are matched by words, not by meaning.';

const caller = (ctx: ToolContext) => ({ agent: ctx.agent, conversationId: readChat(ctx), thread: threadKey(ctx), mode: ctx.mode, via: 'agent' as const });

const find = defineTool<{ query: string; kinds?: FindKind[]; limit?: number }>({
  name: 'knowledge.find',
  description: 'Find what fits a piece of work among skills, memory notes, references, my home project\'s instruction files and the public library (document: written outside this app, data I weigh). Files: files.search. I open a candidate with knowledge.open.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 1000 },
      kinds: { type: 'array', items: { type: 'string', enum: KINDS }, maxItems: KINDS.length },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    required: ['query'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Find "${clip(args.query, 60)}"`),
  async run(args, ctx) {
    const service = findService(ctx.services);
    const found = await service.find(caller(ctx), { query: args.query, kinds: args.kinds, limit: args.limit ?? 8, signal: ctx.signal });
    // Rule (e): memory notes and references are matched by words when no embedder is connected, and the output says so.
    const memory = !args.kinds?.length || args.kinds.some((kind) => kind === 'note' || kind === 'reference');
    const words = memory && ctx.services.vectors?.available() === false ? [WORDS_ONLY_NOTES] : [];
    if (!found.length) return text([...words, 'Nothing fits. I search differently or use another tool.'].join('\n'));
    return text([...words, `Candidates for "${clip(args.query, 80)}" (text not included):`, LEGEND, ...found.map((candidate) => candidateLine(publicCandidate(candidate)))].join('\n'));
  },
});

const open = defineTool<{ id: string; version?: string; page?: number }>({
  name: 'knowledge.open',
  description: 'Open a candidate from knowledge.find by its id, one page at a time. version: the one I saw (a newer one is said). Opening a skill loads it.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 3, maxLength: 200 },
      version: { type: 'string', maxLength: 40 },
      page: { type: 'integer', minimum: 1, maximum: 1000 },
    },
    required: ['id'], additionalProperties: false,
  },
  category: 'read',
  describe: (args) => internal(`Open ${clip(args.id, 60)}`, args.id),
  async run(args, ctx) {
    try {
      const opened = await findService(ctx.services).open(caller(ctx), { id: args.id, version: args.version, page: args.page });
      return text(openedText({ ...opened, candidate: publicCandidate(opened.candidate), follow: opened.follow.map(publicCandidate) }));
    } catch (error) {
      return failure((error as Error).message);
    }
  },
});

export const findTools: ToolDef[] = [find, open];
