// Reachable URLs of the runtime's HTTP server (PWA) and of the peer listener (linked PCs).
// Owns: listing the https addresses `tailscale serve` forwards to the port (read with `tailscale serve status --json`
// when tailscale is on PATH), localhost, LAN and tailnet addresses in preference order, and (B-078) the global IPv6
// addresses among the peer addresses.
// Never: binds sockets (the HTTP server does), decides what is exposed, or runs any other tailscale command.

import { execFile } from 'node:child_process';
import os from 'node:os';

export type InterfacesFn = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** 100.64.0.0/10 is Tailscale's CGNAT range. */
export function isTailscaleIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function lanAddresses(interfaces: InterfacesFn = os.networkInterfaces): { lan: string[]; tailnet: string[] } {
  const lan: string[] = [];
  const tailnet: string[] = [];
  for (const entries of Object.values(interfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      if (isTailscaleIp(entry.address)) tailnet.push(entry.address);
      else lan.push(entry.address); // includes 169.254/16 link-local (direct cable)
    }
  }
  return { lan, tailnet };
}

/** `tailscale serve status --json`, or undefined when tailscale is missing, slow (3 s) or fails. */
export function readServeStatus(): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('tailscale', ['serve', 'status', '--json'], { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
    } catch {
      resolve(undefined);
    }
  });
}

/** The port a serve handler's Proxy forwards to on this PC ("http://127.0.0.1:47811", "localhost:47811", "47811"). */
function proxyPort(proxy: unknown): number | undefined {
  const match = typeof proxy === 'string' ? /^(?:http:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])?:?(\d{1,5})\/?$/i.exec(proxy.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict => (value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {});

/**
 * The https addresses `tailscale serve` forwards to `port` on this PC (a "/" handler), from its status JSON:
 * `https://<pc>.<tailnet>.ts.net` on 443, with `:<port>` otherwise. Anything unreadable gives none.
 */
export function serveUrls(json: string | undefined, port: number): string[] {
  let config: Dict;
  try { config = dict(JSON.parse(json ?? '')); } catch { return []; }
  const urls: string[] = [];
  for (const [hostPort, site] of Object.entries(dict(config.Web))) {
    const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(hostPort);
    if (!match || dict(dict(config.TCP)[match[2]]).HTTPS !== true) continue;
    if (proxyPort(dict(dict(dict(site).Handlers)['/']).Proxy) !== port) continue;
    urls.push(match[2] === '443' ? `https://${match[1].toLowerCase()}` : `https://${match[1].toLowerCase()}:${match[2]}`);
  }
  return urls;
}

/**
 * URLs a phone or browser may use, best first: the https addresses `tailscale serve` forwards here (`https`), localhost
 * (secure on this PC), then plain http on LAN/tailnet IPs.
 */
export function reachableUrls(input: { port: number; bind: 'localhost' | 'lan' | 'tailscale'; interfaces?: InterfacesFn; https?: readonly string[] }): string[] {
  const urls: string[] = [...input.https ?? [], `http://localhost:${input.port}`];
  if (input.bind !== 'localhost') {
    const { lan, tailnet } = lanAddresses(input.interfaces);
    if (input.bind === 'lan') for (const ip of lan) urls.push(`http://${ip}:${input.port}`);
    for (const ip of tailnet) urls.push(`http://${ip}:${input.port}`);
  }
  return [...new Set(urls)];
}

/** PeerInfo carries at most this many addresses (devices/pair-proof.ts). */
export const MAX_PEER_ADDRESSES = 8;

const isLinkLocal = (ip: string): boolean => ip.startsWith('169.254.');
/** At most this many global IPv6 addresses go into the peer addresses (privacy addresses come and go). */
const MAX_IPV6 = 2;

/** B-078: this PC's global unicast IPv6 addresses (2000::/3 – not loopback, link-local fe80::/10 or ULA fc00::/7): reachable from outside without the router. */
export function globalIpv6(interfaces: InterfacesFn = os.networkInterfaces): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv6' || entry.scopeid) continue;
      if (/^[23][0-9a-f]{3}:/i.test(entry.address) && !/^2001:0?:/i.test(entry.address)) out.push(entry.address.toLowerCase()); // not Teredo (2001::/32)
    }
  }
  return [...new Set(out)];
}

/**
 * Base URLs other PCs can dial for pairing/peer links (never localhost): tailnet first, then the
 * LAN, this PC's global IPv6 addresses (B-078), link-local (169.254/16, a direct cable) last; 'tailscale' lists
 * tailnet addresses only.
 */
export function peerAddresses(port: number, interfaces?: InterfacesFn, mode: 'lan' | 'tailscale' = 'lan'): string[] {
  const { lan, tailnet } = lanAddresses(interfaces);
  const v6 = mode === 'tailscale' ? [] : globalIpv6(interfaces).slice(0, MAX_IPV6).map((ip) => `[${ip}]`);
  const ips = mode === 'tailscale' ? tailnet : [...tailnet, ...lan.filter((ip) => !isLinkLocal(ip)), ...v6, ...lan.filter(isLinkLocal)];
  return [...new Set(ips)].slice(0, MAX_PEER_ADDRESSES).map((ip) => `http://${ip}:${port}`);
}
