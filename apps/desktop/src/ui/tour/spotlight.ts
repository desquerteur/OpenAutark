// AF-002: runs the spotlight tour and the first-visit hints (Spotlight.tsx draws `spot`). The tour goes through
// TOUR_STEPS (spotlight-steps.ts): for each step it first opens the step's place – a route, the Manager's chat or page,
// the side pane – then waits briefly for the target (a MutationObserver, never a timer loop); a step whose target does
// not come is skipped silently (spotlight-model.ts). Each shown step is saved (onboarding.tour 'started' and tourStep, so
// a window closed mid-tour goes on there next start), the end saves 'done', Skip or Esc 'skipped'. At the end the tour puts
// back the route it started on and closes the side pane if it opened it. Hints: the first time an area opens after the
// tour was closed or finished (hintsAllowed), one step points at it; "Got it" marks the area in onboarding.hints. Only on
// the owner's window (the setup assistant's gate), never while the setup assistant is on screen.
// Owns: the run, its place-opening and saving. Never: renders, or decides step rules (spotlight-model.ts).

import { effect, signal } from '@preact/signals';
import { formatRoute, navigate, route, type Route } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { conversations, agents, isMobile, preferences, settings, updatePreferences, updateSettings } from '../lib/store.ts';
import { managerAgent, managerFirstChat } from '../onboarding/manager.ts';
import { firstRunShown } from '../onboarding/first-run-model.ts';
import { openTour } from './open.ts';
import {
  canGoBack, dueHint, findStep, hintsAllowed, progress, resumeDue, resumeIndex, tourPatch, withHints,
  type AreaHint, type TourEvent, type TourPlace, type TourStepDef,
} from './spotlight-model.ts';
import { AREA_HINTS, TOUR_STEPS } from './spotlight-steps.ts';

/** What the overlay shows: a tour step or a hint, its target (null: centred) and the bubble's controls. */
export interface SpotView {
  mode: 'tour' | 'hint';
  step: TourStepDef;
  target: Element | null;
  position: number;
  total: number;
  canBack: boolean;
  last: boolean;
}

export const spot = signal<SpotView | null>(null);
/** True while the tour looks for its next target (the bubble waits; clicks still go nowhere). */
export const spotBusy = signal(false);

interface Run {
  steps: readonly TourStepDef[];
  index: number;
  missing: Set<string>;
  /** Later steps of the same place whose target is not on screen now: left out of the count (still tried when reached). */
  absent: Set<string>;
  origin: Route;
  /** The side pane was closed when the tour began (it closes it again at the end). */
  paneClosed: boolean;
  paneOpened: boolean;
}

let run: Run | null = null;
/** Bumped by every move: a slower move that was overtaken stops. */
let moves = 0;
let hint: AreaHint | null = null;
/** The route a shown hint belongs to (it closes, still due, when the person goes elsewhere). */
let hintRoute = '';

/** Wait after opening a place / when nothing had to open (a target may render a moment later). */
const WAIT_OPENED_MS = 1200;
const WAIT_HERE_MS = 200;

const allowed = () => can('onboarding.start');

/** The first visible element for the step's selectors (never inside the overlay itself). */
export function findTarget(selectors: readonly string[], root: ParentNode = document): Element | null {
  for (const selector of selectors) {
    let list: NodeListOf<Element>;
    try { list = root.querySelectorAll(selector); } catch { continue; }
    for (const element of list) {
      if (element.closest('.spotlight')) continue;
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden') return element;
    }
  }
  return null;
}

/** Resolves with the target once it is there, or null after `ms`. */
function waitForTarget(selectors: readonly string[], ms: number): Promise<Element | null> {
  const now = findTarget(selectors);
  if (now || typeof MutationObserver === 'undefined') return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    let frame = 0;
    const finish = (value: Element | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      resolve(value);
    };
    const check = () => { frame = 0; const found = findTarget(selectors); if (found) finish(found); };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-tour'] });
    const timer = setTimeout(() => finish(findTarget(selectors)), ms);
  });
}

const sameRoute = (a: Route, b: Route) => formatRoute(a) === formatRoute(b);

/** The route of the Manager's chat (its first chat, else any chat), or undefined. */
function managerChatRoute(): Route | undefined {
  const manager = managerAgent(agents.value);
  const chat = (manager ? managerFirstChat(conversations.value, manager.id) : undefined) ?? conversations.value[0];
  return chat ? { view: 'chat', id: chat.id } : undefined;
}

/** Opens a step's place; true when something had to change (the target may take a moment). */
function openPlace(place: TourPlace | undefined, current: Run): boolean {
  if (!place) return false;
  let next: Route | undefined;
  if (place.kind === 'route') next = place.route;
  else if (place.kind === 'manager-chat') {
    if (route.value.view === 'chat') return false; // any open chat shows the composer and its cells
    next = managerChatRoute();
  } else if (place.kind === 'manager-page') {
    const manager = managerAgent(agents.value);
    next = manager ? { view: 'team', agentId: manager.id } : undefined;
  } else {
    if (isMobile.value || preferences.value.workspaceOpen) return false;
    current.paneOpened = true;
    void updatePreferences({ workspaceOpen: true }).catch(() => undefined);
    return true;
  }
  if (!next || sameRoute(route.value, next)) return false;
  navigate(next);
  return true;
}

function save(event: TourEvent, areas: readonly (string | undefined)[] = []): void {
  const onboarding = settings.value?.onboarding;
  const hints = withHints(onboarding?.hints, areas);
  void updateSettings({ onboarding: { ...tourPatch(event), ...(hints ? { hints } : {}) } }).catch(() => undefined);
}

/** The later steps that open the same place (or none) and whose target is not there now: out of the count, so it does not shrink later. */
function probeAhead(current: Run, index: number): void {
  const here = JSON.stringify(current.steps[index].place ?? null);
  current.absent.clear();
  current.steps.forEach((step, at) => {
    if (at <= index || !step.targets.length || current.missing.has(step.id)) return;
    const place = JSON.stringify(step.place ?? null);
    if ((place === here || !step.place) && !findTarget(step.targets)) current.absent.add(step.id);
  });
}

function show(current: Run, index: number, target: Element | null): void {
  current.index = index;
  const step = current.steps[index];
  probeAhead(current, index);
  const { position, total } = progress(current.steps, index, new Set([...current.missing, ...current.absent]));
  const last = findStep(current.steps, index, 1, () => true, current.missing) < 0;
  spot.value = { mode: 'tour', step, target, position, total, canBack: canGoBack(current.steps, index, current.missing), last };
  save({ kind: 'step', id: step.id }, [step.area]);
}

/** Goes from `start` (inclusive) in `dir` to the first step that can be shown; past the last step the tour is done. */
async function moveFrom(start: number, dir: 1 | -1): Promise<void> {
  const current = run;
  if (!current) return;
  const move = ++moves;
  spotBusy.value = true;
  try {
    for (let index = start; index >= 0 && index < current.steps.length; index += dir) {
      const step = current.steps[index];
      if (current.missing.has(step.id)) continue;
      if (!step.targets.length) { show(current, index, null); return; }
      const opened = openPlace(step.place, current);
      const target = await waitForTarget(step.targets, opened ? WAIT_OPENED_MS : WAIT_HERE_MS);
      if (move !== moves || run !== current) return; // overtaken (another click, closed)
      if (target) { show(current, index, target); return; }
      current.missing.add(step.id);
    }
    if (dir === 1) endTour('done');
    else if (spot.value) spot.value = { ...spot.value, canBack: false }; // nothing before: stay
  } finally {
    if (move === moves) spotBusy.value = false;
  }
}

/** Starts the app tour (from the first step, or where it was left when `resume`). */
export function startTour(options: { resume?: boolean } = {}): void {
  if (!allowed()) return;
  if (hint) closeHint(false);
  const onboarding = settings.value?.onboarding;
  run = {
    steps: TOUR_STEPS, index: 0, missing: new Set(), absent: new Set(), origin: route.value,
    paneClosed: !preferences.value.workspaceOpen, paneOpened: false,
  };
  void moveFrom(resumeIndex(TOUR_STEPS, onboarding, options.resume === true), 1);
}

export function tourNext(): void {
  if (run) void moveFrom(run.index + 1, 1);
  else if (hint) closeHint(true);
}

export function tourBack(): void {
  if (!run) return;
  const before = findStep(run.steps, run.index, -1, () => true, run.missing);
  if (before >= 0) void moveFrom(before, -1);
}

/** Skip / Esc: the tour closes and counts as skipped (a hint counts as seen). */
export function tourSkip(): void {
  if (run) endTour('skip');
  else if (hint) closeHint(true);
}

function endTour(kind: 'done' | 'skip'): void {
  const current = run;
  if (!current) return;
  run = null;
  moves += 1;
  spotBusy.value = false;
  spot.value = null;
  if (current.paneOpened && current.paneClosed) void updatePreferences({ workspaceOpen: false }).catch(() => undefined);
  if (!sameRoute(route.value, current.origin)) navigate(current.origin);
  // The areas of the shown steps were saved as they showed. Skipped: the hint of the place the person goes back to does
  // not pop up a moment later – hints wait for the next area they open.
  save({ kind }, kind === 'skip' ? [hintArea(current.origin)] : []);
}

/** The first-visit hint's area for a route (the side pane aside), or undefined. */
function hintArea(at: Route): string | undefined {
  const page = at.view === 'settings' ? at.section ?? 'general' : undefined;
  return dueHint(AREA_HINTS, at.view, page, false, [])?.area;
}

/** The bubble's extra button. */
export function tourExtra(action: NonNullable<TourStepDef['extra']>['action']): void {
  if (action === 'feedback-video') openTour(); // the feedback video opens over the tour; closing it returns here
}

// ── First-visit hints ──

function closeHint(seen: boolean): void {
  const current = hint;
  hint = null;
  spot.value = null;
  if (seen && current) {
    const hints = withHints(settings.value?.onboarding.hints, [current.area]);
    if (hints) void updateSettings({ onboarding: { hints } }).catch(() => undefined);
  }
}

/** The settings page of a route ('general' for the bare settings route), else undefined. */
const pageOf = (at: Route): string | undefined => (at.view === 'settings' ? at.section ?? 'general' : undefined);

/** `due`'s area is on screen now (the route and the side pane as they are). */
function onScreen(due: AreaHint): boolean {
  return dueHint([due], route.value.view, pageOf(route.value), preferences.value.workspaceOpen && !isMobile.value, []) !== undefined;
}

/** Something else has the person's attention: another dialog, a menu or a popover is open (a hint never covers it). */
const busyElsewhere = (): boolean => document.querySelector('dialog[open]:not(.spotlight), [role="menu"], .popover') !== null;

async function showHint(due: AreaHint): Promise<void> {
  const target = await waitForTarget(due.step.targets, 1000);
  // not there (another layout), or the person moved on meanwhile: it stays due for a later visit
  if (!target || !target.isConnected || !onScreen(due) || run || hint || spot.value || busyElsewhere()) return;
  hint = due;
  hintRoute = formatRoute(route.value);
  spot.value = { mode: 'hint', step: due.step, target, position: 1, total: 1, canBack: false, last: true };
}

/** "Show the tour" in a hint: the hint counts as seen and the whole tour starts. */
export function hintToTour(): void {
  closeHint(true);
  startTour();
}

/**
 * Watches the route, the side pane and the saved state: resumes a tour left part way, and offers an area's hint once
 * that area is on screen for a moment. Returns the cleanup.
 */
export function watchSpotlight(): () => void {
  let resumed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = effect(() => {
    const value = settings.value;
    const view = route.value;
    const paneOpen = preferences.value.workspaceOpen && !isMobile.value;
    const shown = spot.value;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (hint && (formatRoute(view) !== hintRoute || !onScreen(hint))) { closeHint(false); return; } // its place went: due again next time
    if (!value || !allowed() || firstRunShown(value, true, false)) return;
    if (!resumed && resumeDue(value.onboarding) && !run) {
      resumed = true;
      timer = setTimeout(() => startTour({ resume: true }), 400);
      return;
    }
    if (shown || run || !hintsAllowed(value.onboarding)) return;
    const page = view.view === 'settings' ? view.section ?? 'general' : undefined;
    const due = dueHint(AREA_HINTS, view.view, page, paneOpen, value.onboarding.hints);
    if (due) timer = setTimeout(() => void showHint(due), 700);
  });
  return () => { stop(); if (timer) clearTimeout(timer); };
}
