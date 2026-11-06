// B-055 Q8 RPC: the person's named pointer from the UI (pointers.point) and the live pointers of a surface
// (pointers.list). Registered from rpc/handlers/browser.ts.
// Who (decisions): the owner (desktop window, local CLI) on every surface; a person of
// the organisation (F-52, their device) only on the chat browsers of chats they are an active member of –
// their pointer is drawn for everyone watching that chat browser. Phones of the owner (device scope) do not
// point. The actor is the caller: the owner as kind 'person', id 'human', with the profile name (else
// "Owner"); a person with their id and name – never a name or id the client sends.
// Throttle: at most one kept point per actor every THROTTLE_MS (~10 per second); the rest answer
// `kept: false` and are dropped. 'pointers.changed' (hub.ts) stays on topic system: owner only – people
// read pointers with pointers.list (their app hears no system events but their own notices).
// Owns: param checks, the access rule above and the throttle. Never: stores pointers (hub.ts keeps them
// in memory), or reports agents' pointers (the browser tools do).

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { parseSurface, type PointerAction, type PointerActor, type PointerPoint } from '../../shared/model/pointers.ts';
import { bad, input, num, onlyKeys, optObj, optOneOf, text } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { membership } from '../people/access.ts';
import { caller } from '../people/rpc-base.ts';
import '../contracts/pointers.ts'; // RuntimeServices.pointers

export const THROTTLE_MS = 100;
const ACTIONS: readonly PointerAction[] = ['move', 'click', 'type', 'scroll', 'select', 'drag'];
const MAX_ACTORS = 500;
const COORD = { min: -100_000, max: 100_000, integer: false };

const lastAt = new Map<string, number>();

/** A valid surface key. */
function surfaceParam(o: Record<string, unknown>): string {
  const surface = text(o, 'surface', { max: 200 });
  if (!parseSurface(surface)) bad('surface', 'a surface like chat:<chatId>/<tab>, agent:<agentId>/<tab>, side:<tab> or screen:local');
  return surface;
}

function targetParam(o: Record<string, unknown>): PointerPoint['target'] | undefined {
  const raw = optObj(o, 'target');
  if (!raw) return undefined;
  onlyKeys(raw, ['role', 'name', 'ref'], 'target');
  const role = raw.role === undefined ? undefined : text(raw, 'role', { max: 40 });
  if (role !== undefined && !/^[a-z]+$/i.test(role)) bad('target.role', 'an ARIA role');
  const name = raw.name === undefined ? undefined : text(raw, 'name', { max: 80, allowEmpty: true });
  const ref = raw.ref === undefined ? undefined : text(raw, 'ref', { max: 24 });
  if (ref !== undefined && !/^[a-z0-9]{1,24}$/i.test(ref)) bad('target.ref', 'a ref like e12');
  const target = { ...(role ? { role } : {}), ...(name ? { name } : {}), ...(ref ? { ref } : {}) };
  return Object.keys(target).length ? target : undefined;
}

/** The owner's actor (the profile name, else "Owner"). */
function ownerActor(ctx: HandlerContext): PointerActor {
  let name = '';
  try { name = ctx.services.settings.get().profile.name?.trim() ?? ''; } catch { name = ''; }
  return { kind: 'person', id: HUMAN_ID, name: name || 'Owner' };
}

/** The caller as a pointer actor, after the access rule for `surface` (see the header). */
function actorFor(ctx: HandlerContext, surface: string): PointerActor {
  const parsed = parseSurface(surface)!;
  if (ctx.scope.kind === 'person') {
    const person = caller(ctx);
    if (parsed.kind !== 'chat' || !membership(ctx.services.db, person.id, parsed.id)) {
      throw new WorkforceError('forbidden', 'You can point only in the browsers of your chats.');
    }
    return { kind: 'person', id: person.id, name: person.name };
  }
  if (ctx.scope.kind !== 'owner') throw new WorkforceError('forbidden', 'Only the person at the app points here.');
  return ownerActor(ctx);
}

/** True when `actorId` may place a point now (and notes it). */
export function admit(actorId: string, now: number): boolean {
  const last = lastAt.get(actorId);
  if (last !== undefined && now - last < THROTTLE_MS && now >= last) return false;
  lastAt.delete(actorId);
  lastAt.set(actorId, now);
  while (lastAt.size > MAX_ACTORS) lastAt.delete(lastAt.keys().next().value!);
  return true;
}

function hubOf(ctx: HandlerContext) {
  const hub = ctx.services.pointers;
  if (!hub) throw new WorkforceError('unavailable', 'Named pointers are not available in this runtime.');
  return hub;
}

function point(params: unknown, ctx: HandlerContext): { ok: true; kept: boolean } {
  const o = input(params);
  onlyKeys(o, ['surface', 'x', 'y', 'target', 'action']);
  const surface = surfaceParam(o);
  const x = num(o, 'x', COORD);
  const y = num(o, 'y', COORD);
  const target = targetParam(o);
  const action = optOneOf(o, 'action', ACTIONS);
  const actor = actorFor(ctx, surface);
  const hub = hubOf(ctx);
  if (!admit(actor.id, ctx.services.clock.now())) return { ok: true, kept: false };
  hub.point({ surface, actor, x, y, ...(target ? { target } : {}), ...(action ? { action } : {}) });
  return { ok: true, kept: true };
}

function list(params: unknown, ctx: HandlerContext) {
  const o = input(params);
  onlyKeys(o, ['surface']);
  const surface = surfaceParam(o);
  actorFor(ctx, surface);
  return { surface, points: hubOf(ctx).on(surface) };
}

export function registerPointers(table: HandlerTable): void {
  table.add('pointers.point', point);
  table.add('pointers.list', list);
  table.addPerson('pointers.point', point);
  table.addPerson('pointers.list', list);
}

/** Tests: forget the throttle. */
export function resetPointerThrottle(): void { lastAt.clear(); }
