// B-055 Q5: the feedback tour as a pure timeline – "a little start video made of code". A script of
// beats (move, click, hold, paint, wait, show/hide, caption, chapter) is compiled once into tracks: the
// big cursor's path from the shared motion model (shared/model/pointer-motion.ts, style 'human' with
// fixed seeds, so the hand-like path is the same on every run and any moment can be sought), pressed
// spans, click ripples, on/off switches (menu, waveform, tooltip, editor, sent, end card), the
// transcript's word-by-word reveal, the paint stroke and the captions. stateAt(t) reads every track at
// one moment; the scene draws only that state, so playing, pausing and scrubbing are the same thing.
// Story: the cursor clicks the feedback cell (menu opens), clicks again (closes), presses and holds
// (slim waveform, "Listening…"), lets go (the menu opens, the words appear like a live transcript),
// points at the checked Screenshot box (tooltip), opens the picture, paints black over the e-mail and
// phone number, Done, Send ("Sent – thank you."), then the end card.
// Owns: the script, its compiled tracks and stateAt. Never: timers, DOM or the live app.

import { dwellMs, planMotion, pressMs, type MotionStep, type Point } from '../../shared/model/pointer-motion.ts';
import {
  CURSOR_START, EDITOR, EDITOR_PART, FEEDBACK_CELL, MENU, MENU_PART, PAINT_WAYPOINTS,
  abs, center, sceneToShot, shotToScene, targetAt, type TargetId,
} from './scene-layout.ts';

export type Switch = 'menu' | 'wave' | 'tooltip' | 'editor' | 'sent' | 'end';
export const SWITCHES: readonly Switch[] = ['menu', 'wave', 'tooltip', 'editor', 'sent', 'end'];

/** A switch at one moment: on or off, and how long ago it last changed (entry animations). */
export interface Toggle { on: boolean; age: number }
export interface Chapter { at: number; title: string }
export interface Caption { at: number; text: string }

export interface TourState {
  t: number;
  cursor: Point;
  pressed: boolean;
  /** A click's ring at the tip, `age` ms after the release (shown for RIPPLE_MS). */
  ripple: { x: number; y: number; age: number } | null;
  hot: TargetId | null;
  menu: Toggle; wave: Toggle; tooltip: Toggle; editor: Toggle; sent: Toggle; end: Toggle;
  /** Transcript words shown: 2.4 = two words and the third fading in. */
  words: number;
  /** Points of PAINT_PATH painted so far, and the pen's tip while it paints (shot coordinates). */
  paint: number;
  paintTip: Point | null;
  caption: string;
  chapter: number;
}

export const TRANSCRIPT = 'The calendar stays empty after I connect Google. And it would be great to drag tasks into tomorrow.';
export const WORDS = TRANSCRIPT.split(' ');
export const WORD_MS = 170;
export const RIPPLE_MS = 480;
/** The tooltip on the Screenshot box. */
export const SCREENSHOT_TIP = 'On: a screenshot of this window is included. Untick to send text only.';

const PACE = 1.3; // a little slower than a quick hand: people follow it
const PAINT_PACE = 1.7;

interface Move { start: number; end: number; from: Point; steps: MotionStep[] }

interface Script {
  moves: Move[];
  presses: Array<[number, number]>;
  clicks: Array<{ at: number; x: number; y: number }>;
  switches: Record<Switch, Array<[number, boolean]>>;
  captions: Caption[];
  chapters: Chapter[];
  reveal: number;
  paint: { start: number; end: number; steps: Array<{ t: number; shot: Point }> };
  duration: number;
}

function compile(): Script {
  const s: Script = {
    moves: [], presses: [], clicks: [], captions: [], chapters: [], reveal: 0,
    switches: { menu: [], wave: [], tooltip: [], editor: [], sent: [], end: [] },
    paint: { start: 0, end: 0, steps: [] },
    duration: 0,
  };
  let now = 0;
  let at = CURSOR_START;
  let down = 0;
  const wait = (ms: number) => { now += ms; };
  const set = (name: Switch, on: boolean, delay = 0) => { s.switches[name].push([now + delay, on]); };
  const caption = (text: string) => { s.captions.push({ at: now, text }); };
  const chapter = (title: string) => { s.chapters.push({ at: now, title }); };
  const move = (to: Point, seed: number, options: { pace?: number; drag?: boolean; size?: number } = {}) => {
    const steps = planMotion(at, to, { style: 'human', seed, pace: options.pace ?? PACE, targetSize: options.size ?? 28, correct: !options.drag });
    const end = now + (steps.at(-1)?.t ?? 0);
    s.moves.push({ start: now, end, from: at, steps });
    now = end;
    at = to;
    return steps;
  };
  const press = () => { down = now; };
  const release = () => { s.presses.push([down, now]); s.clicks.push({ at: now, ...at }); };
  /** Arrive, dwell, press and release like a hand (the press is held long enough to see). */
  const click = (seed: number, then?: () => void) => {
    wait(dwellMs('human', seed) + 60);
    press();
    wait(Math.max(110, pressMs('human', seed)));
    release();
    then?.();
  };

  chapter('The feedback button');
  wait(500);
  caption('Feedback sits top right, in every view.');
  wait(700);
  move(center(FEEDBACK_CELL), 11, { size: 32 });
  wait(250);
  click(12, () => { set('menu', true); caption('One click opens the menu.'); });
  wait(2100);
  click(13, () => { set('menu', false); caption('Another click closes it.'); });
  wait(1500);

  chapter('Hold to talk');
  caption('Press and hold to talk.');
  wait(500);
  wait(dwellMs('human', 14));
  press();
  s.clicks.push({ at: now, ...at }); // the ring shows where the hold starts
  set('wave', true, 120);
  wait(1400);
  caption('Listening… let go when you are done.');
  wait(2200);
  s.presses.push([down, now]);
  set('wave', false);
  set('menu', true);
  caption('Let go – what you said is written down.');
  s.reveal = now + 300;
  wait(700);
  move(center(abs(MENU_PART.mic, MENU)), 21);
  wait(Math.max(0, s.reveal + WORDS.length * WORD_MS - now) + 200);
  caption('Type more, or hold the mic to add more.');
  wait(2800);

  chapter('Screenshot');
  move({ x: MENU.x + MENU_PART.check.x + 8, y: MENU.y + MENU_PART.check.y + 10 }, 31, { size: 16 }); // the box itself
  set('tooltip', true, 250);
  caption('A screenshot of this window comes along.');
  wait(4600);
  set('tooltip', false);

  chapter('Paint over');
  move(center(abs(MENU_PART.thumb, MENU)), 41, { size: 60 });
  caption('Click the picture to paint over private details.');
  wait(900);
  click(42, () => set('editor', true));
  wait(600);
  caption('Paint over anything private.');
  const [first, ...rest] = PAINT_WAYPOINTS.map(shotToScene);
  move(first!, 43, { size: 20 });
  wait(300);
  press();
  s.paint.start = now;
  s.paint.steps.push({ t: now, shot: sceneToShot(at) });
  rest.forEach((point, index) => {
    const start = now;
    for (const step of move(point, 51 + index, { pace: PAINT_PACE, drag: true })) s.paint.steps.push({ t: start + step.t, shot: sceneToShot(step) });
  });
  wait(120);
  s.presses.push([down, now]);
  s.paint.end = now;
  wait(800);
  caption('Only the painted picture is sent.');
  move(center(abs(EDITOR_PART.done, EDITOR)), 61);
  click(62, () => set('editor', false));
  wait(1600);

  chapter('Send');
  caption('Then send – that’s all.');
  move(center(abs(MENU_PART.send, MENU)), 71);
  click(72, () => set('sent', true, 250));
  wait(2200);
  set('menu', false);
  wait(500);
  set('end', true);
  caption('');
  wait(2600);
  s.duration = Math.round(now);
  return s;
}

const SCRIPT = compile();

/** The whole tour in ms (≈ 40 s). */
export const DURATION = SCRIPT.duration;
export const CHAPTERS: readonly Chapter[] = SCRIPT.chapters;
export const CAPTIONS: readonly Caption[] = SCRIPT.captions;
/** The painted stroke in shot coordinates (the scene draws its first `paint` points). */
export const PAINT_PATH: readonly Point[] = SCRIPT.paint.steps.map((step) => step.shot);
/** When the paint starts and ends (ms) – tests and the window check seek there. */
export const PAINT_SPAN = { start: SCRIPT.paint.start, end: SCRIPT.paint.end } as const;
/** When a switch first turns on (ms; tests and the window check seek there). */
export function firstOn(name: Switch): number {
  return SCRIPT.switches[name].find(([, on]) => on)?.[0] ?? -1;
}

/** Index of the last entry whose `at` (or first tuple item) is ≤ t, or -1. */
function lastAtOrBefore<T>(list: readonly T[], t: number, time: (item: T) => number): number {
  let low = 0, high = list.length - 1, found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (time(list[mid]!) <= t) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

function cursorAt(t: number): Point {
  const index = lastAtOrBefore(SCRIPT.moves, t, (move) => move.start);
  if (index < 0) return CURSOR_START;
  const move = SCRIPT.moves[index]!;
  const last = move.steps.at(-1)!;
  if (t >= move.end) return { x: last.x, y: last.y };
  const local = t - move.start;
  const next = move.steps.findIndex((step) => step.t >= local);
  const b = move.steps[next]!;
  const a = next > 0 ? move.steps[next - 1]! : { ...move.from, t: 0 };
  const k = b.t === a.t ? 1 : (local - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function toggleAt(name: Switch, t: number): Toggle {
  const list = SCRIPT.switches[name];
  const index = lastAtOrBefore(list, t, (entry) => entry[0]);
  return index < 0 ? { on: false, age: t } : { on: list[index]![1], age: t - list[index]![0] };
}

export const clampTime = (t: number): number => Math.min(DURATION, Math.max(0, Number.isFinite(t) ? t : 0));

/** Everything the scene shows at `t` ms (clamped to the tour). The same t always gives the same state. */
export function stateAt(time: number): TourState {
  const t = clampTime(time);
  const cursor = cursorAt(t);
  const pressed = SCRIPT.presses.some(([from, to]) => t >= from && t < to);
  const clickIndex = lastAtOrBefore(SCRIPT.clicks, t, (click) => click.at);
  const click = clickIndex < 0 ? undefined : SCRIPT.clicks[clickIndex];
  const ripple = click && t - click.at < RIPPLE_MS ? { x: click.x, y: click.y, age: t - click.at } : null;
  const menu = toggleAt('menu', t), editor = toggleAt('editor', t);
  const painting = t >= SCRIPT.paint.start && t < SCRIPT.paint.end;
  const paint = t < SCRIPT.paint.start ? 0 : lastAtOrBefore(SCRIPT.paint.steps, t, (step) => step.t) + 1;
  const captionIndex = lastAtOrBefore(SCRIPT.captions, t, (entry) => entry.at);
  return {
    t,
    cursor,
    pressed,
    ripple,
    hot: targetAt(cursor, { menu: menu.on, editor: editor.on }),
    menu, editor,
    wave: toggleAt('wave', t), tooltip: toggleAt('tooltip', t), sent: toggleAt('sent', t), end: toggleAt('end', t),
    words: Math.min(WORDS.length, Math.max(0, (t - SCRIPT.reveal) / WORD_MS)),
    paint,
    paintTip: painting ? sceneToShot(cursor) : null,
    caption: captionIndex < 0 ? '' : SCRIPT.captions[captionIndex]!.text,
    chapter: Math.max(0, lastAtOrBefore(SCRIPT.chapters, t, (entry) => entry.at)),
  };
}
