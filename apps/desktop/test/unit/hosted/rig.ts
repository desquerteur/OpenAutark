// Test rig for the iPhone web app's tunnel stack: a hosted Tunnel (src/ui/hosted/tunnel.ts) wired to the runtime's own
// RelayTunnel (rendezvous/tunnel.ts) the way the meeting server joins two ends – frames in, frames out, each delivered on
// a later microtask – with the tunnel seal derived exactly as both sides do it (toBox ↔ fromSender), and a phone key.
// Owns: these fixtures. Never: assertions.

import { fromB64url } from '../../../src/ui/hosted/bytes.ts';
import { newDeviceKey, toBox, type DeviceKey } from '../../../src/ui/hosted/crypto.ts';
import { Tunnel } from '../../../src/ui/hosted/tunnel.ts';
import { RelayTunnel } from '../../../src/runtime/devices/rendezvous/tunnel.ts';
import { fromSender, newBox, TUNNEL_INFO } from '../../../src/runtime/devices/rendezvous/seal.ts';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { fakeHost, memoryDb } from '../devices/fakes.ts';

export interface TunnelPair {
  hosted: Tunnel;
  runtime: RelayTunnel;
  /** Frames the hosted side sent towards the PC (binary, header included). */
  toPc: Uint8Array[];
  /** Feeds a frame to the hosted side as if the relay delivered it. */
  inject(frame: Uint8Array): void;
}

export async function tunnelPair(): Promise<TunnelPair> {
  const box = newBox();
  const sealed = await toBox(fromB64url(box.pub), TUNNEL_INFO);
  const cipher = fromSender(box, sealed.e, TUNNEL_INFO)!;
  const toPc: Uint8Array[] = [];
  let runtime!: RelayTunnel;
  const hosted = new Tunnel(7, 'pc', {
    send: (frame) => { toPc.push(frame); const copy = Buffer.from(frame); queueMicrotask(() => runtime.receive(copy)); },
    close: () => queueMicrotask(() => runtime.ended()),
  }, sealed.cipher);
  runtime = new RelayTunnel(7, 'phone', {
    send: (frame) => { const copy = new Uint8Array(frame); queueMicrotask(() => hosted.receive(copy)); },
    close: () => queueMicrotask(() => hosted.ended()),
  }, cipher);
  return { hosted, runtime, toPc, inject: (frame) => hosted.receive(frame) };
}

export const pcIdentity = (name = 'PC'): Promise<DeviceIdentity> => DeviceIdentity.load({ db: memoryDb(), host: fakeHost(), clock: systemClock, name });

export const phoneKey = (): Promise<DeviceKey> => newDeviceKey();

export async function until<T>(read: () => T, ok: (value: T) => boolean, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
