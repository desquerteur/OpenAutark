// RPC contract part (B-078, D5/D6): the owner's Android phone as a member of the company and as hands for agents.
// Pairing: the phone types this PC's Remote ID or opens the QR's link (PHONE_PAIR_LINK + the ID – the only thing it
// carries), then the normal connect request runs (runtime/devices/rendezvous/phone-pair.ts). Phone use: the app's own
// second socket (apps/android phoneuse/UseLink) calls phoneUse.attach – the answer lists my PCs, so the phone tunnels to
// the first one online when this one is off – and then hears `phoneUse.request` (only its own: the event names its
// deviceId and reaches only that device, runtime/rpc/scopes.ts) and answers each with phoneUse.reply. The app reads
// nothing until a request asks (AccessibilityService). phoneUse.reply and phoneUse.attached are bus-only. The iPhone web
// app (ui/hosted, no phone use on iOS) asks phone.pcs for the same list without claiming phone use, and phone.forget
// removes its own row when the person taps Forget there.
// Handlers: runtime/rpc/handlers/phone-use.ts. Merged into Methods/EventMap by module augmentation.
// Owns: these shapes and the pair link's spelling. Never: behaviour.

/** The QR on the PC carries only this plus the Remote ID; Android App Links open the app for it, else the site's pair page shows the ID. */
export const PHONE_PAIR_LINK = 'https://metajarvis.teydralab.com/autark/pair/#';

/** The pair link of a Remote ID (9 digits). */
export function phonePairLink(remoteId: string): string {
  return `${PHONE_PAIR_LINK}${remoteId.replace(/\D/g, '')}`;
}

/** The Remote ID in a typed text or a scanned pair link ("482 913 071", "…/autark/pair/#482913071", older "…/pair#…"); undefined when none. */
export function remoteIdOfPairText(text: string): string | undefined {
  const value = text.trim();
  const hash = value.lastIndexOf('#');
  const digits = (hash >= 0 && /\/pair\/?#/.test(value) ? value.slice(hash + 1) : value).replace(/[\s-]/g, '');
  return /^\d{9}$/.test(digits) ? digits : undefined;
}

/** What an agent asks the phone to do (the PhoneDriver's steps; coordinates in screen pixels). */
export type PhoneUseOp = 'ui_tree' | 'screenshot' | 'tap' | 'swipe' | 'type' | 'key' | 'open';

export interface PhoneUseRequest {
  /** The phone the request is for (only that device hears it). */
  deviceId: string;
  id: string;
  op: PhoneUseOp;
  args: Record<string, unknown>;
}

export interface PhoneUseReply {
  id: string;
  result?: unknown;
  /** 'off' (phone use is not turned on in Android's Accessibility settings), 'paused' (the person tapped the bubble), 'consent' (the person declined that app), … */
  error?: { code: string; message: string };
}

/** One of my PCs as the phone keeps it (it tunnels to the first one online). */
export interface PhonePc {
  deviceId: string;
  name: string;
  fingerprint: string;
  /** base64url Ed25519 – the key the phone pins at the meeting server and checks in the handshake. */
  publicKey: string;
}

export interface PhoneUseAttach {
  /** "Pixel 8" – shown in phone.devices. */
  model?: string;
  /** Screen size in pixels. */
  screen?: { width: number; height: number };
  /** The AccessibilityService is on (phone use can act now). */
  ready?: boolean;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** The Android app's own socket: phone use is reachable on this connection until it closes; the answer lists my PCs. */
    'phoneUse.attach': { params: PhoneUseAttach; result: { pcs: PhonePc[] } };
    /** The answer to one phoneUse.request. */
    'phoneUse.reply': { params: PhoneUseReply; result: { ok: true } };
    /** The paired phone itself (the iPhone web app, which has no phone use): my PCs it pins and tunnels to. */
    'phone.pcs': { params: void; result: { pcs: PhonePc[] } };
    /** The paired phone itself ("Forget this phone"): its own row, token and push subscriptions end, on every PC of the roster. */
    'phone.forget': { params: void; result: { ok: true } };
    /** Owner: what "Connect a phone" shows – this PC's Remote ID and the QR of its pair link. */
    'phone.pairLink': { params: void; result: { remoteId: string; url: string; qrDataUrl: string } };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** A step for one phone (reaches only the device it names). */
    'phoneUse.request': PhoneUseRequest;
    /** Bus only: a phone's answer, with the device that sent it. */
    'phoneUse.reply': PhoneUseReply & { deviceId: string };
    /** Bus only: a phone's use socket came (on) or went (off). */
    'phoneUse.attached': PhoneUseAttach & { deviceId: string; on: boolean };
  }
}
