// Connecting PCs (Settings › Devices): this PC as other PCs find it – its Remote ID (remote/id.ts),
// name and fingerprint, and whether it accepts connection requests (settings.devices.findable) –,
// the requests other PCs make here (remote/requests.ts, decided by the person) and this PC's own
// request (remote/join.ts). While findable, LAN hello probes are answered (devices/discovery.ts),
// /.well-known/workforce reports `remoteId` and `findable`, and the peer listener stays open.
// `nearby()` lists the PCs on this network that accept requests (remote/nearby.ts).
// Turning requests off ends every open request. stop() ends the LAN answers for good (shutdown).
// Once a PC is linked – on either side – the person gets one notice (linkedNote): which PC, as what, what it receives
// and where to remove it, so no link made from an agent's devices.connect sits unnoticed. An employee's PC accepted
// here (a personId) also calls `admitted` (B-078 D15: the personal manager's one wake about that person).
// Owns: wiring of these parts, the state Settings › Devices shows, `remote.updated` and the linked notice.
// Never: links a PC without the person's answer, or answers probes while not findable.

import type { NearbyPc, RemoteIncoming, RemoteOutgoing, RemoteState } from '../../shared/model/remote.ts';
import type { Device } from '../../shared/model/devices.ts';
import type { Bus } from '../bus.ts';
import type { Clock, Logger } from '../contracts.ts';
import type { Candidate, HelloAnswer } from '../devices/discovery.ts';
import type { DeviceIdentity } from '../devices/identity.ts';
import type { PeerInfo, Reply } from '../devices/pair-proof.ts';
import { formatRemoteId, remoteIdOf } from './id.ts';
import { findTarget, type FindDeps, type Found } from './find.ts';
import { RemoteJoiner, type ConnectInput } from './join.ts';
import { NearbyPcs } from './nearby.ts';
import { TargetRequests, type Timers } from './requests.ts';

export interface RemoteDeps {
  identity: Pick<DeviceIdentity, 'deviceId' | 'fingerprint' | 'sign'>;
  clock: Clock;
  bus: Bus;
  log: Logger;
  /** The linked PCs: this PC's identity, storing a proven PC (and dialing it), the device list. */
  mesh: { selfInfo(): PeerInfo; add(info: PeerInfo, options: { side: 'joiner' | 'inviter'; personId?: string; joinedAs?: 'ceo' | 'employee' }): Device; list(): Device[] };
  /** settings.devices.findable (and a peer listener that may open at all). */
  findable(): boolean;
  /** POST JSON to `<address>/peer/pair` (or the meeting server's `relay:<fp>` route) with a timeout. */
  post(address: string, body: unknown, options: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  /** LAN: answers hello probes while findable. */
  responder?: { answer(answer: HelloAnswer | undefined): void };
  /** LAN: one hello probe. */
  lan?(): Promise<Candidate[]>;
  /** The meeting server: PCs that accept requests under a Remote ID. */
  meeting?(remoteId: string, signal: AbortSignal): Promise<Found[]>;
  wellKnownAt?: FindDeps['wellKnown'];
  /** Holds the peer listener open while this PC's request runs. */
  holdListener?(): Promise<(() => void) | undefined>;
  /** The peer listener's port while it listens (well-known). */
  peerPort?(): number | undefined;
  /** A request is shown here: one notification for the person. */
  notify?(view: RemoteIncoming): void;
  /** A PC is now linked here (either side): one important notification for the person (linkedNote). */
  linked?(note: { title: string; body: string }): void;
  /** B-078 (D15): an employee's PC was accepted here for this person (org/member-welcome.ts, once per person). */
  admitted?(personId: string): void;
  timers?: Timers;
}

/** As what a linked PC is here: one of the CEO's own PCs, the PC of a person here, or the employer's PC this PC joined as an employee's. */
type LinkedAs = 'own' | 'employee' | 'employer';

const LINKED: Readonly<Record<LinkedAs, readonly [as: string, gets: string]>> = {
  own: ['your own PC', 'this company\'s chats, secrets and settings and can run commands on this PC'],
  employee: ['an employee\'s PC', 'its person\'s chats and tasks'],
  employer: ['your employer\'s PC', 'your lines and task changes in its chats and can run commands on this PC'],
};

/** The notice once a PC is linked: which PC, as what, what it receives and where to remove it. */
export function linkedNote(device: Pick<Device, 'name' | 'fingerprint'>, as: LinkedAs): { title: string; body: string } {
  const [what, gets] = LINKED[as];
  return {
    title: `${device.name} is now linked`,
    body: `${device.name} (Remote ID ${formatRemoteId(remoteIdOf(device.fingerprint))}) is linked as ${what}: it receives ${gets}. Remove it in Settings › Devices.`,
  };
}

const realTimers: Timers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** Request kinds of POST /peer/pair. */
export const REMOTE_KINDS: ReadonlySet<string> = new Set(['remote1', 'remote2', 'remote3', 'remoteCancel']);

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export class RemoteService {
  private readonly deps: RemoteDeps;
  private readonly target: TargetRequests;
  private readonly joiner: RemoteJoiner;
  private readonly near: NearbyPcs;
  private lastFindable?: boolean;
  private stopped = false;

  constructor(deps: RemoteDeps) {
    this.deps = deps;
    const timers = deps.timers ?? realTimers;
    const now = () => deps.clock.now();
    this.target = new TargetRequests({
      now, timers, log: deps.log, signer: deps.identity,
      findable: () => this.findable(),
      self: () => deps.mesh.selfInfo(),
      link: (info, personId) => {
        this.store(info, { side: 'inviter', personId }, personId ? 'employee' : 'own');
        if (personId) this.admitted(personId);
      },
      shown: (view) => deps.notify?.(view),
      changed: () => this.changed(),
    });
    this.joiner = new RemoteJoiner({
      now, timers, log: deps.log, signer: deps.identity,
      self: () => deps.mesh.selfInfo(),
      holdListener: () => deps.holdListener?.() ?? Promise.resolve(undefined),
      post: deps.post,
      find: (target) => findTarget({ self: deps.identity.deviceId, lan: deps.lan, meeting: deps.meeting, wellKnown: deps.wellKnownAt }, target),
      // The role this PC asked for stays with the link (the open request's view while it is accepted).
      link: (info) => {
        const joinedAs = this.joiner.outgoing()?.role === 'employee' ? 'employee' : 'ceo';
        this.store(info, { side: 'joiner', joinedAs }, joinedAs === 'employee' ? 'employer' : 'own');
      },
      changed: () => this.changed(),
    });
    this.near = new NearbyPcs({
      self: { deviceId: deps.identity.deviceId, fingerprint: deps.identity.fingerprint },
      lan: () => deps.lan?.() ?? Promise.resolve([]),
      linked: () => deps.mesh.list().filter((device) => device.kind === 'pc'),
      outgoing: () => this.joiner.outgoing(),
      now,
    });
  }

  /** This PC's Remote ID (derived from its key). */
  remoteId(): string { return remoteIdOf(this.deps.identity.fingerprint); }

  state(): RemoteState {
    const self = this.deps.mesh.selfInfo();
    const outgoing = this.joiner.outgoing();
    return {
      self: { deviceId: self.id, name: self.name, remoteId: this.remoteId(), fingerprint: this.deps.identity.fingerprint, findable: this.findable() },
      incoming: this.target.incoming(),
      ...(outgoing ? { outgoing } : {}),
    };
  }

  /** Starts answering LAN probes when findable, ends open requests when not; call again when settings or the listener change. */
  refresh(): void {
    if (this.stopped) return;
    const findable = this.findable();
    this.deps.responder?.answer(findable ? () => this.hello() : undefined);
    if (!findable) this.target.closeAll();
    if (this.lastFindable !== undefined && this.lastFindable !== findable) this.changed();
    this.lastFindable = findable;
  }

  /** Shutdown: no more LAN answers (refresh() stays quiet). */
  stop(): void {
    this.stopped = true;
    this.deps.responder?.answer(undefined);
  }

  /** "Connect" by Remote ID or address, as the CEO or an employee. */
  connect(input: ConnectInput): Promise<RemoteOutgoing> { return this.joiner.connect(input); }

  /** PCs on this network that accept requests, this PC left out; `refresh` asks the network again. */
  nearby(refresh = false): Promise<NearbyPc[]> { return this.near.list(refresh); }

  /** Cancels this PC's open request, or closes its last outcome. */
  cancel(): void { this.joiner.cancel(); }

  /** The person's answer to a request waiting here (`personId`: the person an employee's PC belongs to). */
  decide(id: string, accept: boolean, personId?: string): void { this.target.decide(id, accept, personId); }

  /** POST /peer/pair with a Remote kind (REMOTE_KINDS). */
  handle(body: Record<string, unknown>, remote: { address?: string }): Promise<Reply> {
    return this.target.handle(body, remote);
  }

  /** What /.well-known/workforce answers: the public identity, the Remote ID, `findable` while requests are accepted. */
  wellKnown(): { app: 'workforce'; protocol: 1; deviceId: string; name: string; fingerprint: string; remoteId: string; peerPort?: number; findable?: true } {
    const self = this.deps.mesh.selfInfo();
    const peerPort = this.deps.peerPort?.();
    return {
      app: 'workforce', protocol: 1, deviceId: self.id, name: self.name, fingerprint: this.deps.identity.fingerprint, remoteId: this.remoteId(),
      ...(peerPort ? { peerPort } : {}), ...(this.findable() ? { findable: true as const } : {}),
    };
  }

  private findable(): boolean {
    try { return this.deps.findable(); } catch { return false; }
  }

  /** Stores a proven PC, then tells the person which PC is linked as what (linkedNote). */
  private store(info: PeerInfo, options: Parameters<RemoteDeps['mesh']['add']>[1], as: LinkedAs): void {
    const device = this.deps.mesh.add(info, options);
    this.deps.linked?.(linkedNote(device, as));
  }

  /** An employee's PC is in: the personal manager hears once about the person (never fails the link). */
  private admitted(personId: string): void {
    try { this.deps.admitted?.(personId); } catch (error) { this.deps.log.warn('employee welcome not sent', { personId, error: errorText(error) }); }
  }

  /** A LAN hello probe gets this PC's public identity and Remote ID while it accepts requests. */
  private hello(): Candidate | undefined {
    if (!this.findable()) return undefined;
    const self = this.deps.mesh.selfInfo();
    return { deviceId: self.id, name: self.name, fingerprint: this.deps.identity.fingerprint, remoteId: this.remoteId(), addresses: self.addresses };
  }

  private changed(): void {
    try { this.deps.bus.emit('remote.updated', this.state()); } catch (error) { this.deps.log.warn('remote state not sent', { error: errorText(error) }); }
  }
}
