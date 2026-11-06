// RPC for the person's emergency stop of all agent work on this PC (agents/work-stop.ts).
// Tiers like the computer-use brake (X02): every paired device may see the state and press the brake
// ('todo'); lifting it needs full access ('manage'). Agents have no tool for either.
// Owns: these three registrations. Never: the latch's behaviour.

import '../../../shared/api/methods-work.ts'; // the work.* method shapes (module augmentation)
import { workStopOf } from '../../agents/work-stop.ts';
import { callerDeviceName } from '../device-name.ts';
import type { HandlerTable } from '../table.ts';

export function register(table: HandlerTable): void {
  table.add('work.state', (_params, ctx) => workStopOf(ctx.services).current(), { capability: 'todo' });
  table.add('work.stop', (_params, ctx) => workStopOf(ctx.services).stop(callerDeviceName(ctx)), { capability: 'todo' });
  table.add('work.resume', (_params, ctx) => workStopOf(ctx.services).resume(callerDeviceName(ctx)), { capability: 'manage' });
}
