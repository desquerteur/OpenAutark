// What the iPhone web app keeps (B-078 follow-up), in its own IndexedDB 'autark-hosted' (the PC UI keeps its own
// 'workforce-pwa' and the token in localStorage 'wf.token'): 'identity' – the phone's Ed25519 key as a non-extractable
// CryptoKey (IndexedDB structured-clones it; its bytes never reach script) with the raw public key and the device id;
// 'pairing' – the meeting server, the device token and the PCs it pins; 'ui' – the PC UI's entry files from the last
// marker check, so a start without a tunnel boots from the service worker's copy. The key is stored only after Accept;
// before Connect, keepsKeys() round-trips a throwaway key ('probe', removed again) to prove the browser can.
// The backend is injectable (tests use memoryBackend).
// Owns: these records and their checks. Never: sends them anywhere, or keeps a key that does not match its public half.

import type { PhonePc } from '../../shared/api/methods-phone.ts';
import { b64url, fromB64url, utf8 } from './bytes.ts';
import { newDeviceKey, sign, verify, type DeviceKey } from './crypto.ts';

export const DB_NAME = 'autark-hosted';
const STORE = 'kv';
const PROBE = 'probe';

export interface Backend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * True when this browser keeps a non-extractable Ed25519 key in `backend` and it still signs afterwards: checked with a
 * throwaway key before Connect, so a storage problem (private browsing, WebKit refusing the CryptoKey) shows before a
 * PC issues a token.
 */
export async function keepsKeys(backend: Backend): Promise<boolean> {
  try {
    const key = await newDeviceKey();
    await backend.set(PROBE, { privateKey: key.privateKey });
    const back = (await backend.get(PROBE)) as { privateKey?: CryptoKey } | undefined;
    await backend.remove(PROBE);
    if (!back?.privateKey) return false;
    const data = utf8('autark-hosted-probe');
    return await verify(key.pub, data, await sign(back.privateKey, data));
  } catch {
    return false;
  }
}

export interface HostedIdentity { privateKey: CryptoKey; pub: string; deviceId: string }
export interface HostedPairing { relay: string; token: string; pcs: PhonePc[]; pairedAt: number }
export interface HostedUi { css: string; js: string }
export interface Saved { key: DeviceKey; deviceId: string; relay: string; token: string; pcs: PhonePc[] }

export function memoryBackend(): Backend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, value); },
    remove: async (key) => { data.delete(key); },
    clear: async () => { data.clear(); },
  };
}

interface IdbRequest<T> { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null }
interface IdbFactory {
  open(name: string, version: number): IdbRequest<IdbDb> & { onupgradeneeded: (() => void) | null };
  deleteDatabase(name: string): IdbRequest<unknown>;
}
interface IdbDb {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: 'readonly' | 'readwrite'): { objectStore(name: string): IdbObjectStore; oncomplete: (() => void) | null; onerror: (() => void) | null };
}
interface IdbObjectStore { get(key: string): IdbRequest<unknown>; put(value: unknown, key: string): IdbRequest<unknown>; delete(key: string): IdbRequest<unknown>; clear(): IdbRequest<unknown> }

const done = <T>(request: IdbRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/** The browser's IndexedDB under DB_NAME. */
export function idbBackend(factory = (globalThis as { indexedDB?: IdbFactory }).indexedDB): Backend {
  if (!factory) throw new Error('This browser keeps no data for web apps (IndexedDB is off).');
  let db: Promise<IdbDb> | undefined;
  const open = () => (db ??= new Promise<IdbDb>((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
  const store = async (mode: 'readonly' | 'readwrite') => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    get: async (key) => done((await store('readonly')).get(key)),
    set: async (key, value) => { await done((await store('readwrite')).put(value, key)); },
    remove: async (key) => { await done((await store('readwrite')).delete(key)); },
    clear: async () => { await done((await store('readwrite')).clear()); },
  };
}

const validPc = (row: unknown): row is PhonePc => {
  const pc = row as Partial<PhonePc> | null;
  return Boolean(pc && typeof pc.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(pc.fingerprint) && typeof pc.publicKey === 'string' && typeof pc.name === 'string');
};

export class HostedStore {
  private readonly backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  /** The paired state, or undefined (never paired, cleared, or a record that does not hold together). */
  async load(): Promise<Saved | undefined> {
    const identity = (await this.backend.get('identity')) as Partial<HostedIdentity> | undefined;
    const pairing = (await this.backend.get('pairing')) as Partial<HostedPairing> | undefined;
    if (!identity?.privateKey || typeof identity.pub !== 'string' || typeof identity.deviceId !== 'string') return undefined;
    if (!pairing || typeof pairing.relay !== 'string' || typeof pairing.token !== 'string' || !Array.isArray(pairing.pcs)) return undefined;
    let pub;
    try { pub = fromB64url(identity.pub); } catch { return undefined; }
    if (pub.length !== 32) return undefined;
    const pcs = pairing.pcs.filter(validPc).slice(0, 16);
    if (!pcs.length) return undefined;
    return { key: { privateKey: identity.privateKey, pub }, deviceId: identity.deviceId, relay: pairing.relay, token: pairing.token, pcs };
  }

  /** After Accept: the key, the token and the first PC. */
  async save(saved: Saved, now = Date.now()): Promise<void> {
    await this.backend.set('identity', { privateKey: saved.key.privateKey, pub: b64url(saved.key.pub), deviceId: saved.deviceId } satisfies HostedIdentity);
    await this.backend.set('pairing', { relay: saved.relay, token: saved.token, pcs: saved.pcs, pairedAt: now } satisfies HostedPairing);
  }

  /** phone.pcs gave a new list (the PC this phone reaches is always kept). */
  async savePcs(pcs: PhonePc[]): Promise<void> {
    const pairing = (await this.backend.get('pairing')) as HostedPairing | undefined;
    if (!pairing) return;
    await this.backend.set('pairing', { ...pairing, pcs: pcs.filter(validPc).slice(0, 16) });
  }

  async ui(): Promise<HostedUi | undefined> {
    const ui = (await this.backend.get('ui')) as Partial<HostedUi> | undefined;
    return ui && typeof ui.css === 'string' && typeof ui.js === 'string' ? { css: ui.css, js: ui.js } : undefined;
  }

  async saveUi(ui: HostedUi): Promise<void> { await this.backend.set('ui', ui); }

  async clear(): Promise<void> { await this.backend.clear(); }
}

/** The PC UI's stylesheet and module script from its index.html, or undefined when it lacks the hosted marker (an older PC). */
export function pcEntry(html: string): HostedUi | undefined {
  if (!/<meta\s+name=["']autark-hosted["']\s+content=["']1["']/i.test(html)) return undefined;
  const css = /<link\s+rel=["']stylesheet["']\s+href=["']([^"'/:][^"':]*)["']/i.exec(html)?.[1] ?? 'main.css';
  const js = /<script\s+type=["']module["']\s+src=["']([^"'/:][^"':]*)["']/i.exec(html)?.[1] ?? 'main.js';
  return { css, js };
}

/** The PCs phone.pcs (or storage) lists, in order; rows that do not hold together are skipped. */
export function pcsOf(value: unknown): PhonePc[] {
  return Array.isArray(value) ? value.filter(validPc).slice(0, 16).map((pc) => ({ deviceId: String(pc.deviceId ?? ''), name: pc.name, fingerprint: pc.fingerprint, publicKey: pc.publicKey })) : [];
}
