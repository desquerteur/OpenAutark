// Migration 24 (PR9): how a run's cost was judged (`cost_basis`: provider, list-price,
// prior-price, unpriced, plan, free – shared/model/runs.ts CostBasis) and a plan turn's notional
// list-price cost (`notional_usd`, never booked as spend). `cost_usd` keeps the real charge only.
// Rows from earlier versions keep NULL (their cost_usd may still hold a plan's notional price).

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN cost_basis TEXT;
ALTER TABLE runs ADD COLUMN notional_usd REAL;
`;
