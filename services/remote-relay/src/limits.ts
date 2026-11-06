// Workforce remote relay: rate limits and their defaults (overridable by environment variables,
// see README.md). A token bucket refills on use (no timers); `spend` tells the caller how long to
// pause a sender that ran out (the relay pauses reading its socket instead of dropping data).
// Limits count per device key AND per client source (sourceOf: the IPv4 address, or the /64 of an
// IPv6 address) – keys are free to make, so a key alone limits nothing.
// Owns: the limit numbers, the source key and the bucket arithmetic. Never: sockets or state
// beyond one bucket.

export interface Limits {
  maxConnections: number;
  maxPerIp: number;
  /** Registrations (new device sessions) one client source may make per minute. */
  registrationsPerMinute: number;
  helloTimeoutMs: number;
  maxTunnelsPerConnection: number;
  maxPendingPairs: number;
  pairTimeoutMs: number;
  /** Control frames per second per connection (burst = 3 s worth). */
  controlPerSecond: number;
  findsPerMinute: number;
  pairsPerMinute: number;
  /** Pairing messages one device may receive per minute. */
  pairsInPerMinute: number;
  /** Tunnel bytes per second per connection (burst = 8 s worth). */
  bytesPerSecond: number;
  /** Above this, a sender waits until the receiver's send buffer drained (flow control). */
  lowBufferedBytes: number;
  /** A sender that waited this long for a receiver: that tunnel closes as too slow. */
  stallMs: number;
  /** A receiver whose send buffer exceeds this is too slow: its tunnel closes at once. */
  maxBufferedBytes: number;
  pingIntervalMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxConnections: 1000,
  maxPerIp: 10,
  registrationsPerMinute: 30,
  helloTimeoutMs: 10_000,
  maxTunnelsPerConnection: 32,
  maxPendingPairs: 8,
  pairTimeoutMs: 75_000,
  controlPerSecond: 20,
  findsPerMinute: 10,
  pairsPerMinute: 30,
  pairsInPerMinute: 60,
  bytesPerSecond: 512 * 1024,
  lowBufferedBytes: 1024 * 1024,
  stallMs: 20_000,
  maxBufferedBytes: 16 * 1024 * 1024,
  pingIntervalMs: 30_000,
};

const ENV: Record<keyof Limits, string> = {
  maxConnections: 'RELAY_MAX_CONNECTIONS',
  maxPerIp: 'RELAY_MAX_PER_IP',
  registrationsPerMinute: 'RELAY_REGISTRATIONS_PER_MINUTE',
  helloTimeoutMs: 'RELAY_HELLO_TIMEOUT_MS',
  maxTunnelsPerConnection: 'RELAY_MAX_TUNNELS',
  maxPendingPairs: 'RELAY_MAX_PENDING_PAIRS',
  pairTimeoutMs: 'RELAY_PAIR_TIMEOUT_MS',
  controlPerSecond: 'RELAY_CONTROL_PER_SECOND',
  findsPerMinute: 'RELAY_FINDS_PER_MINUTE',
  pairsPerMinute: 'RELAY_PAIRS_PER_MINUTE',
  pairsInPerMinute: 'RELAY_PAIRS_IN_PER_MINUTE',
  bytesPerSecond: 'RELAY_BYTES_PER_SECOND',
  lowBufferedBytes: 'RELAY_LOW_BUFFERED_BYTES',
  stallMs: 'RELAY_STALL_MS',
  maxBufferedBytes: 'RELAY_MAX_BUFFERED_BYTES',
  pingIntervalMs: 'RELAY_PING_INTERVAL_MS',
};

/** Defaults with positive integer overrides from the environment (invalid values are ignored). */
export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  const out: Limits = { ...DEFAULT_LIMITS };
  for (const name of Object.keys(ENV) as Array<keyof Limits>) {
    const value = Number(env[ENV[name]]);
    if (Number.isInteger(value) && value > 0) out[name] = value;
  }
  return out;
}

/**
 * The key per-address limits count under: an IPv4 address as is (IPv4-mapped IPv6 unwrapped), an
 * IPv6 address as its /64 (one customer line usually gets a whole /64, so single addresses are free).
 */
export function sourceOf(address: string): string {
  const plain = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '').toLowerCase().slice(0, 64);
  if (!plain.includes(':')) return plain;
  const [head, tail] = plain.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

/** Token bucket: `rate` tokens per second, at most `burst`; refilled lazily from the clock. */
export class Bucket {
  private tokens: number;
  private at: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(rate: number, burst: number, now: () => number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.at = now();
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
  }

  /** Takes `cost` tokens if there are enough; false otherwise (nothing taken). */
  take(cost = 1): boolean {
    this.refill();
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Takes `cost` even into debt; returns how long the caller should wait before more (0 = none). */
  spend(cost: number): number {
    this.refill();
    this.tokens -= cost;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

/** Per-minute buckets keyed by a string (a device key or a client source), forgotten when the map grows too big. */
export class KeyedBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number) {
    this.perMinute = perMinute;
    this.now = now;
  }

  take(key: string): boolean {
    if (this.buckets.size > 10_000) this.buckets.clear(); // bounded memory under a flood of keys
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = new Bucket(this.perMinute / 60, this.perMinute, this.now); this.buckets.set(key, bucket); }
    return bucket.take();
  }

  /** Takes one token under every key, or none at all (false) when one of them is empty. */
  takeAll(keys: readonly string[]): boolean {
    for (const key of keys) if (!this.peek(key)) return false;
    for (const key of keys) this.take(key);
    return true;
  }

  private peek(key: string): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return true;
    if (!bucket.take()) return false;
    bucket.spend(-1); // give the probing token back
    return true;
  }

  forget(key: string): void { this.buckets.delete(key); }
}
