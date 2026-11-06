// The person's own PCs watch each other's side-browser tabs (B-076): the mesh methods side.pull, side.pullPart,
// side.input and side.nav serve this PC's tabs (runtime/browser/side-view.ts) to a linked PC that passes on its owner's
// or its phone's pulls (`via`: the caller there – its frame gap and its own slot here). Only the CEO's own PCs reach
// them: they are no open methods (mesh.ts), and each call checks that the link is a CEO link, like files and secrets.
// Every param is checked again here: the input is mapped onto this PC's newest frame, never taken as DevTools commands.
// Owns: these four handlers and their link check. Never: forwards a call further, or logs what is typed.

import { WorkforceError } from '../../shared/errors.ts';
import { SIDE_PART_BYTES } from '../../shared/model/side-view.ts';
import type { RuntimeServices } from '../contracts.ts';
import { inputOf } from '../browser/input-wire.ts';
import { sideCaller, sideNavOf, sidePartOf, sidePullOf, sideTab, sideViewOf } from '../browser/side-view.ts';
import { OWNER_CALLER } from '../browser/view-pull.ts';
import { input as paramsOf, onlyKeys, type Obj } from '../rpc/params.ts';
import { DevicesRepo } from './repo.ts';
import type { PeerHandler } from './rpc-peer.ts';
import { linkOf } from './sync/home.ts';

export const SIDE_METHODS = ['side.pull', 'side.pullPart', 'side.input', 'side.nav'] as const;
const VIA = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** Throws unless `from` is one of the CEO's own PCs linked here. */
export function ceoOnly(services: Pick<RuntimeServices, 'db'>, from: string): void {
  if (linkOf(new DevicesRepo(services.db).get(from))?.kind !== 'ceo') throw new WorkforceError('forbidden', 'Only the owner\'s own PCs see the browser of this PC.');
}

/** The caller on the linked PC: its owner ('owner', the default) or its phone's device id. */
function viaOf(o: Obj): string {
  if (o.via === undefined || o.via === null) return OWNER_CALLER;
  if (typeof o.via !== 'string' || !VIA.test(o.via)) throw new WorkforceError('bad_request', 'via must be a caller id.', { details: { param: 'via' } });
  return o.via;
}

/** Registers the four methods on the mesh once at startup (compose/network.ts). */
export function registerSideView(mesh: { register(method: string, handler: PeerHandler): void }, services: () => RuntimeServices): void {
  mesh.register('side.pull', async (params, from, signal) => {
    const s = services();
    ceoOnly(s, from);
    const { o, request } = sidePullOf(params, ['via']);
    request.maxBytes = Math.min(request.maxBytes ?? SIDE_PART_BYTES, SIDE_PART_BYTES); // parts stay small on the link
    return sideViewOf(s).pull(sideCaller(from, viaOf(o)), request, signal);
  });
  mesh.register('side.pullPart', async (params, from) => {
    const s = services();
    ceoOnly(s, from);
    const { o, tab, at, index } = sidePartOf(params, ['via']);
    return sideViewOf(s).part(sideCaller(from, viaOf(o)).caller, tab, at, index);
  });
  mesh.register('side.input', async (params, from) => {
    const s = services();
    ceoOnly(s, from);
    const o = paramsOf(params);
    onlyKeys(o, ['tab', 'input']);
    await sideViewOf(s).input(sideTab(o), inputOf(o.input));
    return { ok: true };
  });
  mesh.register('side.nav', async (params, from) => {
    const s = services();
    ceoOnly(s, from);
    const o = paramsOf(params);
    onlyKeys(o, ['tab', 'url', 'action', 'dialog']);
    await sideViewOf(s).nav(sideTab(o), sideNavOf(o));
    return { ok: true };
  });
}
