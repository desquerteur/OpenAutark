// Wireless debugging over ADB: pairing with the phone's 6-digit code, connecting to and
// disconnecting from a paired phone, and the phones announcing themselves nearby (`adb mdns
// services`). A USB phone without a pairing code (Android 10 and older) goes over Wi-Fi with
// `adb tcpip 5555` in the agent's shell (skill phone-adb).
// Owns: validation of host:port and the pairing code, the fixed argument arrays, reading adb's
// answers into results or clear errors, pair-then-connect (the connect port found nearby) and
// which nearby phones are not connected yet. AdbPhone (adb.ts) runs these with its own adb.
// Never: runs adb through a shell, puts the pairing code into an error, a log or a result, or
// pairs/connects to anything but a validated host:port.

import { WorkforceError } from '../../shared/errors.ts';
import type { NearbyPhone } from '../../shared/model/phone.ts';
import type { ExecResult } from './adb-exec.ts';

/** AdbPhone's runner: adb with these arguments (no shell); `allowFailure` returns a non-zero exit. */
export type AdbRun = (args: string[], options: { timeoutMs: number; maxBytes?: number; allowFailure?: boolean }) => Promise<ExecResult>;

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
/** The serial adb gives a phone it connected to through mDNS ("adb-R58N123-AbCdEf._adb-tls-connect._tcp"). */
const MDNS_SERIAL = /^adb-[A-Za-z0-9-]{1,100}\._adb-tls-connect\._tcp\.?$/;
const ADDRESS_HINT = 'Give the IP address and port shown on the phone, like 192.168.1.20:37099.';

/** Validated `host:port` ("192.168.1.20:37099", "pixel.tailnet.ts.net:5555", "[fd7a::1]:5555"). */
export function parseAddress(value: string): { host: string; port: number; address: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 260) throw new WorkforceError('bad_request', ADDRESS_HINT);
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw);
  const plain = bracketed ? null : /^([^:\s]+):(\d{1,5})$/.exec(raw);
  const host = bracketed?.[1] ?? plain?.[1];
  const port = Number(bracketed?.[2] ?? plain?.[2]);
  const hostOk = host !== undefined && (bracketed ? IPV6.test(host) && host.split(':').length >= 3 : IPV4.test(host) || (HOSTNAME.test(host) && !/^\d+(\.\d+)*$/.test(host)));
  if (!hostOk || !Number.isInteger(port) || port < 1 || port > 65_535) throw new WorkforceError('bad_request', ADDRESS_HINT);
  return { host: host!, port, address: bracketed ? `[${host}]:${port}` : `${host}:${port}` };
}

/** The 6-digit code from "Pair device with pairing code" (spaces and dashes are ignored). */
export function parseCode(value: string): string {
  const code = typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
  if (!/^\d{6}$/.test(code)) throw new WorkforceError('bad_request', 'The pairing code has 6 digits (shown in "Pair device with pairing code" on the phone).');
  return code;
}

/** True for a phone adb reaches over Wi-Fi (host:port or an mDNS serial), false for USB/emulators. */
export function isWireless(serial: string): boolean {
  if (MDNS_SERIAL.test(serial)) return true;
  try { parseAddress(serial); return true; } catch { return false; }
}

/** Parses `adb mdns services`: "<name>\t_adb-tls-pairing._tcp\t192.168.1.20:41235" per line. */
export function parseMdns(output: string): NearbyPhone[] {
  const out: NearbyPhone[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [name, type, address] = [parts[0], parts[1].replace(/\.$/, ''), parts[parts.length - 1]];
    const service = type === '_adb-tls-pairing._tcp' ? 'pairing' : type === '_adb-tls-connect._tcp' || type === '_adb._tcp' ? 'connect' : undefined;
    if (!service || !/^[\w.-]{1,120}$/.test(name)) continue;
    let target: string;
    try { target = parseAddress(address).address; } catch { continue; }
    const key = `${service} ${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, service, address: target });
  }
  return out;
}

function said(result: ExecResult, hide?: string): string {
  const all = `${Buffer.from(result.stdout).toString('utf8')}\n${result.stderr}`;
  return (hide ? all.split(hide).join('••••••') : all).trim();
}

/** The last line adb wrote, short (for errors that name the cause). */
function lastLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? '';
}

const unreachable = (address: string) => new WorkforceError('unavailable', `Could not reach the phone at ${address}. Check that it is on the same network or tailnet as this PC and that wireless debugging is on.`);

/** `adb pair host:port code`. The code is valid only while the phone shows the pairing dialog. */
export async function pairPhone(run: AdbRun, address: string, code: string): Promise<{ address: string; name?: string }> {
  const target = parseAddress(address);
  const pin = parseCode(code);
  const out = said(await run(['pair', target.address, pin], { timeoutMs: 30_000, allowFailure: true }), pin);
  if (/Successfully paired/i.test(out)) return { address: target.address, name: /guid=([\w.-]+)/.exec(out)?.[1] };
  if (/wrong password|incorrect|protocol fault/i.test(out)) {
    throw new WorkforceError('bad_request', 'The phone did not accept the pairing code. Codes work only while "Pair device with pairing code" is open on the phone – open it again and use the new code and port.');
  }
  if (/unable to start pairing|refused|timed out|unreachable|no route|cannot connect|failed to connect|10061|10060/i.test(out)) {
    throw new WorkforceError('unavailable', `Could not reach the pairing dialog at ${target.address}. Use the IP address and port shown in "Pair device with pairing code" (not the one under Wireless debugging), and keep the dialog open.`);
  }
  throw new WorkforceError('unavailable', `Pairing with ${target.address} did not complete${lastLine(out) ? `: ${lastLine(out)}` : ''}.`);
}

/** `adb connect host:port` to a paired phone; `already` when adb was connected before. */
export async function connectPhone(run: AdbRun, address: string): Promise<{ address: string; already: boolean }> {
  const target = parseAddress(address);
  const out = said(await run(['connect', target.address], { timeoutMs: 20_000, allowFailure: true }));
  if (/already connected to/i.test(out)) return { address: target.address, already: true };
  if (/^\s*connected to /im.test(out)) return { address: target.address, already: false };
  if (/authenticate|unauthorized/i.test(out)) {
    throw new WorkforceError('unavailable', `The phone at ${target.address} did not accept this PC. Pair it first with the code from "Pair device with pairing code".`);
  }
  if (/refused|timed out|unreachable|no route|10061|10060|cannot connect|unable to connect/i.test(out)) {
    throw new WorkforceError('unavailable', `Could not connect to ${target.address}. Wireless debugging ports change after a restart – use the IP address and port shown under Wireless debugging on the phone.`);
  }
  if (/failed to resolve|unknown host|no such host/i.test(out)) throw unreachable(target.address);
  throw new WorkforceError('unavailable', `Could not connect to ${target.address}${lastLine(out) ? `: ${lastLine(out)}` : ''}.`);
}

/** `adb disconnect <serial>` for a phone on wireless debugging; `was` false when it was not connected. */
export async function disconnectPhone(run: AdbRun, serial: string): Promise<{ serial: string; was: boolean }> {
  const value = typeof serial === 'string' ? serial.trim() : '';
  const target = MDNS_SERIAL.test(value) ? value : (() => {
    try { return parseAddress(value).address; } catch { throw new WorkforceError('bad_request', 'Only phones on wireless debugging can be disconnected here (unplug a USB cable instead).'); }
  })();
  const out = said(await run(['disconnect', target], { timeoutMs: 15_000, allowFailure: true }));
  if (/no such device|not connected/i.test(out)) return { serial: target, was: false };
  if (/disconnected/i.test(out)) return { serial: target, was: true };
  throw new WorkforceError('unavailable', `Could not disconnect ${target}${lastLine(out) ? `: ${lastLine(out)}` : ''}.`);
}

/** Phones announcing wireless debugging nearby; empty when this adb has no mDNS support. */
export async function discoverPhones(run: AdbRun): Promise<NearbyPhone[]> {
  const result = await run(['mdns', 'services'], { timeoutMs: 10_000, allowFailure: true });
  if (result.code !== 0) return [];
  return parseMdns(Buffer.from(result.stdout).toString('utf8'));
}


/** Nearby services that are not connected already (by address or adb's mDNS serial). */
export function notConnected(nearby: NearbyPhone[], phones: Array<{ serial: string }>): NearbyPhone[] {
  const serials = new Set(phones.map((phone) => phone.serial.replace(/\.$/, '')));
  return nearby.filter((item) => item.service === 'pairing' || !(serials.has(item.address) || serials.has(`${item.name}._adb-tls-connect._tcp`)));
}

interface Wireless {
  pair(address: string, code: string): Promise<{ address: string; name?: string }>;
  discover(): Promise<NearbyPhone[]>;
  connect(address: string): Promise<{ address: string; already: boolean }>;
}

/**
 * Pairs, then connects: the connect port differs from the pairing port, so `connect` when given,
 * else the phone's connect service found nearby on the same host. A failed connect after a
 * successful pairing is reported in `connectError`, not thrown (the pairing stays).
 */
export async function pairThenConnect(adb: Wireless, input: { address: string; code: string; connect?: string }): Promise<{ paired: string; connected?: string; connectError?: string }> {
  const connectTo = input.connect ? parseAddress(input.connect).address : undefined; // a typo fails before pairing
  const paired = await adb.pair(input.address, input.code);
  let target = connectTo;
  if (!target) {
    const host = parseAddress(paired.address).host;
    const nearby = await adb.discover().catch(() => []);
    target = nearby.find((item) => item.service === 'connect' && hostOf(item.address) === host)?.address;
  }
  if (!target) return { paired: paired.address, connectError: 'The phone did not announce its connect port. Use the IP address and port shown under Wireless debugging.' };
  try {
    return { paired: paired.address, connected: (await adb.connect(target)).address };
  } catch (error) {
    return { paired: paired.address, connectError: error instanceof Error ? error.message : String(error) };
  }
}

function hostOf(address: string): string | undefined {
  try { return parseAddress(address).host; } catch { return undefined; }
}
