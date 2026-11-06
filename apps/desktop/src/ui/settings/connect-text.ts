// Texts of Settings › Devices (DevicesGroup.tsx, connect-rows.tsx – also the first run's Connect card): Remote IDs in
// groups of three, the Remote ID row's hint, what this PC's own connect request shows (the line under "Connect"), the
// hint of each device row, a phone's dot, the hint of a browser's Notifications row and – B-078 – the "Connect a phone"
// hint and the words of a phone's request (role 'phone').
// Owns: these pure formatters (test/unit/devices/connect-text.test.ts, test/unit/ui/push-hint.test.ts). Never: RPC or rendering.

import type { Device } from '../../shared/model/devices.ts';
import type { RemoteIncoming, RemoteOutgoing } from '../../shared/model/remote.ts';
import type { RelayState } from '../../shared/model/relay.ts';
import type { PushStatus } from '../pwa/install.ts';

/** How long after its last request a paired phone still counts as in use (its dot is green). */
export const PHONE_IN_USE_MS = 5 * 60_000;

/** "482 913 071" / "482 913". */
export function groupDigits(value: string): string {
  return value.replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
}

/** A typed Remote ID shows grouped while it is digits; an address stays as typed. */
export function typedTarget(value: string): string {
  return /^[\d\s]+$/.test(value) && /\d{4}/.test(value.replace(/\s/g, '')) ? groupDigits(value) : value;
}

/** The line under "Connect": this PC's own request (with the code both screens show), the last error, or the help. */
export interface ConnectLine {
  text: string;
  tone?: 'ok' | 'error';
  code?: string;
  action?: 'cancel' | 'close';
}

export const CONNECT_HINT = 'PCs nearby are listed above; others by Remote ID or address';

export function connectLine(out: RemoteOutgoing | undefined, error: string | null): ConnectLine {
  if (error) return { text: error, tone: 'error' };
  if (!out) return { text: CONNECT_HINT };
  const as = out.role === 'employee' ? ' as an employee' : '';
  switch (out.status) {
    case 'waiting': return { text: `Waiting for ${out.name} to accept${as} – it shows the same code`, code: out.code, action: 'cancel' };
    case 'accepted': return { text: `Connected with ${out.name}${as}`, tone: 'ok', action: 'close' };
    case 'declined': return { text: `${out.name} declined${out.reason ? `: ${out.reason}` : ''}`, tone: 'error', action: 'close' };
    case 'expired': return { text: `Nobody accepted on ${out.name} in time`, tone: 'error', action: 'close' };
    case 'cancelled': return { text: 'Cancelled', action: 'close' };
    default: return { text: `Could not connect to ${out.name}${out.reason ? `: ${out.reason}` : ''}`, tone: 'error', action: 'close' };
  }
}

/** The Remote ID row's hint: how other PCs find this one – through the meeting server, or only on this network. */
export function remoteIdHint(relay: RelayState | undefined, findable: boolean | undefined): string {
  if (findable === false) return 'This PC does not accept connection requests (settings.json devices.findable)';
  const base = 'Type it on another PC to connect';
  if (!relay) return base;
  if (relay.status === 'connected') return `${base} · meeting server connected`;
  if (relay.status === 'off') return `${base} · only this network (meeting server off)`;
  // 'error' retries: its own reason ("The meeting server refused this PC" …), lower-cased inside the brackets.
  const why = relay.status === 'connecting' ? 'meeting server connecting…' : relay.error ? relay.error.charAt(0).toLowerCase() + relay.error.slice(1) : 'meeting server not reachable';
  return `${base} · only this network for now (${why})`;
}

/** A paired phone's dot: 'online' while it was used in the last minutes. */
export function phoneDot(device: { lastSeenAt?: number }, now = Date.now()): 'online' | 'offline' {
  return device.lastSeenAt !== undefined && now - device.lastSeenAt < PHONE_IN_USE_MS ? 'online' : 'offline';
}

/** The hint beside the "Connect a phone" QR: my phone (the Android app) or an employee's invite. */
export function phoneQrHint(employee: boolean): string {
  return employee
    ? 'Scan with the phone camera, or type the code under “I was invited”: it joins as this employee'
    : 'In the Autark app on Android: scan this or type the Remote ID, then accept here when both show the same code';
}

/** A request is the owner's phone app (B-078; shared/model/remote.ts types the PC roles). */
export const isPhoneRequest = (request: Pick<RemoteIncoming, 'role'>): boolean => request.role === 'phone';

/** The label and hint of a request waiting here: a PC (as an employee, maybe) or my phone. */
export function incomingText(request: Pick<RemoteIncoming, 'role' | 'name' | 'code'>): { label: string; hint: string } {
  if (isPhoneRequest(request)) return { label: `Phone ${request.name} asks to connect`, hint: `Accept only if the phone shows the code ${request.code}` };
  return { label: `${request.name} wants to connect${request.role === 'employee' ? ' as an employee' : ''}`, hint: `Accept only if ${request.name} shows the code ${request.code}` };
}

/**
 * The hint under "Notifications" on a phone or browser: what reaches it once on (a person of the organisation: the new
 * messages of their chats – pwa/person-push.ts; the owner's phone: to-dos and blockers, replies when it may chat), or why it
 * cannot be turned on. Undefined while off or not yet read. `iosTab`: the iPhone app opened in a Safari tab, where iOS
 * gives web pages no notifications – they work in the Home Screen app, which keeps its own pairing.
 */
export function pushHint(status: PushStatus | undefined, who: { person: boolean; chat: boolean; iosTab?: boolean }): string | undefined {
  if (status === 'on') return who.person ? 'New messages in your chats reach this phone' : who.chat ? 'To-dos, blockers and replies reach this phone' : 'To-dos and blockers reach this phone';
  if (status === 'blocked') return 'Blocked for this site in the browser settings';
  if (status === 'unsupported' && who.iosTab) return 'On iPhone: Share › Add to Home Screen, open Autark there and connect again; notifications work in the Home Screen app';
  if (status === 'unsupported') return 'This browser cannot show notifications';
  if (status === 'insecure') return 'Needs HTTPS – open the app through an HTTPS address';
  return undefined;
}

const STATUS_TEXT: Partial<Record<Device['status'], string>> = { online: 'Online', connecting: 'Connecting…', offline: 'Not reachable' };

/** "PC · Employee · Anna · Online", "Phone · Last used 09:12", "This PC". */
export function deviceHint(device: Device, personName: (id: string) => string | undefined, time: (at: number) => string): string {
  if (device.self) return 'This PC';
  if (device.kind !== 'pc') return [device.kind === 'phone' ? 'Phone' : 'Browser', device.lastSeenAt ? `Last used ${time(device.lastSeenAt)}` : ''].filter(Boolean).join(' · ');
  const employee = device.personId ? `Employee · ${personName(device.personId) ?? 'a person'}` : '';
  const status = STATUS_TEXT[device.status] ?? device.status;
  return ['PC', employee, status, device.status !== 'online' && device.lastSeenAt ? `Last seen ${time(device.lastSeenAt)}` : ''].filter(Boolean).join(' · ');
}
