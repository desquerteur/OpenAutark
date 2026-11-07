// AF-002: the spotlight tour's pure rules (Spotlight.tsx draws, spotlight.ts runs, spotlight-steps.ts holds the app's
// steps; tested in test/unit/ui/spotlight-model.test.ts). A step names its target by CSS selectors (the first visible
// match wins, best a `data-tour` name) and, when its target lives elsewhere, the place the tour opens first. A step whose
// target is not there – a feature another build has not got yet, another layout, an empty list – is skipped silently and
// never ends the tour; a step without selectors is shown in the middle without a spotlight. The progress counts only the
// steps that are there ("3 / 12"; the total shrinks once a step turns out missing). What the tour saved
// (settings.onboarding.tour / tourStep / hints) decides where it goes on and which first-visit hints are still due.
// Owns: these rules. Never: DOM, signals, RPC or rendering.

import type { Route } from '../lib/router.ts';
import type { Settings, TourState } from '../../shared/model/system.ts';

/** Where a step's target lives; the tour opens it before it looks for the target. */
export type TourPlace =
  | { kind: 'route'; route: Route }
  /** The Manager's first chat (its composer, send button, call button …), else any chat. */
  | { kind: 'manager-chat' }
  /** The Manager's own page on Team. */
  | { kind: 'manager-page' }
  /** The side panel on the right (the global workspace pane on a computer). */
  | { kind: 'pane' };

export interface TourStepDef {
  /** Stable id (saved as onboarding.tourStep): lower case, digits and '-'. */
  id: string;
  /** CSS selectors tried in order; the first visible element is the target. Empty: a centred step without a spotlight. */
  targets: readonly string[];
  title: string;
  /** One or two short sentences: what it is for. */
  text: string;
  place?: TourPlace;
  /** The first-visit hint this step makes unnecessary (marked as shown when the step is shown). */
  area?: string;
  /** An extra button in the bubble (spotlight.ts knows what it does). */
  extra?: { label: string; action: 'feedback-video' };
}

/** A first-visit hint: one step shown the first time an area opens. */
export interface AreaHint {
  /** The area id (onboarding.hints). */
  area: string;
  /** Which route views open this area ('pane' is the side panel, not a route). */
  views: readonly string[] | 'pane';
  /** A Settings page, when the area is one (#/settings/<page>). */
  page?: string;
  step: TourStepDef;
}

/** True when `step` has a target this window can show (`present` checks one selector list). */
export type Presence = (step: TourStepDef) => boolean;

/** A step without selectors is always shown (centred). */
export const centred = (step: TourStepDef): boolean => step.targets.length === 0;

/**
 * The next step to show from `from` in direction `dir` (+1 forward, -1 back): the first one that is centred or present
 * and not known missing. -1 when there is none (forward: the tour is through; back: stay).
 */
export function findStep(steps: readonly TourStepDef[], from: number, dir: 1 | -1, present: Presence, missing: ReadonlySet<string> = new Set()): number {
  for (let index = from + dir; index >= 0 && index < steps.length; index += dir) {
    const step = steps[index];
    if (missing.has(step.id)) continue;
    if (centred(step) || present(step)) return index;
  }
  return -1;
}

/** Is there a step before `index` the person can go back to (not known missing)? */
export function canGoBack(steps: readonly TourStepDef[], index: number, missing: ReadonlySet<string>): boolean {
  for (let at = index - 1; at >= 0; at -= 1) if (!missing.has(steps[at].id)) return true;
  return false;
}

/** "3 / 12": the position among the steps not known missing, and how many of those there are. */
export function progress(steps: readonly TourStepDef[], index: number, missing: ReadonlySet<string>): { position: number; total: number } {
  let position = 0;
  let total = 0;
  steps.forEach((step, at) => {
    if (missing.has(step.id) && at !== index) return;
    total += 1;
    if (at <= index) position += 1;
  });
  return { position: Math.max(1, position), total: Math.max(1, total) };
}

export const progressText = (value: { position: number; total: number }): string => `${value.position} / ${value.total}`;
export const progressLabel = (value: { position: number; total: number }): string => `Step ${value.position} of ${value.total}`;

/** Where a tour starts: at the saved step when it was left part way and the step still exists, else at the first. */
export function resumeIndex(steps: readonly TourStepDef[], saved: Pick<Settings['onboarding'], 'tour' | 'tourStep'> | undefined, resume: boolean): number {
  if (!resume || saved?.tour !== 'started' || !saved.tourStep) return 0;
  const index = steps.findIndex((step) => step.id === saved.tourStep);
  return index < 0 ? 0 : index;
}

/** What the tour saves: the state and the step it goes on at. */
export type TourEvent = { kind: 'step'; id: string } | { kind: 'done' } | { kind: 'skip' };

export function tourPatch(event: TourEvent): { tour: TourState; tourStep: string } {
  switch (event.kind) {
    case 'step': return { tour: 'started', tourStep: event.id };
    case 'done': return { tour: 'done', tourStep: '' };
    default: return { tour: 'skipped', tourStep: '' };
  }
}

/** The hint list with `areas` added (unchanged order, no duplicates, at most `max`); undefined when nothing is new. */
export function withHints(seen: readonly string[] | undefined, areas: readonly (string | undefined)[], max = 40): string[] | undefined {
  const list = [...(seen ?? [])];
  let changed = false;
  for (const area of areas) {
    if (!area || list.includes(area)) continue;
    list.push(area);
    changed = true;
  }
  return changed ? list.slice(-max) : undefined;
}

/**
 * The tour starts by itself only when it was left part way (the window closed during it); right after the setup
 * assistant the assistant starts it. A new or finished tour waits for "Show the tour again".
 */
export function resumeDue(onboarding: Settings['onboarding'] | undefined): boolean {
  return onboarding?.step === 'done' && onboarding.tour === 'started';
}

/**
 * First-visit hints are the light version of the tour for people who closed it (skipped) or for the areas a finished
 * tour did not reach – never during the setup assistant, never for a tour that was not offered yet ('new': installs from
 * before the tour, which know the app).
 */
export function hintsAllowed(onboarding: Settings['onboarding'] | undefined): boolean {
  return onboarding?.step === 'done' && (onboarding.tour === 'skipped' || onboarding.tour === 'done');
}

/** The hint due for the area on screen: the first whose views match and that was not shown yet. */
export function dueHint(hints: readonly AreaHint[], view: string, page: string | undefined, paneOpen: boolean, seen: readonly string[] | undefined): AreaHint | undefined {
  const shown = new Set(seen ?? []);
  return hints.find((hint) => {
    if (shown.has(hint.area)) return false;
    if (hint.views === 'pane') return paneOpen;
    if (!hint.views.includes(view)) return false;
    return hint.page === undefined || hint.page === page;
  });
}

/** The sentences of a text (for the 1–2 sentence rule). */
export const sentences = (text: string): number => (text.trim().match(/[.!?](\s|$)/g) ?? []).length;
