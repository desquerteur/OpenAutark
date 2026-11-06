// A run's cost as the person reads it (PR9) – for run lists on the desktop and the phone:
// a real charge "$0.012" (an estimate from list prices "≈ $0.012"), a plan turn
// "$0.40 · plan, no charge" (its notional list-price cost), a paid turn without a known price
// "unpriced", nothing for local models. Runs from before PR9 (no basis) show their cost as stored.
// Owns: the wording. Never: prices anything (runtime/models/pricing.ts does).

import type { Run } from '../model/runs.ts';

const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

export function runCostText(run: Pick<Run, 'costUsd' | 'costBasis' | 'notionalUsd'>): string {
  switch (run.costBasis) {
    case 'plan': return run.notionalUsd ? `${usd(run.notionalUsd)} · plan, no charge` : 'plan, no charge';
    case 'unpriced': return 'unpriced';
    case 'free': return '';
    case 'list-price':
    case 'prior-price': return run.costUsd ? `≈ ${usd(run.costUsd)}` : '';
    default: return run.costUsd ? usd(run.costUsd) : '';
  }
}
