// Spend journal: the `spend` table (model cost in USD, plus anything else an agent books), shown by spend.list.
// Owns: every write to `spend`, formatMoney. Never: blocks a call, converts currencies or stores anything but
// amounts and references.

import { newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { SpendEntry } from '../../shared/model/security.ts';
import type { RuntimeServices, SpendLedger } from '../contracts.ts';

const KINDS: ReadonlySet<string> = new Set(['tokens', 'purchase', 'subscription', 'ads', 'other']);

export type SpendInput = Parameters<SpendLedger['record']>[0];

/** "20 EUR", "12.50 USD" – short, locale-free money text. */
export function formatMoney(value: number, currency: string): string {
  const rounded = Math.round(value * 100) / 100;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)} ${currency}`;
}

export class Spend implements SpendLedger {
  private readonly services: () => RuntimeServices;

  constructor(deps: { services: () => RuntimeServices }) {
    this.services = deps.services;
  }

  /** Validates and books one entry; zero amounts are ignored. */
  record(input: SpendInput): SpendEntry | undefined {
    const s = this.services();
    if (!input || typeof input.agentId !== 'string' || !input.agentId) throw new WorkforceError('bad_request', 'A spend entry needs an agent.');
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0 || input.amount > 1e9) {
      throw new WorkforceError('bad_request', 'A spend entry needs a non-negative amount.');
    }
    if (typeof input.currency !== 'string' || !/^[A-Za-z]{3}$/.test(input.currency)) throw new WorkforceError('bad_request', 'A spend entry needs an ISO currency code.');
    if (!KINDS.has(input.kind)) throw new WorkforceError('bad_request', 'Unknown spend kind.');
    if (input.amount === 0) return undefined;
    const now = s.clock.now();
    const entry: SpendEntry = { id: newId('spd', now), agentId: input.agentId, amount: input.amount, currency: input.currency.toUpperCase(), kind: input.kind, createdAt: now };
    if (typeof input.ref === 'string' && input.ref) entry.ref = input.ref.slice(0, 300);
    s.db.run('INSERT INTO spend (id, agent_id, amount, currency, kind, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      entry.id, entry.agentId, entry.amount, entry.currency, entry.kind, entry.ref ?? null, entry.createdAt,
    ]);
    return entry;
  }
}
