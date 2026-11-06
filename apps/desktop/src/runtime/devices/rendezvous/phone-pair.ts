// B-078 (D5): the owner's phone pairs like a PC – by this PC's Remote ID (typed in the Android app, or the QR that only
// carries it), the same 4-digit code on both screens, Accept on the PC. The phone sends the normal connect request
// (remote1…remote3, remote/sas.ts) with role 'phone' and its own key; this file keeps those requests in a TargetRequests of
// their own (roles ['phone']) beside the PCs' and shows them in the same list (remote.state incoming, remote.decide).
// On Accept the phone is stored as a phone with its key (pwa/service.ts pairPhone) – the meeting server then pins it
// (rendezvous/service.ts), the roster carries it to my other PCs (devices/sync/roster.ts) – and its device token rides
// in the accepted answer, which travels sealed. Access exists exactly while that device row exists; Remove ends it.
// Owns: routing the phone's request steps, merging them into the PCs' request list, the phone's linked notice.
// Never: links a phone without the person's Accept, or hands a phone a PC link.

import type { RemoteIncoming, RemoteState } from '../../../shared/model/remote.ts';
import { TargetRequests, type Timers } from '../../remote/requests.ts';
import { RemoteService, type RemoteDeps } from '../../remote/service.ts';
import type { Reply } from '../pair-proof.ts';

export interface PhonePairDeps {
  /** Stores the accepted phone with its key and issues its device token (pwa/service.ts pairPhone). */
  pair(input: { id: string; name: string; publicKey: string }): { token: string; deviceId: string };
}

const realTimers: Timers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** The notice once a phone is linked: which phone, what it reaches, where to remove it. */
export function phoneLinkedNote(name: string): { title: string; body: string } {
  return {
    title: `${name} is now linked`,
    body: `The phone ${name} is linked as your phone: it reaches this company's chats, tasks, settings and secrets on each of your PCs. Remove it in Settings › Devices.`,
  };
}

/** True when a connect request step belongs to the phones' side (remote1 with role phone, or one of its sessions). */
export function isPhoneStep(body: Record<string, unknown>, phones: Pick<TargetRequests, 'owns'>): boolean {
  return (body.kind === 'remote1' && body.role === 'phone') || (body.kind !== 'remote1' && phones.owns(body.session));
}

/** RemoteService with the phones' requests in the same list and the same decide. */
export class RemoteWithPhones extends RemoteService {
  readonly phones: TargetRequests;
  private readonly bus: RemoteDeps['bus'];

  constructor(deps: RemoteDeps & PhonePairDeps) {
    super(deps);
    this.bus = deps.bus;
    this.phones = new TargetRequests({
      now: () => deps.clock.now(), timers: deps.timers ?? realTimers, log: deps.log, signer: deps.identity, roles: ['phone'],
      findable: () => { try { return deps.findable(); } catch { return false; } },
      self: () => deps.mesh.selfInfo(),
      link: (info) => {
        const issued = deps.pair({ id: info.id, name: info.name, publicKey: info.pub });
        deps.linked?.(phoneLinkedNote(info.name));
        return { token: issued.token, deviceId: issued.deviceId };
      },
      shown: (view) => deps.notify?.(view),
      changed: () => this.announce(),
    });
  }

  override state(): RemoteState {
    const state = super.state();
    // `this.phones` is set after super(): the base constructor never asks for the state.
    const phones: RemoteIncoming[] = this.phones ? this.phones.incoming() : [];
    return phones.length ? { ...state, incoming: [...state.incoming, ...phones] } : state;
  }

  override decide(id: string, accept: boolean, personId?: string): void {
    if (this.phones.holds(id)) this.phones.decide(id, accept);
    else super.decide(id, accept, personId);
  }

  override handle(body: Record<string, unknown>, remote: { address?: string }): Promise<Reply> {
    return isPhoneStep(body, this.phones) ? this.phones.handle(body, remote) : super.handle(body, remote);
  }

  override refresh(): void {
    super.refresh();
    try { if (!(this.wellKnown().findable)) this.phones?.closeAll(); } catch { /* not ready */ }
  }

  private announce(): void {
    try { this.bus.emit('remote.updated', this.state()); } catch { /* the list still shows on the next read */ }
  }
}
