// Request-level security of the runtime HTTP server: Host header allowlist (against DNS
// rebinding: loopback, this PC's own addresses and name, any IP address typed as such – a fixed
// IP or a forwarded port – and Tailscale's MagicDNS names *.ts.net, which `tailscale serve`
// answers with), Origin checks for state-changing requests and WebSocket upgrades, loopback and
// tailnet detection, the transport ceiling (secure = loopback incl. the local `tailscale serve`
// https proxy, or a tailnet peer that reached this PC's own tailnet address; plain LAN http is
// not, even from a 100.64/10 LAN), the bind gate ('tailscale' serves clients only from
// loopback/tailnet), constant-time token comparison and a per-address rate limiter.
// Owns: these pure checks. Never: authentication decisions about tokens (server.ts) or CORS
// headers (the server sends none – everything is same-origin).

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import os from 'node:os';

export type InterfacesFn = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Strips the IPv4-mapped IPv6 prefix and an IPv6 zone id ('::ffff:127.0.0.1' → '127.0.0.1'). */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  let value = address.trim().toLowerCase();
  if (value.startsWith('::ffff:') && value.includes('.')) value = value.slice(7);
  const zone = value.indexOf('%');
  return zone >= 0 ? value.slice(0, zone) : value;
}

export function isLoopback(address: string | undefined): boolean {
  const value = normalizeAddress(address);
  return value === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/** Tailscale address ranges: 100.64.0.0/10 (CGNAT) and fd7a:115c:a1e0::/48 (WireGuard-encrypted). */
export function isTailnetAddress(address: string | undefined): boolean {
  const value = normalizeAddress(address);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(value);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/.test(value);
}

/**
 * Is the TCP peer on an encrypted or local path? Loopback (this computer, or the local
 * `tailscale serve` https proxy) is; a tailnet peer only when the connection also arrived on
 * this PC's tailnet address (`local`), so a LAN that itself uses 100.64.0.0/10 (carrier-grade
 * NAT) never counts. LAN/public peers are not. Decided from the socket addresses only – Host
 * and forwarding headers are client-controlled. A missing `local` fails closed.
 */
export function isSecureTransport(remote: string | undefined, local?: string): boolean {
  return isLoopback(remote) || (isTailnetAddress(remote) && isTailnetAddress(local));
}

/**
 * Bind gate for client routes: 'tailscale' answers only loopback and tailnet peers (the
 * listener is 0.0.0.0, so LAN clients would otherwise reach it); 'lan' and 'localhost'
 * (listener on 127.0.0.1) accept every peer that reached the socket.
 */
export function bindAllows(bind: 'localhost' | 'lan' | 'tailscale', remote: string | undefined, local?: string): boolean {
  return bind !== 'tailscale' || isSecureTransport(remote, local);
}

/**
 * Host name of a Host header without the port, lowercased, IPv6 without brackets.
 * undefined when missing or malformed.
 */
export function hostOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const value = header.trim().toLowerCase();
  if (!value || value.length > 255) return undefined;
  if (value.startsWith('[')) {
    const match = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(value);
    return match ? match[1] : undefined;
  }
  const match = /^([a-z0-9.-]+?)\.?(?::\d{1,5})?$/.exec(value);
  return match ? match[1] : undefined;
}

/** Tailscale's MagicDNS names (`<pc>.<tailnet>.ts.net`): what a phone types for `tailscale serve`; they resolve only inside a tailnet. */
export function isMagicDnsHost(host: string): boolean {
  return host.endsWith('.ts.net') && host.length > '.ts.net'.length;
}

/** A Host that is an IP address itself: the browser went there directly, no DNS name could have been rebound to it. */
const isIpHost = (host: string): boolean => isIP(host) !== 0;

const INTERFACE_TTL_MS = 5_000;

/**
 * Host header allowlist: loopback names/addresses, this machine's interface addresses and
 * host name, any IP address as such, MagicDNS names (*.ts.net), the served https hosts and
 * integrator-provided names.
 * Interface addresses are cached and re-read only when a lookup misses (no timers).
 */
export class HostGuard {
  private readonly interfaces: InterfacesFn;
  private readonly hostname: () => string;
  private readonly extra: () => string[];
  private readonly now: () => number;
  private local = new Set<string>();
  private readAt = -Infinity;
  private served = new Set<string>();

  constructor(options: { interfaces?: InterfacesFn; hostname?: () => string; extra?: () => string[]; now?: () => number } = {}) {
    this.interfaces = options.interfaces ?? os.networkInterfaces;
    this.hostname = options.hostname ?? os.hostname;
    this.extra = options.extra ?? (() => []);
    this.now = options.now ?? Date.now;
  }

  /** Hosts of the https URLs this runtime is served under (from PwaState.urls). */
  setServed(urls: readonly string[]): void {
    const next = new Set<string>();
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:') next.add(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
      } catch { /* not a URL */ }
    }
    this.served = next;
  }

  /** True when the Host header names a served https host or a MagicDNS name (traffic came through the proxy). */
  isServed(hostHeader: string | undefined): boolean {
    const host = hostOf(hostHeader);
    return host !== undefined && (this.served.has(host) || isMagicDnsHost(host));
  }

  /** True when a request with this Host header may be served. */
  allows(hostHeader: string | undefined): boolean {
    const host = hostOf(hostHeader);
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (isIpHost(host) || isMagicDnsHost(host) || this.served.has(host)) return true;
    if (this.extraHosts().has(host)) return true;
    if (this.localHosts(false).has(host)) return true;
    // Interfaces change (DHCP, VPN up): re-read on a miss, at most every few seconds.
    return this.localHosts(true).has(host);
  }

  /** Origin header check: absent is fine (non-browser clients); otherwise http(s) with an allowed host. */
  allowsOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return this.allows(parsed.host);
  }

  private extraHosts(): Set<string> {
    const out = new Set<string>();
    try {
      for (const name of this.extra()) {
        const host = hostOf(name);
        if (host) out.add(host);
      }
    } catch { /* integrator callback failed: ignore extra names */ }
    return out;
  }

  /** Cached interface addresses + host names; `onMiss` re-reads them when the cache is stale. */
  private localHosts(onMiss: boolean): Set<string> {
    const now = this.now();
    const stale = now - this.readAt >= INTERFACE_TTL_MS;
    if (this.readAt !== -Infinity && !(onMiss && stale)) return this.local;
    const next = new Set<string>();
    try {
      for (const entries of Object.values(this.interfaces())) {
        for (const entry of entries ?? []) next.add(normalizeAddress(entry.address));
      }
    } catch { /* interface listing unavailable */ }
    try {
      const name = this.hostname().trim().toLowerCase();
      if (name) { next.add(name); next.add(`${name}.local`); }
    } catch { /* no host name */ }
    next.delete('');
    this.local = next;
    this.readAt = now;
    return this.local;
  }
}

/** Constant-time comparison of two tokens (hashes first, so lengths never leak). */
export function tokensEqual(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Bearer token from an Authorization header (undefined when absent/malformed). */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{1,512})\s*$/i.exec(header);
  return match ? match[1] : undefined;
}

/** Fixed-window counter per key (remote address); bounded memory. */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts one hit; false when the key is over its limit in the current window. */
  take(key: string): boolean {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (this.windows.size >= 1024) this.prune(now);
      entry = { start: now, count: 0 };
      this.windows.set(key, entry);
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.windows) if (now - entry.start >= this.windowMs) this.windows.delete(key);
    if (this.windows.size >= 1024) this.windows.clear(); // pathological: many live keys – start over
  }
}
