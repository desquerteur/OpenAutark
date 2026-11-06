// RPC handler: the meeting server – its state (off, connecting, connected, error; linked PCs
// online there and linked through a tunnel). Owner only; the address itself
// is settings.devices.relay (settings.update).
// Owns: the method registration. Never: relay logic or anything secret (there is nothing secret in the state).

import { WorkforceError } from '../../../shared/errors.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('remote.relay', (_params, ctx) => {
    if (!ctx.extras.relay) throw new WorkforceError('unavailable', 'The meeting server is not available on this PC.');
    return ctx.extras.relay.state();
  });
}
