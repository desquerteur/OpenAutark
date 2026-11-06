// RPC handlers: connecting PCs (Settings › Devices) – this PC's Remote ID and requests, connecting
// to another PC by Remote ID or address as the CEO or an employee, deciding requests waiting here
// (an employee's PC with the person it belongs to), and the PCs on this network.
// All owner only. Whether other PCs may ask at all is settings.devices.findable (settings.json).
// Owns: param checks. Never: request logic, or returning keys or session secrets.

import { WorkforceError } from '../../../shared/errors.ts';
import { bad, input, onlyKeys, optBool, optOneOf, optText, text } from '../params.ts';
import type { RemoteApi } from '../extras.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

function remoteOf(ctx: HandlerContext): RemoteApi {
  if (!ctx.extras.remote) throw new WorkforceError('unavailable', 'Connecting PCs is not available on this PC.');
  return ctx.extras.remote;
}

export function register(table: HandlerTable): void {
  table.add('remote.state', (_params, ctx) => remoteOf(ctx).state());
  table.add('remote.connect', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['target', 'role']);
    return remoteOf(ctx).connect({ target: text(o, 'target', { max: 200 }), role: optOneOf(o, 'role', ['ceo', 'employee'] as const) ?? 'ceo' });
  });
  table.add('remote.cancel', (_params, ctx) => { remoteOf(ctx).cancel(); return { ok: true as const }; });
  table.add('remote.decide', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'accept', 'personId']);
    const id = text(o, 'id', { max: 40 });
    if (!/^rr_[0-9a-f]{16}$/.test(id)) bad('id', 'a request id');
    const accept = optBool(o, 'accept') ?? bad('accept', 'true or false');
    const personId = optText(o, 'personId', { max: 80 });
    if (personId !== undefined && !ctx.services.people?.get(personId)) bad('personId', 'a person of the organisation');
    remoteOf(ctx).decide(id, accept, personId);
    return { ok: true as const };
  });
  table.add('remote.nearby', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['refresh']);
    return remoteOf(ctx).nearby(optBool(o, 'refresh') ?? false);
  });
}
