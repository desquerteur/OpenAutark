// The decision protocol's shapes (systemone.ts): the labels a choice's options travel under, the levels of a score
// question and how a level score becomes the hub's 0..1 score. A choice's `criteria` is a map label → description; a score's
// `criteria` is the array of levels, lowest first, and the answer's `score` the probability-weighted level INDEX. The hub's
// score is 0..1 (the LLM backend's scale, what the callers read), so a level score is divided by levels-1.
// Owns: these mappings. Never: HTTP, backend choice, or an option label the answer cannot map back.

import type { DecisionRequest } from '../contracts.ts';
import { NONE_OPTION } from './types.ts';

/** A score question's five steps from 0 (not at all) to 1 (fully). */
const LEVELS: readonly string[] = ['Not at all (0)', 'A little (0.25)', 'Partly (0.5)', 'Mostly (0.75)', 'Fully (1)'];
/** An option up to this long travels as its own label; a longer one as option_<n> with the text as its description. */
const MAX_LABEL_CHARS = 80;
/** The description of the always-offered "none" option. */
const NONE_DESCRIPTION = 'None of the other options fits, or it cannot be judged from the state.';

export interface OptionLabel { label: string; option: string; description: string }

/** The label, original option and description of every choice option, in order (labels unique). */
export function optionLabels(options: readonly string[]): OptionLabel[] {
  const used = new Set<string>();
  return options.map((option, index) => {
    const short = option.length <= MAX_LABEL_CHARS && !/[\r\n]/.test(option) && !used.has(option);
    let label = short ? option : `option_${index + 1}`;
    // An earlier short option may already be called "option_<n>": two options under one label would map back to the wrong one.
    for (let extra = 2; used.has(label); extra += 1) label = `option_${index + 1}_${extra}`;
    used.add(label);
    return { label, option, description: option === NONE_OPTION ? NONE_DESCRIPTION : option };
  });
}

/** The option a label names (the label itself when unknown – the hub then finds no such option). */
export function optionOf(labels: readonly OptionLabel[], label: string): string {
  return labels.find((entry) => entry.label === label)?.option ?? labels.find((entry) => entry.label.toLowerCase() === label.toLowerCase())?.option ?? label;
}

/** A score question's levels. */
export const levelsOf = (): string[] => [...LEVELS];

/** A level-index score (0..levels-1) on the hub's 0..1 scale; undefined for no number. */
export function unitScore(score: unknown, levels: number): number | undefined {
  if (typeof score !== 'number' || !Number.isFinite(score) || levels < 2) return undefined;
  return Math.max(0, Math.min(1, score / (levels - 1)));
}

/** The state a decision is made on: the request's context, never empty (a vendor may refuse an empty state). */
export function stateText(request: Pick<DecisionRequest, 'context'>): string {
  return request.context?.trim() || '(no further context)';
}

/** A finite number, else undefined. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
