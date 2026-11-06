// RPC contract part: linked devices (list, rename, remove), the phone/browser app (the QR link,
// push), computer use on this PC (the live preview, the activity pill and the person's simple
// Stop / Resume), and the session. Handlers: runtime/rpc/handlers/devices.ts (session.info:
// session.ts; the tokenless pwa.exchange: rpc/tokenless.ts). Connecting PCs: shared/model/remote.ts.
// Merged into Methods by module augmentation (split from methods.ts by area).
// Owns: these method shapes and their result types (SessionInfo – re-exported by methods.ts).
// Never: behaviour.

import type { Device, PushConfig, PwaState } from '../model/devices.ts';
import type { Settings } from '../model/system.ts';
import type { ComputerActivityState } from '../model/computer.ts';
import type { DeviceCapability } from './protocol.ts';
import type { MethodName } from './methods.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- devices, phone app
    'devices.list': { params: void; result: Device[] };
    'devices.rename': { params: { id: string; name: string }; result: Device };
    /** Removes a linked PC (the link ends on both sides) or a phone/browser (its token ends). */
    'devices.revoke': { params: { id: string }; result: { ok: true } };
    'pwa.state': { params: void; result: PwaState };
    'pwa.enable': { params: { enabled: boolean; bind?: Settings['pwa']['bind'] }; result: PwaState };
    /** The phone QR code: a one-time link (10 minutes) the phone camera opens, and its 6-digit `code` for an installed app – one pairing with either, until `expiresAt`; `route` (#/…) opens after pairing. */
    'pwa.link': { params: { name?: string; route?: string }; result: { url: string; qrDataUrl: string; expiresAt: number; code: string } };
    'pwa.revoke': { params: { deviceId: string }; result: { ok: true } };
    'pwa.pushSubscribe': { params: { subscription: unknown }; result: { ok: true } };
    /** Any paired device: can the PC push, its VAPID key, and is this browser's subscription (`endpoint`) stored? */
    'pwa.pushConfig': { params: { endpoint?: string } | void; result: PushConfig };
    /** Any paired device: removes only the caller's own subscription(s) (the owner's only by endpoint). */
    'pwa.pushUnsubscribe': { params: { endpoint?: string } | void; result: { ok: true; removed: number } };
    /**
     * Pairing exchange for a new phone/browser: trades the one-time secret from a `pwa.link`
     * URL (`#pair=<secret>`) or that link's 6-digit code for a device token. Callable WITHOUT a token: the PWA sends it as one
     * RpcRequest frame via HTTP `POST /rpc` (JSON body, JSON RpcResponse back).
     */
    'pwa.exchange': { params: { secret: string; name?: string }; result: { token: string; deviceId?: string } };
    /** One current screenshot of a device's screen for the person's live view (not an agent tool). */
    'computer.preview': { params: { deviceId?: string; display?: number }; result: { dataUrl: string; width: number; height: number; at: number } };
    /** What agents do on this PC right now and whether the person stopped computer use. */
    'computer.activity': { params: void; result: ComputerActivityState };
    /** The person's Stop: agents' computer calls here end and new ones are refused until Resume. */
    'computer.stop': { params: void; result: ComputerActivityState };
    /** The person's Resume. */
    'computer.resume': { params: void; result: ComputerActivityState };

    // ----------------------------------------------------------------- session
    /** Who this connection is and which methods it may call (open to every authenticated client). */
    'session.info': { params: void; result: SessionInfo };
  }
}

/** Result of `session.info`: computed from the handler table for the caller's scope. */
export interface SessionInfo {
  kind: 'owner' | 'device' | 'person'; // person: a person of the organisation (shared/model/people.ts)
  /** The device's capabilities (the owner holds all of them). */
  capabilities: DeviceCapability[];
  /** Loopback, local https proxy or tailnet. */
  secure: boolean;
  allowedMethods: MethodName[];
}

/** A device asking to join (people.join – an employee's phone): `ticket` is the page's secret for the wait, `code` the match code. */
export interface AccessTicket {
  id: string;
  ticket: string;
  code: string;
  expiresAt: number;
  proven?: true; // the device used this PC's QR code or code – the PC asks "Allow?", no code to compare
}

/** The wait for that decision: still open, accepted (the token, handed over once), declined, or no longer open. */
export type AccessWait =
  | { status: 'pending'; expiresAt: number }
  | { status: 'accepted'; token: string; deviceId: string; access: 'full' | 'todo' }
  | { status: 'denied'; reason?: string }
  | { status: 'expired'; reason?: string };

export {};
