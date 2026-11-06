// The requester side of a connect request: "Connect" with a Remote ID or an address, or a PC on
// this network. Finds the PC (remote/find.ts), runs the exchange of remote/sas.ts against the address
// that answered (an http(s) address or the meeting server's sealed route), shows the code here while
// the other PC's person decides, and holds one long remote3 request at a time (<= 55 s, sent again
// while open) that receives the decision. A network failure is retried with growing one-shot pauses
// (<= 15 s) until the request expired on both sides; giving up tells the other PC (remoteCancel), so
// it never stores this PC alone. Accepted: the other PC is stored with its proven key and dialed
// (mesh.add 'joiner'). The role – 'ceo' for my other device (B-078: no role of its own, a full mirror; the roster then
// makes it whatever this PC is elsewhere) or 'employee' – is part of the transcript both codes cover.
// One request at a time: a second connect while one starts is refused, a new one cancels the previous.
// Owns: the outgoing request and its waiting chain. Never: stores an unproven key, or waits without
// a request in flight (no timer polling).

import { randomBytes } from 'node:crypto';
import type { JoinRole, RemoteOutgoing } from '../../shared/model/remote.ts';
import { WorkforceError, type ErrorCode } from '../../shared/errors.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import { b64url, fingerprintOf, fromB64url } from '../devices/keys.ts';
import { mac, macOk, parseInfo, workingFirst, type PeerInfo } from '../devices/pair-proof.ts';
import { parseTarget, remoteIdOf, type RemoteTarget } from './id.ts';
import { notFoundText, type Found } from './find.ts';
import type { Timers } from './requests.ts';
import { DELIVERY_GRACE_MS, REQUEST_TTL_MS, WAIT_MAX_MS } from './requests.ts';
import { bytes, commitment, matchCode, newEphemeral, newNonce, sessionKey, signedBytes, transcript, verifySide } from './sas.ts';

const STEP_TIMEOUT_MS = 15_000;
const MAX_PAUSE_MS = 15_000;
const KNOWN_CODES: ReadonlySet<string> = new Set(['bad_request', 'not_found', 'conflict', 'forbidden', 'rate_limited', 'unavailable']);

export interface JoinDeps {
  now(): number;
  timers: Timers;
  self(): PeerInfo;
  signer: { sign(data: Uint8Array): Buffer };
  /** Candidates for the target (remote/find.ts); none: rejects not_found with what was searched. */
  find(target: RemoteTarget): Promise<Found[]>;
  /** Keeps the peer listener open while the request runs (the other PC dials the addresses sent). */
  holdListener(): Promise<(() => void) | undefined>;
  /** POST JSON to `<address>/peer/pair`; plain Error on network failure or timeout. */
  post(address: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  /** Stores the accepted device with its proven key (`info.name` already plain) and dials it. */
  link(info: PeerInfo): void;
  changed(): void;
  log: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

export interface ConnectInput { target: string; role?: JoinRole }

interface Outgoing {
  view: RemoteOutgoing;
  address: string;
  session: string;
  key: Buffer;
  t: Buffer;
  info: PeerInfo;
  abort: AbortController;
  release?: () => void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const labelOf = (name: string) => plainLabel(name) || 'PC';

export class RemoteJoiner {
  private readonly deps: JoinDeps;
  private current?: Outgoing;
  private last?: RemoteOutgoing;
  private starting = false;

  constructor(deps: JoinDeps) { this.deps = deps; }

  /** The request this PC made (open or its last outcome), for Settings › Devices. */
  outgoing(): RemoteOutgoing | undefined { return this.current?.view ?? this.last; }

  async connect(input: ConnectInput): Promise<RemoteOutgoing> {
    if (this.starting) throw new WorkforceError('conflict', 'A connection request is starting already. Try again in a moment.');
    this.starting = true;
    try {
      return await this.start(input);
    } finally {
      this.starting = false;
    }
  }

  /** Cancels the open request (the other PC's to-do closes) or closes the last outcome. */
  cancel(): void {
    void this.withdraw();
  }

  private async start(input: ConnectInput): Promise<RemoteOutgoing> {
    let target: RemoteTarget;
    try { target = parseTarget(input.target); } catch (error) { throw new WorkforceError('bad_request', errorText(error)); }
    const found = await this.deps.find(target);
    if (!found.length) throw new WorkforceError('not_found', notFoundText(target));
    await this.withdraw(); // one request at a time: the other PC hears of the old one's end first
    this.last = undefined;
    const release = await this.deps.holdListener(); // the addresses sent to the other PC are listening
    try {
      const outgoing = await this.ask(found[0], target, input.role ?? 'ceo');
      outgoing.release = release;
      this.current = outgoing;
      this.deps.changed();
      void this.wait(outgoing);
      return outgoing.view;
    } catch (error) {
      release?.();
      throw error;
    }
  }

  /** Ends the open request here and tells the other PC (≤ 3 s); clears the last outcome. */
  private async withdraw(): Promise<void> {
    const open = this.current;
    const had = Boolean(open ?? this.last);
    if (open) this.finish(open, 'cancelled');
    this.last = undefined;
    if (had) this.deps.changed();
    if (open) await this.tellCancel(open);
  }

  private tellCancel(out: Outgoing): Promise<unknown> {
    const body = { kind: 'remoteCancel', session: out.session, mac: mac(out.key, 'remote-cancel', out.session) };
    return this.deps.post(out.address, body, { timeoutMs: 3_000 }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- the exchange

  private async ask(candidate: Found, target: RemoteTarget, role: JoinRole): Promise<Outgoing> {
    const mine = this.deps.self();
    const eph = newEphemeral();
    const first = await this.postAny(candidate.addresses, {
      kind: 'remote1', v: 1, device: mine, eph: b64url(eph.pub), role, ...('remoteId' in target ? { target: { remoteId: target.remoteId } } : {}),
    });
    const info = parseInfo(first.reply.device);
    const ephA = bytes(first.reply.eph);
    const commit = typeof first.reply.commit === 'string' ? first.reply.commit : '';
    const session = typeof first.reply.session === 'string' ? first.reply.session : '';
    if (!info || !ephA || !commit || !session) throw new WorkforceError('bad_request', 'Update Autark on the other PC.');
    const fingerprint = fingerprintOf(fromB64url(info.pub));
    if (info.id !== candidate.deviceId || fingerprint !== candidate.fingerprint || ('remoteId' in target && remoteIdOf(fingerprint) !== target.remoteId)) {
      throw new WorkforceError('forbidden', 'A different PC answered than the one that was found.');
    }
    const nb = newNonce();
    const t = transcript({ a: info, b: mine, ephA, ephB: eph.pub, commit, role });
    const second = await this.call(first.address, { kind: 'remote2', session, nb: b64url(nb), sig: b64url(this.deps.signer.sign(signedBytes('B', t))) }, STEP_TIMEOUT_MS);
    const na = bytes(second.na, 16);
    if (!na || commitment(ephA, eph.pub, na) !== commit || !verifySide(info.pub, 'A', t, second.sig)) {
      throw new WorkforceError('forbidden', 'The other PC could not prove its identity.');
    }
    const view: RemoteOutgoing = {
      id: `ro_${randomBytes(8).toString('hex')}`, role, deviceId: info.id, name: labelOf(info.name), remoteId: remoteIdOf(fingerprint), fingerprint,
      code: matchCode(t, na, nb), status: 'waiting', expiresAt: this.deps.now() + REQUEST_TTL_MS,
    };
    this.deps.log.info('connect request sent', { id: view.id, role });
    return {
      view, address: first.address, session, key: sessionKey(eph.privateKey, ephA, t), t,
      info: { ...info, addresses: directFirst(first.address, info.addresses) }, abort: new AbortController(),
    };
  }

  /**
   * The long-request chain: one remote3 at a time until the other PC decides or the request ends.
   * Network failures are retried (2, 4, 8, 15 … s) until the request expired there too.
   */
  private async wait(out: Outgoing): Promise<void> {
    const deadline = out.view.expiresAt + DELIVERY_GRACE_MS;
    let failures = 0;
    while (this.current === out && out.view.status === 'waiting') {
      const started = this.deps.now();
      let reply: Record<string, unknown>;
      try {
        reply = await this.call(out.address, { kind: 'remote3', session: out.session, mac: mac(out.key, 'remote-wait', out.session) }, WAIT_MAX_MS + 15_000, out.abort.signal);
        failures = 0;
      } catch (error) {
        if (out.abort.signal.aborted || this.current !== out) return;
        this.deps.log.warn('connect wait failed', { error: errorText(error) });
        if (this.deps.now() >= deadline) return this.giveUp(out);
        failures++;
        await this.pause(Math.min(MAX_PAUSE_MS, 2_000 * 2 ** (failures - 1), Math.max(0, deadline - this.deps.now())), out.abort.signal);
        continue;
      }
      if (this.current !== out) return;
      if (reply.status === 'accepted') return this.accepted(out, reply);
      if (reply.status === 'declined') return this.end(out, 'declined', typeof reply.reason === 'string' ? labelOfReason(reply.reason) : 'The other PC declined.');
      if (reply.status !== 'pending') return this.end(out, 'expired', 'Nobody accepted it in time.');
      if (this.deps.now() - started < 1_000) await this.pause(3_000, out.abort.signal); // an early answer never spins
    }
  }

  /** The other PC stayed unreachable until the request expired: it hears that this side gave up. */
  private giveUp(out: Outgoing): void {
    this.end(out, 'failed', 'The other PC is not reachable any more.');
    void this.tellCancel(out);
  }

  private accepted(out: Outgoing, reply: Record<string, unknown>): void {
    const info = parseInfo(reply.device);
    if (!info || info.id !== out.info.id || info.pub !== out.info.pub || !macOk(mac(out.key, 'remote-accept', reply.device, b64url(out.t)), reply.mac)) {
      return this.end(out, 'failed', 'The other PC could not prove its identity.');
    }
    try {
      this.deps.link({ ...info, name: labelOf(info.name), addresses: directFirst(out.address, info.addresses) });
    } catch (error) {
      return this.end(out, 'failed', error instanceof WorkforceError ? error.message : 'This PC could not store the other PC.');
    }
    this.end(out, 'accepted');
  }

  private end(out: Outgoing, status: RemoteOutgoing['status'], reason?: string): void {
    if (this.current !== out) return;
    this.finish(out, status, reason);
    this.last = out.view;
    this.deps.changed();
  }

  private finish(out: Outgoing, status: RemoteOutgoing['status'], reason?: string): void {
    out.view = { ...out.view, status, ...(reason ? { reason } : {}) };
    out.abort.abort();
    out.release?.();
    out.release = undefined;
    if (this.current === out) this.current = undefined;
    this.deps.log.info('connect request ended', { id: out.view.id, status });
  }

  /** One-shot pause (aborted with the request). */
  private pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => { signal.removeEventListener('abort', done); this.deps.timers.clear(handle); resolve(); };
      const handle = this.deps.timers.set(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  // ---------------------------------------------------------------- transport

  private async call(address: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const reply = (await this.deps.post(address, body, { timeoutMs, signal })) as { ok?: unknown; error?: { code?: string; message?: string } } & Record<string, unknown>;
    if (reply?.ok === true) return reply;
    const code = (KNOWN_CODES.has(String(reply?.error?.code)) ? reply.error!.code : 'forbidden') as ErrorCode;
    throw new WorkforceError(code, typeof reply?.error?.message === 'string' ? reply.error.message.slice(0, 300) : 'The other PC refused the request.');
  }

  /** remote1 to the first address that answers; an answer (even a refusal) ends the search. */
  private async postAny(addresses: string[], body: unknown): Promise<{ reply: Record<string, unknown>; address: string }> {
    let last: unknown;
    for (const address of addresses) {
      try { return { reply: await this.call(address, body, STEP_TIMEOUT_MS), address }; } catch (error) {
        if (error instanceof WorkforceError) throw error;
        last = error;
      }
    }
    this.deps.log.warn('connect request: no address answered', { error: errorText(last) });
    throw new WorkforceError('unavailable', 'The other PC is not reachable.');
  }
}

/** A reason the other PC sent: one line, at most 200 characters. */
function labelOfReason(reason: string): string {
  return reason.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'The other PC declined.';
}

/** The http(s) address that answered first, then the other PC's own list (a meeting-server route is no address to store). */
function directFirst(address: string, reported: readonly string[]): string[] {
  return /^https?:\/\//.test(address) ? workingFirst(address, reported) : [...reported].slice(0, 8);
}
