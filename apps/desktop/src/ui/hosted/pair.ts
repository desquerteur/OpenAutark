// Pairing the iPhone web app with a PC by its Remote ID (B-078 follow-up, D5 exactly as Android's relay/RemotePair.java
// and PhoneConnection.pair): a fresh device key registers at the meeting server, finds the PC under the ID, then the
// PC's own connect request with role 'phone' – remote1 with this phone's key and an X25519 key, the PC's commitment,
// remote2 with this phone's nonce and signature, the PC's nonce and signature, the 4-digit code both screens show, and
// remote3 until the person accepts on the PC; the accepted answer (sealed by the request) carries the device token.
// The device info has exactly Android's fields: stable(info) is part of the transcript. An iPhone that locks or switches
// apps while the person walks to the PC loses its socket: the wait registers the same key again and asks remote3 for
// the same session (Pairing.resume probes on return), and says honestly when the PC no longer knows the request.
// Owns: these steps and the paired result. Never: stores anything (the shell does), trusts a PC whose key is not the one
// found under the Remote ID, or an acceptance without the session key's MAC.

import type { PhonePc } from '../../shared/api/methods-phone.ts';
import { b64url, fromB64url, random, type Bytes } from './bytes.ts';
import { fingerprint, newDeviceKey, newX25519, sign, validRemoteId, verify, type DeviceKey } from './crypto.ts';
import { RelayLink, type Found, type WsFactory } from './relay.ts';
import { commitment, mac, macOk, matchCode, sessionKey, signedBytes, transcript } from './sas.ts';

export const ROLE = 'phone';
const STEP_MS = 20_000;
const WAIT_MS = 70_000;

type Body = Record<string, unknown>;
/** One sealed request step to the PC and its opened reply. */
export type Transport = (body: Body, timeoutMs: number) => Promise<Body>;

/** What the phone shows while the person compares the code on the PC. */
export interface Asked { code: string; pcName: string; pcDeviceId: string; session: string; key: Bytes; t: Bytes }

/** A device id the PC accepts (dev_ + 20 base-36 characters). */
export function newDeviceId(): string {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  return `dev_${Array.from(random(20), (b) => digits[b % 36]).join('')}`;
}

/** "iPhone" or "iPad" from the user agent (an iPad reports itself as a Mac with touch). */
export function phoneName(agent: string, touchPoints = 0): string {
  return /iPad/.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1) ? 'iPad' : 'iPhone';
}

const bytesOf = (value: unknown, length: number): Bytes | undefined => {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  try { const out = fromB64url(value); return out.length === length ? out : undefined; } catch { return undefined; }
};

export class RemotePair {
  readonly info: { id: string; name: string; role: 'client'; pub: string; addresses: string[] };
  private readonly transport: Transport;
  private readonly key: DeviceKey;

  constructor(transport: Transport, key: DeviceKey, deviceId: string, name: string) {
    this.transport = transport;
    this.key = key;
    const label = name.replace(/\p{Cc}/gu, ' ').trim().slice(0, 60).trim();
    this.info = { id: deviceId, name: label || 'iPhone', role: 'client', pub: b64url(key.pub), addresses: [] };
  }

  /** remote1 and remote2: the code both screens show. `pcFp`: the key found under the Remote ID. */
  async ask(remoteId: string, pcFp: string): Promise<Asked> {
    const eph = await newX25519();
    const first = await this.step({ kind: 'remote1', v: 1, role: ROLE, device: this.info, eph: b64url(eph.pub), target: { remoteId } }, STEP_MS);
    const pc = first.device as Body | undefined;
    const session = first.session;
    const commit = first.commit;
    const ephA = bytesOf(first.eph, 32);
    if (!pc || typeof pc !== 'object' || typeof session !== 'string' || typeof commit !== 'string' || !ephA) throw new Error('Update Autark on the PC.');
    const pcPub = bytesOf(pc.pub, 32);
    if (!pcPub || (await fingerprint(pcPub)) !== pcFp) throw new Error('A different PC answered than the one with this Remote ID.');
    const t = await transcript(pc, this.info, ephA, eph.pub, commit, ROLE);
    const nb = random(16);
    const second = await this.step({ kind: 'remote2', session, nb: b64url(nb), sig: b64url(await sign(this.key.privateKey, signedBytes('B', t))) }, STEP_MS);
    const na = bytesOf(second.na, 16);
    const sig = typeof second.sig === 'string' ? bytesOf(second.sig, 64) : undefined;
    if (!na || !sig || (await commitment(ephA, eph.pub, na)) !== commit || !(await verify(pcPub, signedBytes('A', t), sig))) {
      throw new Error('The PC could not prove its identity.');
    }
    const key = await sessionKey(eph.privateKey, ephA, t);
    return { code: await matchCode(t, na, nb), pcName: typeof pc.name === 'string' ? pc.name : 'PC', pcDeviceId: typeof pc.id === 'string' ? pc.id : '', session, key, t };
  }

  /** remote3 until the person decides on the PC (each wait ≤ 55 s there). */
  async await(asked: Asked, cancelled: () => boolean): Promise<{ token: string; deviceId: string }> {
    while (!cancelled()) {
      const reply = await this.step({ kind: 'remote3', session: asked.session, mac: await mac(asked.key, 'remote-wait', asked.session) }, WAIT_MS);
      if (reply.status === 'pending') continue;
      if (reply.status === 'declined') throw new Error(typeof reply.reason === 'string' ? reply.reason : 'The PC declined.');
      if (reply.status !== 'accepted') throw new Error('Nobody accepted on the PC in time.');
      if (!reply.device || typeof reply.device !== 'object' || !macOk(await mac(asked.key, 'remote-accept', reply.device, b64url(asked.t)), reply.mac)) {
        throw new Error('The PC could not prove its identity.');
      }
      if (typeof reply.token !== 'string' || typeof reply.deviceId !== 'string') throw new Error('Update Autark on the PC.');
      return { token: reply.token, deviceId: reply.deviceId };
    }
    await this.cancel(asked);
    throw new Error('Cancelled.');
  }

  /** Tells the PC this request ends (≤ 3 s, errors ignored). */
  async cancel(asked: Asked): Promise<void> {
    try { await this.transport({ kind: 'remoteCancel', session: asked.session, mac: await mac(asked.key, 'remote-cancel', asked.session) }, 3_000); } catch { /* the PC lets it expire */ }
  }

  private async step(body: Body, timeoutMs: number): Promise<Body> {
    const reply = await this.transport(body, timeoutMs);
    if (reply.ok === true) return reply;
    const message = (reply.error as { message?: unknown } | undefined)?.message;
    throw new Error(typeof message === 'string' ? message : 'The PC refused the request.');
  }
}

/** What pairing gives the phone (the shell keeps it in IndexedDB). */
export interface Paired { relay: string; key: DeviceKey; deviceId: string; token: string; pcs: PhonePc[] }

/** A pairing in progress: cancel() ends it (the PC hears it); resume() after the page was hidden checks the connection. */
export class Pairing {
  cancelled = false;
  /** Set while a step runs: tells the PC (remoteCancel once the code is shown) and closes the connection. */
  abort: (() => Promise<void>) | undefined;
  /** Set while the code is shown: a dead meeting-server socket closes, so the wait reconnects at once. */
  resume: (() => void) | undefined;
  cancel(): void { this.cancelled = true; void this.abort?.(); }
}

/** How often the wait for Accept reconnects in a row before it gives up (iOS kills the socket of a locked phone). */
export const WAIT_RECONNECTS = 4;
export const LOST_TEXT = 'The connection broke while you were accepting. If you accepted on the PC, it may now list an unused iPhone: remove it there (Settings › Devices), then connect again.';

/** Pairs a new key with the PC under `remoteId`: the code shows through `code`, then the person accepts on the PC. */
export async function pairByRemoteId(input: { relay: string; remoteId: string; name: string; pairing: Pairing; code(code: string, pcName: string): void; socket?: WsFactory }): Promise<Paired> {
  const id = input.remoteId.replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(id)) throw new Error('A Remote ID has nine digits.');
  if (!validRemoteId(id)) throw new Error('This Remote ID has a typo. Check the digits.');
  const key = await newDeviceKey();
  const newLink = () => new RelayLink({ key, pins: new Map(), events: { presence: () => undefined, down: () => undefined }, socket: input.socket });
  let link = newLink();
  let asked: Asked | undefined;
  let exchange: RemotePair | undefined;
  let reconnected = false;
  input.pairing.abort = async () => { if (asked && exchange) await exchange.cancel(asked); link.close(); };
  try {
    await link.connect(input.relay);
    if (input.pairing.cancelled) throw new Error('Cancelled.');
    const found: Found[] = await link.find(id);
    const first = found[0];
    if (!first) throw new Error('No PC with this Remote ID is online at the meeting server. Is Autark running there?');
    let pc: Found = first;
    // The wait for Accept survives a lost socket: the same key registers again and asks for the same session (the PC
    // repeats an accepted answer to a repeated wait).
    const send = async (body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> => {
      for (let tries = 0; ; tries++) {
        try { return await link.request(pc, { op: 'pair', body }, timeoutMs); } catch (error) {
          if (body.kind !== 'remote3' || input.pairing.cancelled || tries >= WAIT_RECONNECTS) throw tries ? new Error(LOST_TEXT) : error;
          link.close();
          if (tries) await new Promise((resolve) => setTimeout(resolve, 1_000 * tries)); // the network may need a moment after unlock
          link = newLink();
          try {
            await link.connect(input.relay);
            pc = (await link.find(id)).find((row) => row.fp === pc.fp) ?? pc;
            reconnected = true;
          } catch { if (tries + 1 >= WAIT_RECONNECTS) throw new Error(LOST_TEXT); }
        }
      }
    };
    exchange = new RemotePair(send, key, newDeviceId(), input.name);
    asked = await exchange.ask(id, pc.fp);
    if (input.pairing.cancelled) throw new Error('Cancelled.');
    input.code(asked.code, asked.pcName);
    input.pairing.resume = () => { const current = link; void current.probe(3_000).then((alive) => { if (!alive) current.close(); }); };
    let accepted: { token: string; deviceId: string };
    try { accepted = await exchange.await(asked, () => input.pairing.cancelled); } catch (error) {
      if (reconnected && error instanceof Error && error.message === 'Nobody accepted on the PC in time.') throw new Error(LOST_TEXT);
      throw error;
    }
    return { relay: input.relay, key, deviceId: accepted.deviceId, token: accepted.token, pcs: [{ fingerprint: pc.fp, publicKey: b64url(pc.pub), name: asked.pcName, deviceId: asked.pcDeviceId }] };
  } catch (error) {
    if (input.pairing.cancelled) throw new Error('Cancelled.');
    throw error;
  } finally {
    input.pairing.abort = undefined;
    input.pairing.resume = undefined;
    link.close();
  }
}
