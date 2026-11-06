// One act step in a side tab, done like a person would: the ref is resolved to its node,
// scrolled into view, and the mouse travels to the node's center along the shared motion model
// (pointer-motion.ts) as real mouseMoved events at their times – hover effects included – before it
// presses and releases. fill = focus + select all + insertText; select/check work on the node itself
// (with input/change events); scroll is a wheel at a point; back/forward/reload use the tab's history.
// Every failure is one sentence for the agent (a stale ref asks for a new snapshot).
// Owns: the step mechanics. Never: decides whether a step may run (driver.ts keeps the person-first rule).

import type { SideActStep } from '../../shared/model/side-browser.ts';
import { dwellMs, planMotion, pressMs, type MotionStep, type MotionStyle, type Point } from '../../shared/model/pointer-motion.ts';
import type { PointerAction } from '../../shared/model/pointers.ts';
import { SideError } from './cdp.ts';
import { dialogAnswer, keyEvents, parseKey } from './keys.ts';
import type { SideTab } from './tab.ts';

export interface StepContext {
  tab: SideTab;
  agentId: string;
  style: MotionStyle;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The agent's cursor moves (overlay + pointer report) – before the mouse events run. */
  moved(path: MotionStep[], action: PointerAction, ref?: string): void;
}

const GROUP = 'wf-side-step';
const stale = (ref: string) => new SideError(`The element ${ref} is not on the page any more – take a new snapshot.`);

interface Node { objectId: string; backendNodeId: number }

async function resolve(ctx: StepContext, ref: string): Promise<Node> {
  const backendNodeId = Number(ref.slice(1));
  let objectId: string | undefined;
  try {
    const out = await ctx.tab.cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: await ctx.tab.cdp.world(), objectGroup: GROUP }) as { object?: { objectId?: string } };
    objectId = out.object?.objectId;
  } catch (error) {
    if (error instanceof SideError) throw error;
    throw stale(ref);
  }
  if (!objectId || !(await ctx.tab.cdp.callOn<boolean>(objectId, 'function () { return this.isConnected; }'))) throw stale(ref);
  return { objectId, backendNodeId };
}

async function viewport(ctx: StepContext): Promise<{ width: number; height: number }> {
  const m = await ctx.tab.cdp.send('Page.getLayoutMetrics') as { cssVisualViewport?: { clientWidth: number; clientHeight: number }; cssLayoutViewport?: { clientWidth: number; clientHeight: number } };
  const v = m.cssVisualViewport ?? m.cssLayoutViewport ?? { clientWidth: 0, clientHeight: 0 };
  return { width: v.clientWidth, height: v.clientHeight };
}

/** The node's visible center (scrolled into view first), with its smaller side for the motion; null when it has no box. */
async function center(ctx: StepContext, node: Node): Promise<{ x: number; y: number; size: number } | null> {
  const cdp = ctx.tab.cdp;
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }).catch(() =>
    cdp.callOn(node.objectId, 'function () { const el = this.nodeType === 1 ? this : this.parentElement; if (el) el.scrollIntoView({ block: "center", inline: "center" }); }').catch(() => {}));
  const out = await cdp.send('DOM.getContentQuads', { backendNodeId: node.backendNodeId }).catch(() => ({ quads: [] })) as { quads?: number[][] };
  const view = await viewport(ctx);
  let best: { x: number; y: number; size: number } | null = null;
  for (const q of out.quads ?? []) {
    if (q.length < 8) continue;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!], ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    const width = Math.max(...xs) - Math.min(...xs), height = Math.max(...ys) - Math.min(...ys);
    if (width < 1 || height < 1) continue;
    // The part of the quad inside the viewport, its middle.
    const left = Math.max(0, Math.min(...xs)), right = Math.min(view.width || Infinity, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys)), bottom = Math.min(view.height || Infinity, Math.max(...ys));
    if (right - left < 1 || bottom - top < 1) { best ??= { x: (xs[0]! + xs[2]!) / 2, y: (ys[0]! + ys[2]!) / 2, size: Math.min(width, height) }; continue; }
    return { x: (left + right) / 2, y: (top + bottom) / 2, size: Math.min(width, height) };
  }
  return best;
}

async function mouse(ctx: StepContext, params: Record<string, unknown>): Promise<void> {
  ctx.tab.agentPoint(params.x as number, params.y as number);
  await ctx.tab.cdp.send('Input.dispatchMouseEvent', { pointerType: 'mouse', ...params });
}

/** The pointer glides (or jumps) from the agent's last position to `to`, as real mouse moves at their times. */
async function moveTo(ctx: StepContext, to: Point, size: number, action: PointerAction, ref?: string): Promise<void> {
  let from: Point | undefined = ctx.tab.cursors.get(ctx.agentId);
  if (!from) { const view = await viewport(ctx); from = { x: view.width * 0.62, y: view.height * 0.58 }; } // a first move comes from inside the page
  const path = planMotion(from, to, { style: ctx.style, targetSize: Math.max(4, size) });
  ctx.moved(path, action, ref);
  const start = ctx.now();
  for (const step of path) {
    const wait = start + step.t - ctx.now();
    if (wait > 0) await ctx.sleep(wait);
    await mouse(ctx, { type: 'mouseMoved', x: step.x, y: step.y, button: 'none', buttons: 0 });
  }
  ctx.tab.cursors.set(ctx.agentId, { x: to.x, y: to.y });
}

async function target(ctx: StepContext, step: SideActStep, action: PointerAction): Promise<{ point: Point; node?: Node }> {
  if (step.ref) {
    const node = await resolve(ctx, step.ref);
    const box = await center(ctx, node);
    if (!box) throw new SideError(`The element ${step.ref} is not visible on the page (it has no size there).`);
    await moveTo(ctx, box, box.size, action, step.ref);
    return { point: box, node };
  }
  const view = await viewport(ctx);
  if (step.x! > view.width || step.y! > view.height) throw new SideError(`The point ${Math.round(step.x!)},${Math.round(step.y!)} is outside the visible page (${Math.round(view.width)}×${Math.round(view.height)}).`);
  const point = { x: step.x!, y: step.y! };
  await moveTo(ctx, point, 24, action);
  return { point };
}

async function click(ctx: StepContext, point: Point, button: 'left' | 'right', count: 1 | 2): Promise<void> {
  const dwell = dwellMs(ctx.style, Math.round(point.x + point.y));
  if (dwell) await ctx.sleep(dwell);
  const buttons = button === 'left' ? 1 : 2;
  for (let n = 1; n <= count; n += 1) {
    await mouse(ctx, { type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: n });
    const hold = pressMs(ctx.style, Math.round(point.x * 3 + point.y + n));
    if (hold) await ctx.sleep(hold);
    await mouse(ctx, { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: n });
    if (n < count && ctx.style !== 'instant') await ctx.sleep(60);
  }
}

const EDITABLE = `function () {
  const t = this, tag = t.tagName;
  const editable = (tag === 'INPUT' && !/^(checkbox|radio|submit|button|reset|image|file|range|color|hidden)$/i.test(t.type)) || tag === 'TEXTAREA' || t.isContentEditable === true;
  return { editable, disabled: Boolean(t.disabled), readonly: Boolean(t.readOnly), direct: tag === 'INPUT' && /^(date|time|datetime-local|month|week)$/i.test(t.type) };
}`;
const SELECT_ALL = `function () {
  if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
  try { this.select(); } catch { try { this.setSelectionRange(0, String(this.value || '').length); } catch {} }
}`;
const SET_VALUE = `function (v) { this.value = v; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value === v; }`;
const SELECT = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { error: 'not-select' };
  if (this.disabled) return { error: 'disabled' };
  const low = wanted.map((w) => w.trim().toLowerCase());
  const hit = (o) => wanted.includes(o.value) || low.includes(o.label.trim().toLowerCase()) || low.includes((o.textContent || '').trim().toLowerCase());
  const picked = [];
  for (const o of this.options) {
    const yes = hit(o) && !o.disabled && (this.multiple || picked.length === 0);
    if (this.multiple || yes) o.selected = yes;
    if (yes) picked.push(o.label || o.value);
  }
  if (!picked.length) return { error: 'no-option', options: [...this.options].slice(0, 15).map((o) => o.label || o.value) };
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { picked };
}`;
const CHECK = `function (want) {
  const el = this, native = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
  const role = el.getAttribute && el.getAttribute('role');
  if (!native && !['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role)) return { error: 'not-checkbox' };
  const state = () => (native ? el.checked : el.getAttribute('aria-checked') === 'true');
  if (native ? el.disabled : el.getAttribute('aria-disabled') === 'true') return { error: 'disabled' };
  if (state() === want) return { ok: true };
  if (native && el.type === 'radio' && !want) return { error: 'radio' };
  if (!native) return { click: true };
  el.click();
  return { ok: state() === want };
}`;

/** Focuses a text field (the pointer goes there first). `direct`: a date/time field, which takes its value set, not typed. */
async function focus(ctx: StepContext, ref: string): Promise<{ node: Node; direct: boolean }> {
  const node = await resolve(ctx, ref);
  const info = await ctx.tab.cdp.callOn<{ editable: boolean; disabled: boolean; readonly: boolean; direct: boolean }>(node.objectId, EDITABLE);
  if (!info.editable) throw new SideError(`The element ${ref} is not a text field – click it, or use select or check.`);
  if (info.disabled || info.readonly) throw new SideError(`The text field ${ref} is ${info.disabled ? 'disabled' : 'read-only'}.`);
  const box = await center(ctx, node);
  if (box) await moveTo(ctx, box, box.size, 'type', ref);
  await ctx.tab.cdp.send('DOM.focus', { backendNodeId: node.backendNodeId });
  return { node, direct: info.direct };
}

async function press(ctx: StepContext, key: string): Promise<void> {
  const plan = parseKey(key);
  if (!plan) throw new SideError(`Unknown key ${JSON.stringify(key)} (use names like Enter, Tab, Escape, ArrowDown, Backspace, Control+A, or one character).`);
  const tab = ctx.tab;
  if (tab.dialog) {
    const accept = dialogAnswer(plan);
    if (accept === undefined) throw new SideError(`A ${tab.dialog.type} dialog is open – press Enter to accept or Escape to dismiss it.`);
    await tab.cdp.send('Page.handleJavaScriptDialog', { accept });
    tab.dialog = undefined;
    return;
  }
  for (const event of keyEvents(plan)) { tab.agentKey(); await tab.cdp.send('Input.dispatchKeyEvent', event); }
}

async function history(ctx: StepContext, delta: -1 | 1): Promise<void> {
  const h = await ctx.tab.cdp.send('Page.getNavigationHistory') as { currentIndex: number; entries: Array<{ id: number }> };
  const entry = h.entries[h.currentIndex + delta];
  if (!entry) throw new SideError(delta < 0 ? 'There is no page to go back to.' : 'There is no page to go forward to.');
  await ctx.tab.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id });
}

/** Runs one step; throws SideError with the sentence when it cannot. */
export async function runStep(ctx: StepContext, step: SideActStep): Promise<void> {
  const tab = ctx.tab;
  if (tab.dialog && step.action !== 'press') throw new SideError(`A ${tab.dialog.type} dialog is open (${JSON.stringify(tab.dialog.message).slice(0, 120)}) – press Enter to accept or Escape to dismiss it.`);
  const cdp = tab.cdp;
  switch (step.action) {
    case 'click': case 'double_click': case 'right_click': {
      const { point } = await target(ctx, step, 'click');
      await click(ctx, point, step.action === 'right_click' ? 'right' : 'left', step.action === 'double_click' ? 2 : 1);
      return;
    }
    case 'hover': await target(ctx, step, 'move'); return;
    case 'fill': {
      const { node, direct } = await focus(ctx, step.ref!);
      if (direct) {
        if (!(await cdp.callOn<boolean>(node.objectId, SET_VALUE, [step.value ?? '']))) throw new SideError(`The field ${step.ref} did not take the value ${JSON.stringify(step.value).slice(0, 60)}.`);
        return;
      }
      await cdp.callOn(node.objectId, SELECT_ALL);
      tab.agentKey();
      if (step.value) await cdp.send('Input.insertText', { text: step.value });
      else await press(ctx, 'Delete');
      return;
    }
    case 'type':
      if (step.ref) await focus(ctx, step.ref);
      tab.agentKey();
      await cdp.send('Input.insertText', { text: step.value ?? '' });
      return;
    case 'press':
      if (step.ref && !tab.dialog) { const node = await resolve(ctx, step.ref); await cdp.send('DOM.focus', { backendNodeId: node.backendNodeId }).catch(() => {}); }
      await press(ctx, step.key!);
      return;
    case 'select': {
      const node = await resolve(ctx, step.ref!);
      const box = await center(ctx, node);
      if (box) await moveTo(ctx, box, box.size, 'select', step.ref);
      const out = await cdp.callOn<{ error?: string; options?: string[]; picked?: string[] }>(node.objectId, SELECT, [step.values?.length ? step.values : [step.value ?? '']]);
      if (out.error === 'not-select') throw new SideError(`The element ${step.ref} is not a list box – click it, then click the option.`);
      if (out.error === 'disabled') throw new SideError(`The list box ${step.ref} is disabled.`);
      if (out.error) throw new SideError(`No option matches ${JSON.stringify(step.values ?? step.value).slice(0, 80)}${out.options?.length ? ` (options: ${out.options.map((o) => JSON.stringify(o)).join(', ').slice(0, 300)})` : ''}.`);
      return;
    }
    case 'check': case 'uncheck': {
      const want = step.action === 'check';
      const node = await resolve(ctx, step.ref!);
      const box = await center(ctx, node);
      if (box) await moveTo(ctx, box, box.size, 'click', step.ref);
      const out = await cdp.callOn<{ error?: string; ok?: boolean; click?: boolean }>(node.objectId, CHECK, [want]);
      if (out.error === 'not-checkbox') throw new SideError(`The element ${step.ref} is not a checkbox, switch or radio button – click it instead.`);
      if (out.error === 'disabled') throw new SideError(`The element ${step.ref} is disabled.`);
      if (out.error === 'radio') throw new SideError(`A radio button cannot be unchecked – check another one of its group.`);
      if (out.click) {
        if (!box) throw new SideError(`The element ${step.ref} is not visible on the page (it has no size there).`);
        await click(ctx, box, 'left', 1);
      } else if (!out.ok) throw new SideError(`The element ${step.ref} did not change to ${want ? 'checked' : 'unchecked'}.`);
      return;
    }
    case 'scroll': {
      const view = await viewport(ctx);
      const at = step.ref || step.x !== undefined ? (await target(ctx, step, 'scroll')).point : { x: view.width / 2, y: view.height / 2 };
      if (!step.ref && step.x === undefined) await moveTo(ctx, at, 200, 'scroll');
      await mouse(ctx, { type: 'mouseWheel', x: at.x, y: at.y, deltaX: step.dx ?? 0, deltaY: step.dy ?? Math.round((view.height || 600) * 0.8) });
      await ctx.sleep(250); // smooth scrolling settles
      return;
    }
    case 'scroll_into_view': { const node = await resolve(ctx, step.ref!); if (!(await center(ctx, node))) throw new SideError(`The element ${step.ref} is not visible on the page (it has no size there).`); return; }
    case 'back': await history(ctx, -1); return;
    case 'forward': await history(ctx, 1); return;
    case 'reload': await cdp.send('Page.reload', {}); return;
  }
}

/** Lets go of the nodes a call resolved. */
export function release(tab: SideTab): void {
  void tab.cdp.send('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
}
