// The PCs on this network for Settings › Devices: every Workforce PC that answers the LAN hello
// probe (devices/discovery.ts) – this PC left out, one entry per device and key (an impostor never
// hides the real PC), names as plain text, each marked 'linked' (a linked PC with that key),
// 'waiting' (this PC's open request goes there) or 'new'. Connect on a row sends a normal request
// with its Remote ID, so the other PC's person still accepts it with the code.
// Asked when Settings › Devices opens (the last answer while younger than NEARBY_FRESH_MS) and on
// Refresh; one search at a time; never on a timer.
// Owns: the search, marking and the short cache. Never: polls or lists a PC whose Remote ID is not its key's.

import type { NearbyPc, RemoteOutgoing } from '../../shared/model/remote.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import type { Candidate } from '../devices/discovery.ts';
import { remoteIdOf } from './id.ts';

export const NEARBY_FRESH_MS = 60_000;

/** What a search found, before marking (the marks follow links and requests made afterwards). */
export type FoundPc = Omit<NearbyPc, 'state'>;

export interface NearbyDeps {
  /** This PC's device id and fingerprint (never listed). */
  self: { deviceId: string; fingerprint: string };
  /** The answers to one hello probe. */
  lan(): Promise<Candidate[]>;
  /** This PC's linked PCs (device records; revoked ones are skipped). */
  linked(): ReadonlyArray<{ id: string; fingerprint: string; status: string; self?: boolean }>;
  /** This PC's own request (open or its last outcome). */
  outgoing(): RemoteOutgoing | undefined;
  now(): number;
}

const keyOf = (pc: { deviceId: string; fingerprint: string }) => `${pc.deviceId}:${pc.fingerprint}`;

/** One entry per device and key, addresses merged, this PC left out, sorted by name. */
export function mergeNearby(lan: Candidate[], self: { deviceId: string; fingerprint: string }): FoundPc[] {
  const all = new Map<string, FoundPc>();
  for (const candidate of lan) {
    if (candidate.deviceId === self.deviceId || candidate.fingerprint === self.fingerprint) continue;
    const remoteId = remoteIdOf(candidate.fingerprint);
    if (candidate.remoteId !== remoteId) continue;
    const known = all.get(keyOf(candidate));
    if (known) { known.addresses = [...new Set([...known.addresses, ...candidate.addresses])].slice(0, 8); continue; }
    all.set(keyOf(candidate), { deviceId: candidate.deviceId, name: plainLabel(candidate.name) || 'PC', remoteId, fingerprint: candidate.fingerprint, addresses: candidate.addresses.slice(0, 8) });
  }
  return [...all.values()].sort((a, b) => a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId) || a.fingerprint.localeCompare(b.fingerprint));
}

/** Marks each found PC against the linked PCs and this PC's own request now. */
export function markNearby(found: readonly FoundPc[], linked: ReturnType<NearbyDeps['linked']>, outgoing: RemoteOutgoing | undefined): NearbyPc[] {
  const links = new Set(linked.filter((device) => !device.self && device.status !== 'revoked').map((device) => keyOf({ deviceId: device.id, fingerprint: device.fingerprint })));
  return found.map((pc): NearbyPc => {
    const waiting = outgoing?.status === 'waiting' && outgoing.deviceId === pc.deviceId && outgoing.fingerprint === pc.fingerprint;
    return { ...pc, addresses: [...pc.addresses], state: links.has(keyOf(pc)) ? 'linked' : waiting ? 'waiting' : 'new' };
  });
}

export class NearbyPcs {
  private readonly deps: NearbyDeps;
  private last?: { at: number; found: FoundPc[] };
  private asking?: Promise<FoundPc[]>;

  constructor(deps: NearbyDeps) { this.deps = deps; }

  /** The PCs nearby: the last answer while fresh, else (or with `refresh`) one new search. */
  async list(refresh = false): Promise<NearbyPc[]> {
    const last = this.last;
    const found = !refresh && last && this.deps.now() - last.at < NEARBY_FRESH_MS ? last.found : await this.search();
    return markNearby(found, this.deps.linked(), this.deps.outgoing());
  }

  private search(): Promise<FoundPc[]> {
    this.asking ??= (async () => {
      try {
        const found = mergeNearby(await this.deps.lan().catch((): Candidate[] => []), this.deps.self);
        this.last = { at: this.deps.now(), found };
        return found;
      } finally {
        this.asking = undefined;
      }
    })();
    return this.asking;
  }
}
