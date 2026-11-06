// spend.note: an agent books what it bought into the spend journal beside the model costs (spend/ledger.ts), so anyone can
// trace it later (spend.list, Settings). How a purchase is weighed is the skill `money`.
// Owns: this tool. Never: limits, checks or refuses a purchase; there are no budgets.

import { failure, json } from '../types.ts';
import { clip, defineTool, internal } from './util.ts';

const KINDS = ['purchase', 'subscription', 'ads', 'other'] as const;

/** The journal's one reference line: what it was, where the receipt is, when it renews. */
export function spendRef(args: { what: string; receipt?: string; renewal?: string }): string {
  return [args.what.trim(), args.receipt?.trim() && `receipt: ${args.receipt.trim()}`, args.renewal?.trim() && `renews: ${args.renewal.trim()}`].filter(Boolean).join(' · ');
}

const note = defineTool<{ amount: number; currency: string; what: string; kind?: (typeof KINDS)[number]; receipt?: string; renewal?: string }>({
  name: 'spend.note',
  description: 'Book money I spent, so anyone can trace it: the amount, what it was and why, where the receipt is (file id, path or order number) and when a subscription renews.',
  inputSchema: {
    type: 'object',
    properties: {
      amount: { type: 'number', minimum: 0 }, currency: { type: 'string', description: 'ISO code such as EUR' },
      what: { type: 'string', minLength: 1, maxLength: 120 }, kind: { type: 'string', enum: [...KINDS] },
      receipt: { type: 'string', maxLength: 120 }, renewal: { type: 'string', maxLength: 20 },
    },
    required: ['amount', 'currency', 'what'], additionalProperties: false,
  },
  category: 'think',
  anyMode: true,
  describe: (args) => internal(`Book ${args.amount} ${args.currency}: ${clip(args.what, 60)}`),
  async run(args, ctx) {
    const booked = { amount: args.amount, currency: args.currency, kind: args.kind ?? 'purchase', ref: spendRef(args) };
    if (args.amount === 0) return failure('Nothing booked: the amount is 0.');
    ctx.services.spend.record({ agentId: ctx.agent.id, ...booked });
    return json({ ok: true, booked });
  },
});

export const spendTools = [note];
