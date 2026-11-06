// Device model: this PC, linked PCs, phones and browsers.
// Owns: the device registry shapes shared by runtime and UI, and phone/browser access state.
// Never: carries private keys or one-time pairing secrets to the UI.

export type DeviceKind = 'pc' | 'phone' | 'browser';
// Every PC is home of its own data and linked PCs are peers ('home'); 'node' is only read from older
// pairings and means nothing else; phones and browsers are 'client'.
export type DeviceRole = 'home' | 'node' | 'client';

export interface DeviceCaps {
  engines?: string[]; // engines with logged-in accounts on that device
  computerUse?: boolean;
  browser?: boolean;
  shell?: boolean;
  screens?: number;
  adbPhones?: string[]; // phones reachable via ADB from this PC
  os?: string;
}

export interface Device {
  id: string;
  name: string; // "Laptop Küche"
  kind: DeviceKind;
  role: DeviceRole;
  fingerprint: string; // sha256 of the device public key
  addresses: string[]; // base URLs it was reached on (LAN, tailnet, the address the meeting server saw)
  caps: DeviceCaps;
  /** Linked PCs: 'connecting' until the first dial ends, 'offline' after a failed dial or a closed link. */
  status: 'online' | 'connecting' | 'offline' | 'pairing' | 'revoked';
  self: boolean; // this installation
  pairedAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
  /**
   * A linked PC that joined as an employee: the person (people/*) it belongs to. Absent = the CEO's
   * own device (everything the same). An employee's PC may not run tools on this PC.
   */
  personId?: string;
}

export interface PwaState {
  enabled: boolean;
  urls: string[]; // reachable URLs (localhost, LAN, tailnet)
  secure: boolean; // https available (needed for install/mic/push on phones)
  /** Paired phones/browsers; `notifications` = the PC holds a push subscription from it. */
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt?: number; notifications?: boolean }>;
  /** The PC can send Web Push: its VAPID key is available. */
  pushReady: boolean;
  vapidPublicKey?: string; // base64url VAPID public key for PushManager.subscribe (when pushReady)
}

/**
 * What a phone/browser needs to turn notifications on (pwa.pushConfig, open to every paired
 * device): whether the PC can push, the key to subscribe with, and whether this very browser's
 * subscription is stored on the PC (the "On" state – a granted browser permission alone is not).
 */
export interface PushConfig {
  pushReady: boolean;
  vapidPublicKey?: string;
  subscribed: boolean;
  /** Why push is not ready ("The PC could not prepare notifications." …), when it is not. */
  reason?: string;
}
