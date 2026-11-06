// How a linked PC is reached: the address list a PC advertises (merge), the first socket of several
// dials, and one handshake over the routes in order (direct addresses at once, then a tunnel).
// Owns: seenText, mergeAddresses, firstOpen, openChannel, the MeshMeeting shape. Never: stores anything, retries, or knows
// the mesh's links – devices/mesh.ts decides what to do with the channel or the refusal.

import { WorkforceError } from '../../shared/errors.ts';
import { ageText } from '../knowledge/age.ts';
import { REFUSED_CLOSE, connectSecure, type SecureChannel, type SocketLike } from './channel.ts';
import type { Signer } from './handshake.ts';
import { validAddress } from './pair-proof.ts';
import type { DeviceRecord } from './repo.ts';

export const MAX_ADDRESSES = 8;

/** The meeting server's ways to a linked PC (devices/rendezvous/service.ts; the mesh dials them). */
export interface MeshMeeting {
  /** The addresses the server saw that PC on (dialed together with the stored ones). */
  addresses(device: DeviceRecord): string[];
  /** A tunnel through the server – the last fallback; undefined when that PC is not there. */
  tunnel(device: DeviceRecord): Promise<SocketLike> | undefined;
}

/** "last seen 5 min ago" for the not-reachable message (agents and the status line read it). */
export function seenText(lastSeenAt: number | undefined, now: number): string {
  if (!lastSeenAt) return 'not seen yet';
  const minutes = Math.floor(Math.max(0, now - lastSeenAt) / 60_000);
  if (minutes < 1) return 'last seen just now';
  if (minutes < 60) return `last seen ${minutes} min ago`;
  return `last seen ${ageText(lastSeenAt, now)}`;
}

/** The sender's own list, then at most one older known address (http(s) only, ≤ 8); an empty list keeps what is known. */
export function mergeAddresses(received: readonly string[], known: readonly string[]): string[] {
  const fresh = [...new Set(received.filter(validAddress))];
  if (!fresh.length) return [...new Set(known.filter(validAddress))].slice(0, MAX_ADDRESSES);
  const older = known.filter((address) => validAddress(address) && !fresh.includes(address)).slice(0, 1);
  return [...fresh, ...older].slice(0, MAX_ADDRESSES);
}

/** The first socket of several dials that opens (the others close as they open); rejects when all fail. */
export function firstOpen(opens: Array<() => Promise<SocketLike>>): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    let left = opens.length;
    let won = false;
    for (const open of opens) {
      open().then(
        (socket) => { if (won) socket.close(); else { won = true; resolve(socket); } },
        (error: unknown) => { if (--left === 0 && !won) reject(error); },
      );
    }
  });
}

/**
 * Opens the routes in order and runs the handshake on the first socket that opens. `refused`: a
 * socket closed with an explicit refusal before answering the handshake. A close without a code
 * (including a broken tunnel) is retryable. A 'not_found' from the handshake is thrown.
 */
export async function openChannel(
  routes: Array<() => Promise<SocketLike>>, signer: Signer, fingerprint: string,
): Promise<{ channel: SecureChannel } | { refused: boolean; error: unknown }> {
  let error: unknown;
  let refused = false;
  for (const open of routes) {
    let socket: SocketLike;
    try { socket = await open(); } catch (failure) { error = failure; continue; }
    let answered = false;
    let closedUnanswered = false;
    socket.onMessage(() => { answered = true; });
    // Only an explicit refusal (4003) stops retries; tunnels without close codes can fail in transit.
    socket.onClose((code) => { if (!answered && code === REFUSED_CLOSE) closedUnanswered = true; });
    try {
      return { channel: await connectSecure(socket, signer, fingerprint) };
    } catch (failure) {
      if (failure instanceof WorkforceError && failure.code === 'not_found') throw failure;
      socket.close();
      refused ||= closedUnanswered;
      error = failure;
    }
  }
  return { refused, error };
}
