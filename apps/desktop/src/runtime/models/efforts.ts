// Effort (reasoning level) normalization across providers.
// Owns: the canonical scale none < low < medium < high < xhigh < max, mapping of provider
// spellings onto it, clamping to what a model supports, and one-step raise/lower.
// Never: provider wire values – engines translate the canonical value themselves.

import type { Effort } from '../../shared/model/providers.ts';

export const EFFORT_ORDER: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

const ALIASES: Record<string, Effort> = {
  none: 'none', off: 'none', disabled: 'none', minimal: 'low', min: 'low', low: 'low',
  medium: 'medium', med: 'medium', default: 'medium', auto: 'medium', normal: 'medium',
  high: 'high', xhigh: 'xhigh', 'extra-high': 'xhigh', extra_high: 'xhigh', 'x-high': 'xhigh', veryhigh: 'xhigh',
  max: 'max', maximum: 'max', ultra: 'max',
};

/** Provider spelling → canonical effort (undefined when unknown). */
export function normalizeEffort(value: unknown): Effort | undefined {
  if (typeof value !== 'string') return undefined;
  return ALIASES[value.trim().toLowerCase().replace(/\s+/g, '')];
}

/** Unique, ordered canonical efforts from provider values. */
export function normalizeEfforts(values: readonly unknown[] | undefined): Effort[] {
  const set = new Set<Effort>();
  for (const value of values ?? []) {
    const effort = normalizeEffort(value);
    if (effort) set.add(effort);
  }
  return EFFORT_ORDER.filter(effort => set.has(effort));
}

export function effortRank(effort: Effort): number {
  return EFFORT_ORDER.indexOf(effort);
}

/** Nearest supported effort (ties go up – better slightly smarter than too weak). */
export function clampEffort(wanted: Effort, supported: readonly Effort[]): Effort {
  if (supported.length === 0 || supported.includes(wanted)) return wanted; // unknown support: pass through
  const rank = effortRank(wanted);
  let best = supported[0];
  let distance = Infinity;
  for (const effort of supported) {
    const delta = effortRank(effort) - rank;
    const score = Math.abs(delta) - (delta > 0 ? 0.1 : 0);
    if (score < distance) { distance = score; best = effort; }
  }
  return best;
}

export function raiseEffort(effort: Effort, steps = 1): Effort {
  return EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, effortRank(effort) + steps)];
}
