// Every field of a side-browser call checked before the driver touches a tab – types, lengths, the tab id pattern,
// refs, step shapes – with one sentence for the agent when one is wrong.
// Owns: the checks and their limits. Never: talks to a page (pure).

import { SIDE_STEPS_MAX, SIDE_WAIT_MAX_MS, type SideActStep, type SideBrowserCall, type SideStepAction } from '../../shared/model/side-browser.ts';
import { isMotionStyle, type MotionStyle } from '../../shared/model/pointer-motion.ts';
import { isSpace } from '../../shared/api/workspace-browser.ts';

export const TAB_ID = /^web-[a-zA-Z0-9-]{1,80}$/;
export const REF = /^s\d{1,12}$/;
const ACTIONS = ['tabs', 'open', 'close', 'snapshot', 'find', 'act', 'screenshot', 'text', 'console', 'network', 'eval', 'wait'];
const STEPS: readonly SideStepAction[] = ['click', 'double_click', 'right_click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck',
  'scroll', 'scroll_into_view', 'back', 'forward', 'reload'];
const POINT = ['click', 'double_click', 'right_click', 'hover'];
const NEEDS_REF = ['fill', 'select', 'check', 'uncheck', 'scroll_into_view'];
const COORD_MAX = 100_000;

type Fields = Record<string, unknown>;

class Invalid extends Error {}
const fail = (message: string): never => { throw new Invalid(message); };

const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, name: string, max: number, options: { min?: number } = {}): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${name} must be text.`);
  const str = value as string;
  if (str.length < (options.min ?? 0)) fail(`${name} is empty.`);
  if (str.length > max) fail(`${name} is longer than ${max} characters.`);
  return str;
}

function num(value: unknown, name: string, min: number, max: number, int = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || (int && !Number.isInteger(value))) fail(`${name} must be ${int ? 'a whole number' : 'a number'}.`);
  const n = value as number;
  if (n < min || n > max) fail(`${name} must be between ${min} and ${max}.`);
  return n;
}

function bool(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(`${name} must be true or false.`);
  return value as boolean;
}

function step(value: unknown, index: number): SideActStep {
  const at = `Step ${index + 1}`;
  if (!isObject(value)) return fail(`${at} must be an object.`);
  const action = value.action as SideStepAction;
  if (!STEPS.includes(action)) fail(`${at}: unknown action ${JSON.stringify(String(value.action)).slice(0, 40)} (use ${STEPS.join(', ')}).`);
  const out: SideActStep = { action };
  const ref = text(value.ref, `${at} ref`, 14);
  if (ref !== undefined) {
    if (!REF.test(ref)) fail(`${at}: ref ${JSON.stringify(ref)} is not a side-browser ref (they look like s123 – take a snapshot or use find).`);
    out.ref = ref;
  }
  const x = num(value.x, `${at} x`, 0, COORD_MAX);
  const y = num(value.y, `${at} y`, 0, COORD_MAX);
  if ((x === undefined) !== (y === undefined)) fail(`${at}: give both x and y.`);
  if (x !== undefined && y !== undefined) { out.x = x; out.y = y; }
  const val = text(value.value, `${at} value`, 20_000);
  if (val !== undefined) out.value = val;
  if (value.values !== undefined) {
    if (!Array.isArray(value.values) || value.values.length > 50) fail(`${at} values must be a list of up to 50 texts.`);
    out.values = (value.values as unknown[]).map((item, n) => text(item, `${at} values[${n}]`, 500)!);
  }
  const key = text(value.key, `${at} key`, 40, { min: 1 });
  if (key !== undefined) out.key = key;
  const dx = num(value.dx, `${at} dx`, -COORD_MAX, COORD_MAX);
  const dy = num(value.dy, `${at} dy`, -COORD_MAX, COORD_MAX);
  if (dx !== undefined) out.dx = dx;
  if (dy !== undefined) out.dy = dy;
  if (POINT.includes(action) && !out.ref && out.x === undefined) fail(`${at}: ${action} needs a ref or x and y.`);
  if (NEEDS_REF.includes(action) && !out.ref) fail(`${at}: ${action} needs a ref.`);
  if (action === 'fill' && out.value === undefined) fail(`${at}: fill needs a value ('' empties the field).`);
  if (action === 'type' && !out.value) fail(`${at}: type needs a value.`);
  if (action === 'press' && !out.key) fail(`${at}: press needs a key (for example Enter, Tab, Escape, ArrowDown, Control+A).`);
  if (action === 'select' && out.value === undefined && !out.values?.length) fail(`${at}: select needs a value or values.`);
  return out;
}

/** The call checked field by field, or the sentence why not. */
export function checkCall(raw: unknown): { call: SideBrowserCall } | { error: string } {
  try {
    if (!isObject(raw)) fail('The call must be an object.');
    const value = raw as Fields;
    const action = value.action as SideBrowserCall['action'];
    if (!ACTIONS.includes(action)) fail(`Unknown side-browser action (use ${ACTIONS.join(', ')}).`);
    if (!isObject(value.agent)) fail('The call names no agent.');
    const agent = value.agent as Fields;
    const id = text(agent.id, 'agent.id', 120, { min: 1 }) ?? fail('agent.id must be text.');
    if (!/^[\w.:-]+$/.test(id)) fail('agent.id has characters an id never has.');
    const name = (text(agent.name, 'agent.name', 120, { min: 1 }) ?? fail('agent.name must be text.')).replace(/\s+/g, ' ').trim();
    if (!name) fail('agent.name is empty.');
    const call: SideBrowserCall = { action, agent: { id, name } };
    const tab = text(value.tab, 'tab', 84);
    if (tab !== undefined) { if (!TAB_ID.test(tab)) fail(`There is no side-browser tab ${JSON.stringify(tab)} – list the tabs (action tabs).`); call.tab = tab; }
    const space = text(value.space, 'space', 140);
    if (space !== undefined) { if (!isSpace(space)) fail(`There is no browser space ${JSON.stringify(space).slice(0, 80)} (global, chat:<id> or agent:<id>).`); call.space = space; }
    const url = text(value.url, 'url', 8192, { min: 1 });
    if (url !== undefined) call.url = url;
    const newTab = bool(value.newTab, 'newTab');
    if (newTab !== undefined) call.newTab = newTab;
    const show = bool(value.show, 'show');
    if (show !== undefined) call.show = show;
    const chat = text(value.chat, 'chat', 128, { min: 1 });
    if (chat !== undefined) call.chat = chat;
    const query = text(value.query, 'query', 200, { min: 1 });
    if (query !== undefined) call.query = query;
    const full = bool(value.full, 'full');
    if (full !== undefined) call.full = full;
    const expression = text(value.expression, 'expression', 20_000, { min: 1 });
    if (expression !== undefined) call.expression = expression;
    const pattern = text(value.pattern, 'pattern', 200);
    if (pattern) call.pattern = pattern;
    const errorsOnly = bool(value.errorsOnly, 'errorsOnly');
    if (errorsOnly !== undefined) call.errorsOnly = errorsOnly;
    const limit = num(value.limit, 'limit', 1, 300, true);
    if (limit !== undefined) call.limit = limit;
    const requestId = text(value.requestId, 'requestId', 120, { min: 1 });
    if (requestId !== undefined) { if (!/^[\w.~-]+$/.test(requestId)) fail('requestId is not a request id from the network list.'); call.requestId = requestId; }
    if (value.motion !== undefined) { if (!isMotionStyle(value.motion)) fail('motion must be instant, glide or human.'); call.motion = value.motion as MotionStyle; }
    const maxEdge = num(value.maxEdge, 'maxEdge', 64, 4096, true);
    if (maxEdge !== undefined) call.maxEdge = maxEdge;
    if (value.region !== undefined) {
      if (!isObject(value.region)) fail('region must be an object with x, y, width and height.');
      const r = value.region as Fields;
      call.region = { x: num(r.x, 'region.x', 0, COORD_MAX) ?? fail('region.x is missing.'), y: num(r.y, 'region.y', 0, COORD_MAX) ?? fail('region.y is missing.'),
        width: num(r.width, 'region.width', 1, COORD_MAX) ?? fail('region.width is missing.'), height: num(r.height, 'region.height', 1, COORD_MAX) ?? fail('region.height is missing.') };
    }
    if (value.wait !== undefined) {
      if (!isObject(value.wait)) fail('wait must be an object (text, url, change, idle, timeoutMs).');
      const w = value.wait as Fields;
      const waitFor: NonNullable<SideBrowserCall['wait']> = {};
      const wText = text(w.text, 'wait.text', 500, { min: 1 }); if (wText !== undefined) waitFor.text = wText;
      const wUrl = text(w.url, 'wait.url', 2048, { min: 1 }); if (wUrl !== undefined) waitFor.url = wUrl;
      const change = bool(w.change, 'wait.change'); if (change !== undefined) waitFor.change = change;
      const idle = bool(w.idle, 'wait.idle'); if (idle !== undefined) waitFor.idle = idle;
      const timeoutMs = num(w.timeoutMs, 'wait.timeoutMs', 0, SIDE_WAIT_MAX_MS, true); if (timeoutMs !== undefined) waitFor.timeoutMs = timeoutMs;
      call.wait = waitFor;
    }
    if (value.steps !== undefined) {
      if (!Array.isArray(value.steps)) fail('steps must be a list.');
      const steps = value.steps as unknown[];
      if (steps.length > SIDE_STEPS_MAX) fail(`At most ${SIDE_STEPS_MAX} steps per call.`);
      call.steps = steps.map(step);
    }
    // What each action needs.
    if (action === 'open' && !call.url) fail('open needs a url.');
    if (action === 'close' && !call.tab) fail('close needs the tab to close.');
    if (action === 'find' && !call.query) fail('find needs a query (words of the role, name or value).');
    if (action === 'act' && !call.steps?.length) fail('act needs at least one step.');
    if (action === 'eval' && !call.expression) fail('eval needs an expression.');
    if (action === 'wait' && !(call.wait && (call.wait.text || call.wait.url || call.wait.change || call.wait.idle))) fail('wait needs text, url, change or idle.');
    return { call };
  } catch (error) {
    if (error instanceof Invalid) return { error: error.message };
    throw error;
  }
}
