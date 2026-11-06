// The team's receiver shipped with the build (B-055 Q2/Q3): resources/feedback/receiver.json
// { publicKey, project, apiKey } – the team's X25519 public key, the Firebase project of the write-only mailbox and
// its web API key (public by design: the Firestore rule allows only creating a sealed letter). `wf feedback setup`
// writes it; absent or invalid means "sending is not set up" and reports stay on this PC.
// Tests (an unpackaged app only): WORKFORCE_FEEDBACK_RECEIVER names another receiver file, and a receiver may carry
// `endpoint`, a loopback origin a local fake mailbox answers on – never another host.
// Owns: reading, checking and writing that file. Never: private keys or the service account (the vault holds them).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { checkPublicKey } from './seal.ts';
import { loopbackOrigin } from './transport.ts';

export const RECEIVER_FILE = 'receiver.json';
export const RULES_FILE = 'firestore.rules';

export interface ReceiverConfig {
  publicKey: string;
  project: string;
  apiKey: string;
  /** Tests only: a loopback origin standing in for Google. */
  endpoint?: string;
}

/** Firebase project ids: 6–30 characters, lower-case letters, digits and hyphens, starting with a letter. */
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** Google web API keys ("AIza…", 39 characters); a little room for other key shapes. */
export const API_KEY = /^[A-Za-z0-9_-]{20,100}$/;

/** The receiver in `value`, or undefined when anything is missing or malformed. */
export function checkReceiver(value: unknown): ReceiverConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.project !== 'string' || !PROJECT_ID.test(o.project)) return undefined;
  if (typeof o.apiKey !== 'string' || !API_KEY.test(o.apiKey)) return undefined;
  try { checkPublicKey(String(o.publicKey)); } catch { return undefined; }
  const endpoint = o.endpoint === undefined ? undefined : loopbackOrigin(o.endpoint);
  if (o.endpoint !== undefined && !endpoint) return undefined;
  return { publicKey: String(o.publicKey), project: o.project, apiKey: o.apiKey, ...(endpoint ? { endpoint } : {}) };
}

/** The shipped folder resources/feedback. */
export function feedbackResources(s: Pick<RuntimeServices, 'paths'>): string {
  return path.join(s.paths.resources, 'feedback');
}

/** Where this app reads its receiver: the shipped file, or (unpackaged only) WORKFORCE_FEEDBACK_RECEIVER. */
export function receiverPath(s: Pick<RuntimeServices, 'paths' | 'host'>): string {
  const override = !s.host.app.packaged ? process.env.WORKFORCE_FEEDBACK_RECEIVER : undefined;
  return override ? path.resolve(override) : path.join(feedbackResources(s), RECEIVER_FILE);
}

/** The receiver this build sends to, or undefined (not set up). Read on each use: the file is tiny and rarely asked for. */
export function readReceiver(s: Pick<RuntimeServices, 'paths' | 'host'>): ReceiverConfig | undefined {
  let text: string;
  try { text = readFileSync(receiverPath(s), 'utf8'); } catch { return undefined; }
  if (!text.trim()) return undefined;
  try { return checkReceiver(JSON.parse(text)); } catch { return undefined; }
}

/** Writes the receiver file (atomically: a half-written file is never read); `endpoint` only for a local test fake. */
export function writeReceiver(file: string, config: ReceiverConfig): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const value = { publicKey: config.publicKey, project: config.project, apiKey: config.apiKey, ...(config.endpoint ? { endpoint: config.endpoint } : {}) };
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
  return file;
}
