// What embedding costs (contract: every model use is in the spend journal): a pay-per-use account's tokens priced like any other
// attempt (models/pricing.ts: the provider's own price, else the curated list price; a plan or local server costs nothing) and booked
// as 'tokens'. A batch costs far less than a cent, so amounts wait until they make a row worth reading, and the rest goes at the stop.
// Owns: that sum per model. Never: blocks an embedding (a failed booking is logged), invents a price.

import type { RuntimeServices } from '../contracts.ts';
import { priorFor } from '../models/catalog-merge.ts';
import { attemptCost } from '../models/pricing.ts';
import { Priors } from '../models/priors.ts';

/** The spend journal's "who" for embedding: nobody's turn pays for it alone. */
export const EMBEDDING_SPENDER = 'embeddings';
const BOOK_FROM_USD = 0.01;

export interface EmbedUse { tokens: number; costUsd?: number }
export interface EmbedAccount { accountId: string; provider: string; model: string }

type Services = Pick<RuntimeServices, 'spend' | 'accounts' | 'catalog' | 'paths' | 'log'>;

export class EmbedSpend {
  private readonly services: () => Services;
  private readonly waiting = new Map<string, number>();

  constructor(services: () => Services) {
    this.services = services;
  }

  add(choice: EmbedAccount, use: EmbedUse): void {
    try {
      const s = this.services();
      const priors = Priors.shipped(s.paths?.resources, (error) => s.log.warn('model priors not loaded for embedding prices', { error: String(error) }));
      const id = `${choice.provider}:${choice.model}`;
      let model: ReturnType<Services['catalog']['get']>;
      try { model = s.catalog.get(id); } catch { model = undefined; }
      const usd = attemptCost({
        account: s.accounts.get(choice.accountId), usage: { inputTokens: use.tokens, outputTokens: 0, ...(use.costUsd !== undefined ? { costUsd: use.costUsd } : {}) },
        model, prior: priorFor(priors, choice.model, id),
      }).usd;
      if (!usd) return;
      const sum = (this.waiting.get(choice.model) ?? 0) + usd;
      if (sum >= BOOK_FROM_USD) this.book(choice.model, sum);
      else this.waiting.set(choice.model, sum);
    } catch (error) {
      this.warn(error);
    }
  }

  /** The app stops: what is left goes in. */
  flush(): void {
    for (const [model, sum] of [...this.waiting]) this.book(model, sum);
  }

  private book(model: string, amount: number): void {
    this.waiting.delete(model);
    try {
      this.services().spend.record({ agentId: EMBEDDING_SPENDER, amount: Math.round(amount * 1e6) / 1e6, currency: 'USD', kind: 'tokens', ref: `embedding:${model}` });
    } catch (error) {
      this.warn(error);
    }
  }

  private warn(error: unknown): void {
    try { this.services().log.warn('embedding cost not booked', { error: String(error) }); } catch { /* nothing to report to */ }
  }
}
