// This installation's device identity: a long-term Ed25519 key pair and the `self` row.
// Owns: creating/loading the key (private key encrypted with the host keychain, stored in kv),
// signing, and keeping the self row (name, caps, addresses) current. Every PC is home of its
// own data (role 'home'); linked PCs are peers – no role can be forced from outside.
// Never: exposes the private key outside this object, or writes it unencrypted anywhere.

import type { KeyObject } from 'node:crypto';
import os from 'node:os';
import type { Db } from '../db/database.ts';
import type { Host } from '../host.ts';
import type { Clock } from '../contracts.ts';
import { KvRepo } from '../store/kv.ts';
import { newId } from '../../shared/ids.ts';
import type { DeviceCaps } from '../../shared/model/devices.ts';
import { DevicesRepo, type DeviceRecord } from './repo.ts';
import { b64url, exportPrivate, fingerprintOf, generateEd25519, importPrivate, rawPublic, signEd25519 } from './keys.ts';

const NS = 'device';

interface StoredIdentity {
  deviceId: string;
  publicKey: string; // base64url raw
  privateCipher: string; // base64 of host.encrypt(pkcs8 base64)
}

export class DeviceIdentity {
  readonly deviceId: string;
  readonly publicKey: Buffer; // raw 32 bytes
  readonly fingerprint: string;
  private readonly privateKey: KeyObject;

  private constructor(deviceId: string, publicKey: Buffer, privateKey: KeyObject) {
    this.deviceId = deviceId;
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.fingerprint = fingerprintOf(publicKey);
  }

  /** Loads the identity from kv or creates it on first start; ensures the self row exists. */
  static async load(input: { db: Db; host: Host; clock: Clock; name?: string; caps?: DeviceCaps }): Promise<DeviceIdentity> {
    const kv = new KvRepo(input.db);
    const repo = new DevicesRepo(input.db);
    let stored = kv.get<StoredIdentity>(NS, 'identity');
    let identity: DeviceIdentity;
    if (stored) {
      const pkcs8 = await input.host.decrypt(Buffer.from(stored.privateCipher, 'base64'));
      identity = new DeviceIdentity(stored.deviceId, Buffer.from(stored.publicKey, 'base64url'), importPrivate(pkcs8));
    } else {
      const pair = generateEd25519();
      const deviceId = newId('dev', input.clock.now());
      const cipher = await input.host.encrypt(exportPrivate(pair.privateKey));
      stored = { deviceId, publicKey: b64url(rawPublic(pair.publicKey)), privateCipher: Buffer.from(cipher).toString('base64') };
      kv.set(NS, 'identity', stored, input.clock.now());
      identity = new DeviceIdentity(deviceId, rawPublic(pair.publicKey), pair.privateKey);
    }
    const existing = repo.get(identity.deviceId);
    const record: DeviceRecord = {
      id: identity.deviceId,
      name: existing?.name ?? input.name ?? os.hostname(),
      kind: 'pc',
      role: 'home',
      fingerprint: identity.fingerprint,
      publicKey: b64url(identity.publicKey),
      addresses: existing?.addresses ?? [],
      caps: { os: process.platform, ...(existing?.caps ?? {}), ...(input.caps ?? {}) },
      status: 'online',
      self: true,
      pairedAt: existing?.pairedAt,
      lastSeenAt: input.clock.now(),
    };
    repo.upsert(record);
    return identity;
  }

  sign(data: Uint8Array): Buffer {
    return signEd25519(this.privateKey, data);
  }
}
