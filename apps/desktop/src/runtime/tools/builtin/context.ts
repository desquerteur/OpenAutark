// The main AI's own way back (owner 28.10.2026): context.restore {ids, keep?} brings condensed or hidden parts of its working
// context back as this tool's output (context/ledger/restore.ts). Reached through tools.find; the stamp under a condensed text
// names it. Finding what it forgot goes through the subconscious tool instead.
// Owns: the definition and its short spec. Never: another agent's or chat's ledger.

import type { ToolDef } from '../types.ts';
import { failure, text } from '../types.ts';
import { MAX_RESTORE_IDS, restoreItems } from '../../context/ledger/restore.ts';
import { PIN_TURNS } from '../../../shared/model/context-ledger.ts';
import { defineTool, internal } from './util.ts';

const restore = defineTool<{ ids: string[]; keep?: boolean }>({
  name: 'context.restore',
  description: `Gets condensed or hidden parts of my working context back, as this tool's output, for ${PIN_TURNS} turns. ids: from their stamps (or a chat message's m<number>). keep: true keeps them for good, false lets a kept one go again.`,
  inputSchema: {
    type: 'object',
    properties: { ids: { type: 'array', minItems: 1, maxItems: MAX_RESTORE_IDS, items: { type: 'string', minLength: 2, maxLength: 16 } }, keep: { type: 'boolean' } },
    required: ['ids'], additionalProperties: false,
  },
  category: 'read',
  anyMode: true,
  describe: (args) => internal(`Restore ${args.ids.slice(0, 5).join(', ')}${args.keep ? ' (keep)' : ''}`),
  async run(args, ctx) {
    if (!ctx.conversationId) return failure('Nothing to restore: this run has no chat, and condensed context is kept per chat.');
    return text(restoreItems(ctx.services, ctx.agent.id, ctx.conversationId, { ids: args.ids, ...(args.keep !== undefined ? { keep: args.keep } : {}) }));
  },
});

export const contextTools: ToolDef[] = [restore];
