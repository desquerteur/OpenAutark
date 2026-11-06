// RPC handlers: a side-browser tab watched from another PC or from the phone (B-076; shared/model/side-view.ts).
// side.pull / side.pullPart (one state or frame at a time, large frames in parts), side.input (the person's mouse,
// wheel, key and text input; never logged or returned) and side.nav (address, back, forward, reload, the answer to the
// page's dialog). Without `device`, or with this PC's own id, they serve this PC's tabs (runtime/browser/side-view.ts);
// with another PC's id they go there over the link (devices.call → runtime/devices/side-view.ts, CEO links only), the
// caller passed on as `via`.
// The owner and the owner's phones on a secure transport reach them, like browser.pull.
// Owns: param checks and the choice of PC. Never: casts, maps input or decides who may watch on the other PC.

import { WorkforceError } from '../../../shared/errors.ts';
import { SIDE_PART_BYTES, type SidePull } from '../../../shared/model/side-view.ts';
import { inputOf } from '../../browser/input-wire.ts';
import { sideCaller, sideNavOf, sidePartOf, sidePullOf, sideTab, sideViewOf } from '../../browser/side-view.ts';
import { OWNER_CALLER } from '../../browser/view-pull.ts';
import { input, onlyKeys, optId, type Obj } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

/** The owner, and a device holding 'todo' on a secure transport (a phone of the owner). */
const DEVICE = { capability: 'todo', secure: true } as const;

/** The caller here: the owner, or the device's own id. */
const callerOf = (ctx: HandlerContext): string => (ctx.scope.kind === 'device' ? ctx.scope.deviceId : OWNER_CALLER);

/** The linked PC a call goes to; undefined = this PC (no device, or this PC's own id). */
export function remoteOf(o: Obj, ctx: Pick<HandlerContext, 'services'>): string | undefined {
  const device = optId(o, 'device');
  if (!device) return undefined;
  let self = '';
  try { self = ctx.services.devices.self().id; } catch { self = ''; }
  return device === self ? undefined : device;
}

/** A linked PC's pull reply, as far as the UI relies on it. */
function pullReply(value: unknown): SidePull {
  const reply = value as Partial<SidePull> | null;
  if (!reply || typeof reply !== 'object' || !reply.state || typeof reply.state.at !== 'number' || typeof reply.state.tab !== 'string') {
    throw new WorkforceError('unavailable', 'The other PC sent no picture of this tab.');
  }
  return reply as SidePull;
}

export function register(table: HandlerTable): void {
  table.add('side.pull', async (params, ctx) => {
    const { o, request } = sidePullOf(params, ['device']);
    const device = remoteOf(o, ctx);
    if (!device) return sideViewOf(ctx.services).pull(sideCaller(callerOf(ctx)), request, ctx.signal);
    const maxBytes = Math.min(request.maxBytes ?? SIDE_PART_BYTES, SIDE_PART_BYTES);
    return pullReply(await ctx.services.devices.call(device, 'side.pull', { ...request, maxBytes, via: callerOf(ctx) }, ctx.signal));
  }, DEVICE);

  table.add('side.pullPart', async (params, ctx) => {
    const { o, tab, at, index } = sidePartOf(params, ['device']);
    const device = remoteOf(o, ctx);
    if (!device) return sideViewOf(ctx.services).part(sideCaller(callerOf(ctx)).caller, tab, at, index);
    const reply = await ctx.services.devices.call(device, 'side.pullPart', { tab, at, index, via: callerOf(ctx) }, ctx.signal) as { data?: unknown } | null;
    if (typeof reply?.data !== 'string') throw new WorkforceError('not_found', 'That picture is gone. Look again.');
    return { data: reply.data };
  }, DEVICE);

  table.add('side.input', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['device', 'tab', 'input']);
    const tab = sideTab(o);
    const event = inputOf(o.input);
    const device = remoteOf(o, ctx);
    if (device) await ctx.services.devices.call(device, 'side.input', { tab, input: event }, ctx.signal);
    else await sideViewOf(ctx.services).input(tab, event);
    return { ok: true as const };
  }, DEVICE);

  table.add('side.nav', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['device', 'tab', 'url', 'action', 'dialog']);
    const tab = sideTab(o);
    const nav = sideNavOf(o);
    const device = remoteOf(o, ctx);
    if (device) await ctx.services.devices.call(device, 'side.nav', { tab, ...nav }, ctx.signal);
    else await sideViewOf(ctx.services).nav(tab, nav);
    return { ok: true as const };
  }, DEVICE);
}
