// Repository for the cost columns of `runs` (PR9, migration 24): `cost_basis` and `notional_usd`.
// Owns: their SQL and row mapping. Never: the other run columns (store/runs.ts) or the pricing
// rules (models/pricing.ts).

import type { Db } from '../db/database.ts';
import type { CostBasis, Run } from '../../shared/model/runs.ts';
import { compact, nul, opt, optNumber } from './rows.ts';

export type RunCostFields = Pick<Run, 'costBasis' | 'notionalUsd'>;

export class RunCostRepo {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  /** Sets both columns of an existing run (an unknown run id changes nothing). */
  save(runId: string, cost: { basis: CostBasis; notionalUsd?: number }): void {
    this.db.run('UPDATE runs SET cost_basis = ?, notional_usd = ? WHERE id = ?', [cost.basis, nul(cost.notionalUsd), runId]);
  }

  get(runId: string): RunCostFields | undefined {
    const row = this.db.get<{ cost_basis: string | null; notional_usd: number | null }>('SELECT cost_basis, notional_usd FROM runs WHERE id = ?', [runId]);
    return row ? compact({ costBasis: opt<CostBasis>(row.cost_basis), notionalUsd: optNumber(row.notional_usd) }) : undefined;
  }
}
