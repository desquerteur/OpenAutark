// RPC handlers: the person's live view of agents' own browsers (Team › agent, a browser to-do). browser.subscribe
// holds a watch for this connection and joins it to the topic browser:<agentId> (state and frames, owner only);
// browser.unsubscribe, or the connection closing, releases it. browser.input (the person's mouse, wheel, key and
// text input on the shown tab; typed text is never logged or returned) and browser.takeover (Take over – opens a
// closed browser at `url` – and Hand back). Phones: browser.list, browser.pull / browser.pullPart (frames are pulled,
// never pushed to a device – browser/view-pull.ts), browser.navigate, browser.input and browser.takeover are open to
// 'todo' devices on a secure transport; Show window stays with the owner. Also the named pointers' RPC
// (pointers.point / pointers.list, runtime/pointers/rpc.ts).
// Owns: param checks, the per-connection watches and topics. Never: screencast, steering or input (browser/view.ts).

import type { Topic } from '../../../shared/api/protocol.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { PULL_MAX_BYTES, PULL_MIN_BYTES, PULL_WAIT_MAX_MS, type BrowserPullRequest } from '../../../shared/model/browser.ts';
import { browserViewOf } from '../../browser/view.ts';
import { inputOf, steerOf, tabOf, takeoverOf } from '../../browser/input-wire.ts';
import { OWNER_CALLER, pullsOf } from '../../browser/view-pull.ts';
import { id, input, num, obj, onlyKeys, optNum } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';
import { registerPointers } from '../../pointers/rpc.ts';

/** Browsers one connection may watch at once. */
const MAX_WATCHES = 8;
/** What devices may call: a 'todo' device on a secure transport. */
const DEVICE = { capability: 'todo', secure: true } as const;
const MAX_AT = Number.MAX_SAFE_INTEGER;

/** Watches per connection (its abort signal is the same object for every call on it). */
const connections = new WeakMap<AbortSignal, Map<string, () => void>>();

function target(params: unknown, extra: readonly string[] = []): { agentId: string; o: Record<string, unknown> } {
  const o = input(params);
  onlyKeys(o, ['agentId', ...extra]);
  return { agentId: id(o, 'agentId'), o };
}

function watchesOf(ctx: HandlerContext): Map<string, () => void> {
  let mine = connections.get(ctx.signal);
  if (!mine) {
    const created = new Map<string, () => void>();
    connections.set(ctx.signal, created);
    ctx.signal.addEventListener('abort', () => { for (const release of created.values()) release(); created.clear(); }, { once: true });
    mine = created;
  }
  return mine;
}

const topic = (agentId: string): Topic => `browser:${agentId}`;
/** The pull caller: the owner, or the device's own id. */
const callerOf = (ctx: HandlerContext): string => (ctx.scope.kind === 'device' ? ctx.scope.deviceId : OWNER_CALLER);

/** {agentId, after?: {state?, frame?}, maxBytes?, waitMs?} of browser.pull. */
function pullOf(params: unknown): BrowserPullRequest {
  const { agentId, o } = target(params, ['after', 'maxBytes', 'waitMs']);
  const request: BrowserPullRequest = { agentId };
  if (o.after !== undefined && o.after !== null) {
    const after = obj(o, 'after');
    onlyKeys(after, ['state', 'frame'], 'after');
    request.after = { state: optNum(after, 'state', { min: 0, max: MAX_AT }), frame: optNum(after, 'frame', { min: 0, max: MAX_AT }) };
  }
  request.maxBytes = optNum(o, 'maxBytes', { min: PULL_MIN_BYTES, max: PULL_MAX_BYTES });
  request.waitMs = optNum(o, 'waitMs', { min: 1000, max: PULL_WAIT_MAX_MS });
  return request;
}

export function register(table: HandlerTable): void {
  table.add('browser.list', (_params, ctx) => browserViewOf(ctx.services).list(), DEVICE);

  table.add('browser.subscribe', async (params, ctx) => {
    const { agentId } = target(params);
    const view = browserViewOf(ctx.services);
    const mine = watchesOf(ctx);
    if (!mine.has(agentId)) {
      if (mine.size >= MAX_WATCHES) throw new WorkforceError('conflict', 'Too many browser views on this connection.');
      mine.set(agentId, view.watch(agentId));
    }
    ctx.topics.add(topic(agentId));
    return await view.current(agentId);
  });

  table.add('browser.unsubscribe', (params, ctx) => {
    const { agentId } = target(params);
    const mine = watchesOf(ctx);
    mine.get(agentId)?.();
    mine.delete(agentId);
    ctx.topics.delete(topic(agentId));
    return { ok: true as const };
  });

  // Phones: one state or frame at a time; a large frame in parts.
  table.add('browser.pull', (params, ctx) => pullsOf(ctx.services).pull(callerOf(ctx), browserViewOf(ctx.services), pullOf(params), ctx.signal), DEVICE);

  table.add('browser.pullPart', (params, ctx) => {
    const { agentId, o } = target(params, ['at', 'index']);
    return pullsOf(ctx.services).part(callerOf(ctx), { agentId, at: num(o, 'at', { min: 0, max: MAX_AT }), index: num(o, 'index', { min: 0, max: 1000 }) });
  }, DEVICE);

  table.add('browser.navigate', (params, ctx) => {
    const { agentId, o } = target(params, ['tab', 'url', 'action', 'window']);
    if (ctx.scope.kind !== 'owner' && o.window !== undefined) throw new WorkforceError('bad_request', 'The window can only be shown on the PC.');
    return browserViewOf(ctx.services).steer(agentId, steerOf(o));
  }, DEVICE);

  table.add('browser.input', async (params, ctx) => {
    const { agentId, o } = target(params, ['tab', 'input']);
    await browserViewOf(ctx.services).input(agentId, tabOf(o.tab), inputOf(o.input));
    return { ok: true as const };
  }, DEVICE);

  table.add('browser.takeover', (params, ctx) => {
    const { agentId, o } = target(params, ['on', 'url', 'wake']);
    return browserViewOf(ctx.services).takeover(agentId, takeoverOf(o));
  }, DEVICE);

  registerPointers(table); // the person's named pointer
}
