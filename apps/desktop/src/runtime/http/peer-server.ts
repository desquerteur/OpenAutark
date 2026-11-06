// The dedicated listener linked PCs reach this PC on: a second node:http server (port
// settings.devices.peerPort, default 47812) that serves ONLY `GET /.well-known/workforce`,
// `POST /peer/pair` and the `/peer` WebSocket upgrade (peer.ts); every other path answers 404.
// It is open while something needs it – this PC's own connect request in flight (`hold`), at
// least one linked PC, or this PC accepting connection requests (`wanted`, settings.devices.findable)
// – and closed otherwise. Triggers: holds, device and settings events, host resume (`refresh`);
// never a timer. 'lan' binds 0.0.0.0 (and '::' IPv6-only while this PC has a global IPv6 address –
// B-078: such an address is reachable from outside without the router), 'tailscale' only this PC's
// tailnet addresses (re-read on every trigger), 'off' never opens. A PC behind a router is reached
// from outside when this port is forwarded: B-078 maps it itself while open in 'lan' mode (NAT-PMP or
// UPnP, http/portmap.ts) and advertises the outside address first. Nothing here adds firewall rules.
// Owns: when and where it listens (configured port → remembered fallback → any free port) and
// its state. Never: client routes (/rpc, /ws, /mcp, /files, the UI), or cutting established peer
// sockets when the listener closes (only shutdown closes them).

import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Device } from '../../shared/model/devices.ts';
import type { PeerListenerState } from '../../shared/model/system.ts';
import type { Bus } from '../bus.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { globalIpv6, lanAddresses, MAX_PEER_ADDRESSES, peerAddresses, type InterfacesFn } from '../pwa/urls.ts';
import { KvRepo } from '../store/kv.ts';
import { isBusy, listenOn } from './listen.ts';
import { PeerRoutes, type PeerListenMode } from './peer.ts';
import { PortKeeper, type PortMap } from './portmap.ts';
import type { MeshAccept, PairingHttp } from './types.ts';

export type PeerMode = PeerListenerState['mode'];

/** Default port of the peer listener (the runtime HTTP server uses 47811). */
export const DEFAULT_PEER_PORT = 47812;

export interface PeerServerDeps {
  pairing: PairingHttp;
  mesh: MeshAccept;
  log: () => Logger;
  /** Mode and port (settings.devices; the headless CLI may override the mode). Read on every check. */
  config: () => { mode: PeerMode; port: number };
  /** True while at least one PC is linked (see hasLinkedPc). */
  linked: () => boolean;
  /** True while this PC accepts connection requests (other PCs must reach it). */
  wanted?: () => boolean;
  /** device.upserted / device.removed / settings.updated re-check whether the listener is needed. */
  bus?: Pick<Bus, 'on'>;
  /** The port chosen when the configured one was taken (other PCs stored it at pairing). */
  remember?: { get(): number | undefined; set(port: number): void };
  /** Listen addresses per mode (default 0.0.0.0, or this PC's tailnet IPv4 addresses). Tests: 127.0.0.1. */
  hosts?: (mode: PeerListenMode) => string[];
  interfaces?: InterfacesFn;
  /** Extra Host names to accept (the MagicDNS name). */
  allowedHosts?: () => string[];
  /** Peer addresses to advertise while this listener is not open (the runtime server on the LAN). */
  fallbackAddresses?: () => string[];
  /** B-078: maps the port on the home router while open in 'lan' mode (http/portmap.ts); none in tests. */
  portmap?: Pick<PortMap, 'map'>;
}

interface Open { mode: PeerListenMode; port: number; key: string; servers: Server[] }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
};

/** '::' beside 0.0.0.0 on the same port: IPv6 only, so it never collides with the IPv4 socket (B-078). */
function listenV6Only(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '::', port, ipv6Only: true }, () => { server.off('error', reject); resolve(); });
  });
}

const linkedNow = (deps: PeerServerDeps): boolean => { try { return deps.linked() || (deps.wanted?.() ?? false); } catch { return false; } };

/** A PC this one is linked with (revoked ones not). */
export function hasLinkedPc(devices: readonly Device[]): boolean {
  return devices.some((device) => device.kind === 'pc' && !device.self && device.status !== 'revoked');
}

/** The fallback peer port kept in kv, so linked PCs find this PC again after a restart. */
export function rememberedPeerPort(services: () => RuntimeServices): NonNullable<PeerServerDeps['remember']> {
  return {
    get: () => {
      try {
        const value = new KvRepo(services().db).get<number>('http', 'peerFallbackPort');
        return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : undefined;
      } catch { return undefined; }
    },
    set: (port) => {
      try { const s = services(); new KvRepo(s.db).set('http', 'peerFallbackPort', port, s.clock.now()); } catch { /* best effort */ }
    },
  };
}

export class PeerServer {
  private readonly deps: PeerServerDeps;
  private readonly routes: PeerRoutes;
  private readonly draining = new Set<Server>();
  private readonly changeListeners = new Set<(state: PeerListenerState) => void>();
  private readonly openListeners = new Set<() => void>();
  private open?: Open;
  private current: Omit<PeerListenerState, 'addresses'> = { status: 'closed', mode: 'lan' };
  /** Config whose listen failed: retried on refresh() or a config change, not on every event. */
  private failedKey?: string;
  private lastPort = 0;
  private holds = 0;
  private queue: Promise<void> = Promise.resolve();
  private subscriptions: Array<() => void> = [];
  private closed = false;

  private readonly keeper?: PortKeeper;

  constructor(deps: PeerServerDeps) {
    this.deps = deps;
    this.routes = new PeerRoutes({ pairing: deps.pairing, mesh: deps.mesh, log: deps.log, interfaces: deps.interfaces, allowedHosts: deps.allowedHosts });
    // The router's outside address joins the addresses when it maps (or leaves them): the linked PCs hear it at once.
    this.keeper = deps.portmap ? new PortKeeper(deps.portmap, (url) => { this.deps.log().info('peer port mapping', { mapped: Boolean(url) }); this.announce(); }) : undefined;
  }

  /** Subscribes to device/settings events and opens the listener if it is needed now. */
  start(): Promise<void> {
    const bus = this.deps.bus;
    if (bus && !this.subscriptions.length) {
      const check = () => { void this.update(); };
      this.subscriptions.push(bus.on('device.upserted', check), bus.on('device.removed', check), bus.on('settings.updated', check));
    }
    return this.update();
  }

  /** Re-checks whether the listener is needed and opens/closes it (serialized). */
  update(): Promise<void> { return this.enqueue(false); }

  /** Like update(), and tries again after a failed listen (host resume, a new pairing). */
  refresh(): Promise<void> { return this.enqueue(true); }

  /** Keeps the listener open until the returned release runs; resolves once it listens (or could not). */
  async hold(): Promise<() => void> {
    this.holds++;
    await this.refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      void this.update();
    };
  }

  /** The port this listener accepts on (undefined while closed). */
  port(): number | undefined { return this.open?.port; }

  /** Base URLs other PCs dial – read now (DHCP and VPNs change them); the fallback while closed. */
  addresses(): string[] {
    const mapped = this.open && this.keeper?.url();
    if (this.open) return [...(mapped ? [mapped] : []), ...peerAddresses(this.open.port, this.deps.interfaces, this.open.mode)].slice(0, MAX_PEER_ADDRESSES);
    try { return this.deps.fallbackAddresses?.() ?? []; } catch { return []; }
  }

  /** What Settings › Devices shows (addresses only while this listener is open). */
  state(): PeerListenerState {
    return { ...this.current, addresses: this.open ? this.addresses() : [] };
  }

  /** Called when status, mode, port or error change (the self device row follows). */
  onChange(listener: (state: PeerListenerState) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  /** Called every time a listener starts (linked PCs may reach this PC again: dial them). */
  onOpened(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => { this.openListeners.delete(listener); };
  }

  /** Shutdown: stops listening and closes the peer sockets accepted here (bounded wait). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.subscriptions.splice(0)) off();
    await this.queue;
    this.stopListening();
    await this.routes.closeSockets();
    const servers = [...this.draining];
    await Promise.race([
      Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }))),
      delay(2_000, undefined, { ref: false }),
    ]);
    this.draining.clear();
  }

  // ---------------------------------------------------------------- lifecycle

  private enqueue(force: boolean): Promise<void> {
    this.queue = this.queue.then(() => this.apply(force)).catch((error: unknown) => {
      this.deps.log().error('peer listener update failed', { error: errorText(error) });
    });
    return this.queue;
  }

  private async apply(force: boolean): Promise<void> {
    if (this.closed) return;
    const { mode, port } = this.config();
    const needed = mode !== 'off' && (this.holds > 0 || linkedNow(this.deps));
    // 'tailscale' binds this PC's tailnet addresses: read on every check, so a changed tailnet IP
    // re-opens the listener on the new one (and a tailnet that appears ends NO_TAILNET).
    const tailnet = needed && mode === 'tailscale' ? this.hostsFor(mode) : undefined;
    const key = `${mode}:${port}${tailnet ? `:${[...tailnet].sort().join(',')}` : ''}`;
    if (this.open && (!needed || this.open.key !== key)) this.stopListening();
    if (mode === 'off' || !needed) {
      this.failedKey = undefined;
      this.set({ status: mode === 'off' ? 'off' : 'closed', mode });
      return;
    }
    if (this.open || (this.failedKey === key && !force)) return;
    await this.listen(mode, port, key, tailnet ?? this.hostsFor(mode));
  }

  /** Listen addresses: 0.0.0.0 (and '::' while this PC has a global IPv6 address) for 'lan', this PC's tailnet IPv4 addresses for 'tailscale'. */
  private hostsFor(mode: PeerListenMode): string[] {
    try {
      if (this.deps.hosts) return this.deps.hosts(mode);
      return mode === 'lan' ? ['0.0.0.0', ...(globalIpv6(this.deps.interfaces).length ? ['::'] : [])] : lanAddresses(this.deps.interfaces).tailnet;
    } catch { return []; }
  }

  private async listen(mode: PeerListenMode, configured: number, key: string, hosts: string[]): Promise<void> {
    if (!hosts.length) return this.fail(mode, key, 'NO_TAILNET');
    const log = this.deps.log();
    try {
      const { servers, port } = await this.bind(hosts, configured, mode);
      if (this.closed) { for (const server of servers) server.close(); return; }
      this.open = { mode, port, key, servers };
      this.lastPort = port;
      this.failedKey = undefined;
      if (configured > 0 && port !== configured) log.warn('peer port busy; using another port', { configured, port });
      log.info('peer listener open', { hosts, port });
      this.set({ status: 'open', mode, port });
      if (mode === 'lan') void this.keeper?.start(port);
      for (const listener of this.openListeners) {
        try { listener(); } catch (error) { log.warn('peer listener open hook failed', { error: errorText(error) }); }
      }
    } catch (error) {
      log.warn('peer listener could not open', { port: configured, code: codeOf(error) });
      this.fail(mode, key, codeOf(error));
    }
  }

  /** Configured port, then the remembered fallback, then any free port; further hosts share it. */
  private async bind(hosts: string[], configured: number, mode: PeerListenMode): Promise<{ servers: Server[]; port: number }> {
    const remembered = configured > 0 ? this.deps.remember?.get() : undefined;
    const ports = [...new Set([configured, remembered ?? configured, configured > 0 ? 0 : configured])];
    let first: { server: Server; port: number } | undefined;
    let lastError: unknown;
    for (const port of ports) {
      try { first = await this.listenRetrying(hosts[0], port, mode); break; } catch (error) {
        if (!isBusy(error)) throw error;
        lastError = error;
      }
    }
    if (!first) throw lastError;
    if (configured > 0 && first.port !== configured && first.port !== remembered) this.deps.remember?.set(first.port);
    const servers = [first.server];
    for (const host of hosts.slice(1)) {
      const server = this.routes.createServer(mode);
      try { await (host === '::' ? listenV6Only(server, first.port) : listenOn(server, host, first.port)); servers.push(server); } catch (error) {
        server.close();
        this.deps.log().warn('peer listener skipped an address', { host, code: codeOf(error) });
      }
    }
    return { servers, port: first.port };
  }

  /** One port; the port this listener just gave up gets a few short retries (it is still closing). */
  private async listenRetrying(host: string, port: number, mode: PeerListenMode): Promise<{ server: Server; port: number }> {
    const waits = port > 0 && port === this.lastPort ? [0, 50, 250, 1_000] : [0];
    let lastError: unknown;
    for (const wait of waits) {
      if (wait) await delay(wait, undefined, { ref: false });
      const server = this.routes.createServer(mode);
      try { return { server, port: await listenOn(server, host, port) }; } catch (error) {
        server.close();
        if (!isBusy(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Stops accepting; established peer sockets and requests in flight stay until they end. */
  private stopListening(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    void this.keeper?.stop();
    for (const server of open.servers) {
      this.draining.add(server);
      server.once('close', () => this.draining.delete(server));
      server.close();
    }
    this.deps.log().info('peer listener closed', { port: open.port });
  }

  private fail(mode: PeerListenMode, key: string, code: string): void {
    this.failedKey = key;
    this.set({ status: 'error', mode, error: code });
  }

  private set(next: Omit<PeerListenerState, 'addresses'>): void {
    const before = this.current;
    this.current = next;
    if (before.status === next.status && before.mode === next.mode && before.port === next.port && before.error === next.error) return;
    this.announce();
  }

  /** Tells the change listeners the current state (the self device row and the linked PCs follow). */
  private announce(): void {
    const state = this.state();
    for (const listener of this.changeListeners) {
      try { listener(state); } catch (error) { this.deps.log().warn('peer listener change hook failed', { error: errorText(error) }); }
    }
  }

  private config(): { mode: PeerMode; port: number } {
    try {
      const { mode, port } = this.deps.config();
      const valid = mode === 'lan' || mode === 'tailscale' || mode === 'off';
      return { mode: valid ? mode : 'lan', port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_PEER_PORT };
    } catch {
      return { mode: 'off', port: DEFAULT_PEER_PORT }; // settings unreadable: stay closed
    }
  }
}
