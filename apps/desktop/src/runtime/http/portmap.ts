// Automatic port mapping of the peer listener on the home router (D4, owner 06.11.2026: "dass die PCs selber als
// feste IP-Adresse oder Server dienen"), so my other PCs, my company and phones reach this PC directly and the hosted
// meeting server carries less. While the peer listener is open in 'lan' mode: NAT-PMP (RFC 6886, UDP 5351 at the
// router; PCP routers answer it too) first, then UPnP-IGD (SSDP discovery, SOAP AddPortMapping on the WAN connection
// service; its answer counts only from a router address, with the control URL on that host). The mapping is renewed
// at half its lease (a failed renewal is tried again, RENEW_RETRY_S) and deleted when the listener closes. A router outside address
// that is private or carrier-grade NAT (10/8, 172.16/12, 192.168/16, 100.64/10) reaches nobody outside: then nothing is
// advertised. Own small implementation (no dependency); everything here is best effort and silent when no router answers.
// Owns: finding the router, mapping, renewing and removing one TCP port, and the public base URL it gives.
// Never: opens any port but the peer listener's, changes firewall rules, or polls (one renewal timer per mapping).

import { createSocket, type Socket } from 'node:dgram';
import os from 'node:os';
import type { Logger } from '../contracts.ts';

/** A mapping in place: the outside address and port, and how to remove it. */
export interface Mapped { url: string; via: 'nat-pmp' | 'upnp'; lease: number; remove(): Promise<void> }

export interface PortMapDeps {
  log: () => Logger;
  /** The router's IPv4 address(es) to ask by NAT-PMP (default: the first host of each LAN subnet). */
  gateways?: () => string[];
  /** This PC's interfaces (default os.networkInterfaces; tests pass a fixed set). */
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** UDP (tests pass a fake). */
  udp?: () => Socket;
  fetch?: typeof globalThis.fetch;
  /** Lease asked for, seconds (default 3600). */
  lease?: number;
}

const PMP_PORT = 5351;
const SSDP = { host: '239.255.255.250', port: 1900 };
const WAN = /urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d/;
const TIMEOUT_MS = 2_000;

/** An outside IPv4 address nobody outside can reach (private, carrier-grade NAT, loopback, link-local, unset). */
export function unreachableIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return !(a > 0) || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a >= 224;
}

/** The first host of each LAN IPv4 subnet (192.168.1.37/24 → 192.168.1.1): where home routers sit. */
export function guessGateways(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || entry.address.startsWith('169.254.') || entry.address.startsWith('100.')) continue;
      const ip = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      const net = ip.map((part, index) => part & mask[index]);
      net[3] += 1;
      out.push(net.join('.'));
    }
  }
  return [...new Set(out)];
}

/** A NAT-PMP request: 0 = outside address, 2 = map TCP (internal port, suggested outside port, lease; lease 0 removes). */
export function pmpRequest(op: 0 | 2, port = 0, lease = 0): Buffer {
  if (op === 0) return Buffer.from([0, 0]);
  const out = Buffer.alloc(12);
  out.writeUInt8(0, 0); out.writeUInt8(2, 1); out.writeUInt16BE(port, 4); out.writeUInt16BE(port, 6); out.writeUInt32BE(lease, 8);
  return out;
}

/** A NAT-PMP answer: the outside address (op 128) or the mapping (op 130); undefined for an error or another shape. */
export function pmpAnswer(data: Buffer): { ip?: string; port?: number; lease?: number } | undefined {
  if (data.length < 12 || data[0] !== 0 || data.readUInt16BE(2) !== 0) return undefined;
  if (data[1] === 128) return { ip: [...data.subarray(8, 12)].join('.') };
  if (data[1] === 130 && data.length >= 16) return { port: data.readUInt16BE(10), lease: data.readUInt32BE(12) };
  return undefined;
}

function ask(socket: Socket, host: string, port: number, message: Buffer, accept: (data: Buffer) => unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const done = (value: unknown) => { clearTimeout(timer); socket.off('message', onMessage); resolve(value); };
    const onMessage = (data: Buffer) => { const value = accept(data); if (value !== undefined) done(value); };
    const timer = setTimeout(() => done(undefined), TIMEOUT_MS);
    socket.on('message', onMessage);
    socket.send(message, port, host, (error) => { if (error) done(undefined); });
  });
}

/** One SOAP action on the router's WAN connection service; the response text, or undefined. */
async function soap(fetcher: typeof globalThis.fetch, control: string, service: string, action: string, args: Record<string, string | number>): Promise<string | undefined> {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${
    Object.entries(args).map(([key, value]) => `<${key}>${value}</${key}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  try {
    const response = await fetcher(control, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? await response.text() : undefined;
  } catch { return undefined; }
}

/** The WAN connection service of a router description: its type and absolute control URL. */
export function wanService(xml: string, location: string): { type: string; control: string } | undefined {
  for (const block of xml.split(/<service>/i).slice(1)) {
    const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1];
    const control = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!type || !control || !WAN.test(type)) continue;
    const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(xml)?.[1] ?? location;
    try { return { type, control: new URL(control, base).href }; } catch { return undefined; }
  }
  return undefined;
}

export class PortMap {
  private readonly deps: PortMapDeps;
  constructor(deps: PortMapDeps) { this.deps = deps; }

  /** Maps `port` (TCP) on the router; undefined when no router maps it or its outside address reaches nobody. */
  async map(port: number): Promise<Mapped | undefined> {
    try { return (await this.pmp(port)) ?? (await this.upnp(port)); } catch (error) {
      this.deps.log().debug('port mapping failed', { error: String((error as Error)?.message ?? error) });
      return undefined;
    }
  }

  private socket(): Socket {
    const socket = this.deps.udp?.() ?? createSocket('udp4');
    socket.on('error', () => undefined);
    socket.unref?.();
    return socket;
  }

  private async pmp(port: number): Promise<Mapped | undefined> {
    const lease = this.deps.lease ?? 3600;
    for (const gateway of this.deps.gateways?.() ?? guessGateways(this.deps.interfaces?.())) {
      const socket = this.socket();
      try {
        const outside = await ask(socket, gateway, PMP_PORT, pmpRequest(0), (data) => pmpAnswer(data)?.ip) as string | undefined;
        if (!outside) continue;
        if (unreachableIp(outside)) { this.deps.log().info('port mapping skipped', { reason: 'router behind another NAT' }); return undefined; }
        const mapped = await ask(socket, gateway, PMP_PORT, pmpRequest(2, port, lease), (data) => pmpAnswer(data)?.port !== undefined ? pmpAnswer(data) : undefined) as { port: number; lease: number } | undefined;
        if (!mapped?.port) continue;
        const remove = async () => { const s = this.socket(); try { await ask(s, gateway, PMP_PORT, pmpRequest(2, port, 0), (data) => pmpAnswer(data)); } finally { s.close(); } };
        return { url: `http://${outside}:${mapped.port}`, via: 'nat-pmp', lease: mapped.lease || lease, remove };
      } finally { socket.close(); }
    }
    return undefined;
  }

  private async upnp(port: number): Promise<Mapped | undefined> {
    const fetcher = this.deps.fetch ?? globalThis.fetch;
    const socket = this.socket();
    const search = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP.host}:${SSDP.port}`, 'MAN: "ssdp:discover"', 'MX: 1', 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', ''].join('\r\n'));
    let location: string | undefined;
    let local: string | undefined;
    try {
      location = await ask(socket, SSDP.host, SSDP.port, search, (data) => /^location:\s*(\S+)/im.exec(data.toString('latin1'))?.[1]) as string | undefined;
    } finally { socket.close(); }
    if (!location) return undefined;
    // Any LAN device can answer SSDP: I take a description only from a router address and a control URL on that same host.
    const routers = new Set([...(this.deps.gateways?.() ?? []), ...guessGateways(this.deps.interfaces?.())]);
    const host = hostOf(location);
    if (!host || !routers.has(host)) { this.deps.log().debug('port mapping skipped', { reason: 'UPnP answer not from the router' }); return undefined; }
    const description = await fetcher(location, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => (r.ok ? r.text() : ''), () => '');
    const service = wanService(description, location);
    if (!service || hostOf(service.control) !== host) return undefined;
    local = localAddressFor(host, this.deps.interfaces?.() ?? os.networkInterfaces());
    if (!local) return undefined;
    const ipText = await soap(fetcher, service.control, service.type, 'GetExternalIPAddress', {});
    const outside = ipText ? /<NewExternalIPAddress>\s*([\d.]+)\s*</i.exec(ipText)?.[1] : undefined;
    if (!outside || unreachableIp(outside)) return undefined;
    const lease = this.deps.lease ?? 3600;
    const added = await soap(fetcher, service.control, service.type, 'AddPortMapping', {
      NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: local, NewEnabled: 1,
      NewPortMappingDescription: 'Autark peer', NewLeaseDuration: lease,
    });
    if (added === undefined) return undefined;
    const remove = async () => { await soap(fetcher, service.control, service.type, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }); };
    return { url: `http://${outside}:${port}`, via: 'upnp', lease, remove };
  }
}

/** The host of an http(s) URL ('' when it is none). */
function hostOf(url: string): string {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname : ''; } catch { return ''; }
}

/** This PC's LAN address in the router's subnet (/24 match, else the first LAN address). */
function localAddressFor(router: string, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | undefined {
  const lan = Object.values(interfaces).flatMap((entries) => entries ?? []).filter((entry) => !entry.internal && entry.family === 'IPv4').map((entry) => entry.address);
  const prefix = router.split('.').slice(0, 3).join('.');
  return lan.find((ip) => ip.startsWith(`${prefix}.`)) ?? lan[0];
}

/** After a renewal the router did not answer: try again after these waits, then every last one (seconds). */
export const RENEW_RETRY_S = [60, 300, 900];

/**
 * Keeps one port mapped while it is wanted: `start` maps and renews at half the lease (one timer), `stop` removes it.
 * A renewal that fails (a router reboot, a lost packet) is tried again on the same timer (RENEW_RETRY_S) while the port
 * is wanted. `onChange` hears the public base URL (undefined after a stop or a failed renewal).
 */
export class PortKeeper {
  private readonly map: Pick<PortMap, 'map'>;
  private readonly onChange: (url: string | undefined) => void;
  private current?: Mapped;
  private port = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private run = 0;
  private misses = 0;

  constructor(map: Pick<PortMap, 'map'>, onChange: (url: string | undefined) => void) {
    this.map = map;
    this.onChange = onChange;
  }

  url(): string | undefined { return this.current?.url; }

  async start(port: number): Promise<void> {
    if (this.port === port && this.current) return;
    await this.stop();
    this.port = port;
    await this.renew(++this.run);
  }

  private async renew(run: number): Promise<void> {
    const mapped = await this.map.map(this.port);
    if (run !== this.run) { await mapped?.remove().catch(() => undefined); return; }
    const before = this.current?.url;
    this.current = mapped;
    if (mapped?.url !== before) this.onChange(mapped?.url);
    if (mapped) this.misses = 0;
    else if (before || this.misses > 0) this.misses++; // it worked here before: the router comes back
    else return; // no router maps ports here: nothing to wait for
    const wait = mapped ? Math.max(60, mapped.lease / 2) : RENEW_RETRY_S[Math.min(this.misses, RENEW_RETRY_S.length) - 1];
    this.timer = setTimeout(() => { this.timer = undefined; void this.renew(run); }, wait * 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const mapped = this.current;
    this.current = undefined;
    this.port = 0;
    this.misses = 0;
    if (!mapped) return;
    this.onChange(undefined);
    await mapped.remove().catch(() => undefined);
  }
}
