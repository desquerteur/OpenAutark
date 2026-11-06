// The name of the paired phone or browser behind an RPC call (X02): computer use and phone use
// show who pressed Stop ("Computer use stopped from Pixel"). The owner's window, shortcut and
// tray have none. Names come from the devices repo (it lists phones and browsers too), stripped
// of control characters and cut to 60 characters; an unknown device is "a phone".
// Owns: that lookup. Never: trusts a name sent by the caller.

import type { HandlerContext } from './table.ts';

const MAX_NAME = 60;
const FALLBACK = 'a phone';

/** The calling device's name; undefined for the owner (and for peers, which never call here). */
export function callerDeviceName(ctx: Pick<HandlerContext, 'scope' | 'services'>): string | undefined {
  const { scope } = ctx;
  if (scope.kind !== 'device') return undefined;
  let name: string | undefined;
  try { name = ctx.services.devices.list().find((device) => device.id === scope.deviceId)?.name; } catch { name = undefined; }
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_NAME).trim();
  return clean || FALLBACK;
}
