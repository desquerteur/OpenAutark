// A text whose end must stay readable (B-044 visual pass): the code a person compares when a phone or a
// PC asks for access ("Pixel 8 wants to open Workforce · code 7871", runtime/pwa/access-todo.ts,
// runtime/remote/requests.ts) – in a narrow line the sentence's start is cut with an ellipsis, the
// " · code 7871" at its end never (styles/base.css .kept-tail). Any other text renders as it is.
// The cut is measured (B-notices fix 2): the start is shortened to what fits and ends in '…' itself, so
// the gap before the code is always the one no-break space – a CSS ellipsis leaves the rest of the box
// blank after it (up to a letter's width, a visible double gap). The fit reads the box's own layout: a
// one-line box (the band, a to-do row) cuts the start's line; a box its parent clamps to n lines (the
// phone's two-line band, mobile.css) keeps the code on the last line. The CSS ellipsis stays the fallback.
// The same measured cut for a line of parts (FittedRun, C3 D-6: a Work row's "why · chat · branch"): the
// line is shortened as a whole – the part it ends in is cut with its own '…', the parts after it are left
// out –, never one ellipsis per part, and what follows the line (the due time) keeps its one gap.
// Owns: splitting off that end, its two spans, fitting the start and fitting a run of parts. Never: writes
// or changes the text.

import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** " · code 7871" at the end of a line (a request's comparison code). */
const CODE_TAIL = /^(.*\S)(\s·\scode\s[0-9A-Za-z-]{2,12})$/;
const NBSP = ' ';

/** The text's start and the end that is never cut ('' when it has none). */
export function splitTail(text: string): [string, string] {
  const match = CODE_TAIL.exec(text);
  return match ? [match[1], match[2]] : [text, ''];
}

/** The first `length` characters of `start` ending in an ellipsis – never after a space or a separator ("Laptop ·…"). */
export function cutStart(start: string, length: number): string {
  return `${start.slice(0, Math.max(0, length)).replace(/[\s·,;:–-]+$/u, '')}…`;
}

/** True when the start shows whole: its own line is not cut and a line-clamping parent hides no line. */
function shownWhole(box: HTMLElement): boolean {
  const start = box.firstElementChild as HTMLElement | null;
  if (start && start.scrollWidth > start.clientWidth) return false;
  const host = box.parentElement;
  if (!host) return true;
  const style = getComputedStyle(host);
  const clamp = style.getPropertyValue('-webkit-line-clamp').trim();
  // a hidden line is a whole line more; the letters' own height may stick out of a tight line by a pixel or two
  return !clamp || clamp === 'none' || host.scrollHeight - host.clientHeight < (parseFloat(style.lineHeight) || 16) / 2;
}

/** The longest start that fits beside the code (cut, with '…'), or null when the whole start fits. Tries each
 *  candidate in the start's text node and puts the rendered text back before returning. */
function fittedStart(box: HTMLElement, start: string): string | null {
  const node = box.firstElementChild?.firstChild;
  if (!(node instanceof Text)) return null;
  const shown = node.data;
  const tryText = (text: string): boolean => { node.data = `${text}${NBSP}`; return shownWhole(box); };
  try {
    if (tryText(start)) return null;
    let low = 0;
    let high = start.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (tryText(cutStart(start, mid))) low = mid; else high = mid - 1;
    }
    return cutStart(start, low);
  } finally {
    node.data = shown;
  }
}

/** The text in its box: the start cut to fit (an ellipsis), the code at its end kept whole. The space between
 *  them ends the start (a no-break space, never dropped at a line end and never wrapped away from the code). */
export function KeptTail(props: { text: string }): ComponentChildren {
  const [start, end] = splitTail(props.text);
  const box = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ start: string; cut: string | null }>({ start, cut: null });
  const cut = fit.start === start ? fit.cut : null; // a fit belongs to its text (none yet for a new one)
  useLayoutEffect(() => {
    const el = box.current;
    if (!end || !el) return;
    const measure = () => {
      if (!el.isConnected) return;
      const next = fittedStart(el, start);
      setFit((now) => (now.start === start && now.cut === next ? now : { start, cut: next }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(el.parentElement ?? el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [start, end]);
  if (!end) return props.text;
  return h('span', { class: 'kept-tail', ref: box },
    h('span', { class: 'kept-tail-start' }, `${cut ?? start}${NBSP}`),
    h('span', { class: 'kept-tail-end' }, end.trimStart()));
}

// ------------------------------------------------------------------ a run of parts, shortened as a whole

/** One part of a FittedRun: a text (cut inside when the line ends in it) or a `node` (a chip) shown whole or not at all. */
export interface RunPart { key: string; text?: string; node?: ComponentChildren; class?: string }

const partLength = (part: RunPart): number => (part.node !== undefined ? 1 : (part.text ?? '').length);

/**
 * What each part shows when the line keeps its first `kept` characters (a node counts as one; null: all of it):
 * its text, its text cut with its own '…' where the line ends (cutStart), or null – left out. A line that ends
 * right before a part ends in the text part before it, with '…' after that part's whole text.
 */
export function runShown(parts: readonly RunPart[], kept: number | null): Array<string | null> {
  if (kept === null) return parts.map((part) => part.text ?? '');
  const shown: Array<string | null> = parts.map(() => null);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const length = partLength(part);
    if (offset + length <= kept) { shown[i] = part.text ?? ''; offset += length; continue; }
    const rest = kept - offset;
    if (part.node === undefined && (rest > 0 || i === 0)) shown[i] = cutStart(part.text ?? '', rest);
    else if (i > 0 && parts[i - 1].node === undefined) shown[i - 1] = cutStart(parts[i - 1].text ?? '', partLength(parts[i - 1]));
    break;
  }
  return shown;
}

/** The characters the line keeps so it fits its box (one line, its own width up to what the line has), or null when
 *  all of it fits. Tries each candidate in the rendered spans and puts their text and classes back before returning. */
function fittedRun(box: HTMLElement, parts: readonly RunPart[]): number | null {
  const spans = [...box.children] as HTMLElement[];
  if (spans.length !== parts.length) return null;
  const texts = spans.map((span, i) => (parts[i].node === undefined && span.firstChild instanceof Text ? span.firstChild : null));
  const saved = texts.map((node) => node?.data ?? '');
  const classes = spans.map((span) => span.className);
  const total = parts.reduce((sum, part) => sum + partLength(part), 0);
  const tryKept = (kept: number | null): boolean => {
    const shown = runShown(parts, kept);
    shown.forEach((text, i) => {
      spans[i].classList.toggle('fit-out', text === null);
      const node = texts[i];
      if (node && text !== null) node.data = text;
    });
    // scrollWidth and clientWidth are rounded: a line a fraction of a pixel too long would pass and get the CSS
    // ellipsis on top (a blank after it) – the last shown part's exact end decides as well
    let end = shown.length - 1;
    while (end >= 0 && shown[end] === null) end--;
    const last = spans[end];
    return box.scrollWidth <= box.clientWidth && (!last || last.getBoundingClientRect().right <= box.getBoundingClientRect().right + 0.01);
  };
  try {
    if (tryKept(null)) return null;
    let low = 0;
    let high = total - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (tryKept(mid)) low = mid; else high = mid - 1;
    }
    return low;
  } finally {
    texts.forEach((node, i) => { if (node) node.data = saved[i]; });
    spans.forEach((span, i) => { span.className = classes[i]; });
  }
}

/** Parts in one line (`class`: the line's box – one line, overflow hidden, tasks.css .meta-run): when they do not fit,
 *  the longest start that does, ending in its own '…' (runShown); the parts after it stay in the DOM with `fit-out`
 *  (hidden by the line's CSS), so the line is measured whole again when it grows. */
export function FittedRun(props: { parts: RunPart[]; class: string }): ComponentChildren {
  const { parts } = props;
  const box = useRef<HTMLSpanElement>(null);
  const key = parts.map((part) => `${part.key}:${part.node === undefined ? part.text : ''}`).join('\n');
  const [fit, setFit] = useState<{ key: string; kept: number | null }>({ key, kept: null });
  const kept = fit.key === key ? fit.kept : null; // a fit belongs to its parts (none yet for new ones)
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      if (!el.isConnected) return;
      const next = fittedRun(el, parts);
      setFit((now) => (now.key === key && now.kept === next ? now : { key, kept: next }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(el.parentElement ?? el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [key]);
  const shown = runShown(parts, kept);
  return h('span', { class: props.class, ref: box }, parts.map((part, i) => h('span', {
    key: part.key, class: [part.class, shown[i] === null ? 'fit-out' : ''].filter(Boolean).join(' ') || undefined,
  }, part.node !== undefined ? part.node : shown[i] ?? part.text)));
}
