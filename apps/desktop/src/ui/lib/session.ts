// What this connection may do: the `session.info` answer (owner or device, its capabilities,
// whether the transport is secure, the exact methods the server allows), loaded by
// store.loadAll() first on every (re)connect – before the snapshots, which ask only for what
// `can()` allows. Views gate their controls with `can(method)` instead of guessing from the
// platform; controls a device may not use are hidden, or shown read-only with one calm note.
// Until the first answer (and when it fails) the desktop window counts as the owner and a
// phone/browser as allowed nothing, so the desktop view never changes and a phone never shows a
// control that would be refused.
// X02: browser methods need HTTPS for 'todo' devices too.
// Owns: the session signal, can()/secure and the gating notes.
// Never: grants anything (the runtime checks every call) or reaches the transport itself –
// `loadSession` gets the call injected.

import { computed, signal } from '@preact/signals';
import type { MethodName, SessionInfo } from '../../shared/api/methods.ts';
import type { DeviceCapability } from '../../shared/api/protocol.ts';
import { platform } from './platform.ts';

/** The last `session.info` answer of this connection; null before it (or when it failed). */
export const session = signal<SessionInfo | null>(null);

const allowed = computed(() => new Set<string>(session.value?.allowedMethods ?? []));

/** Before the first answer: the desktop window is the owner, a phone/browser may do nothing yet. */
const assumeOwner = platform === 'desktop';

function isSessionInfo(value: unknown): value is SessionInfo {
  const info = value as Partial<SessionInfo> | null;
  return typeof info === 'object' && info !== null && (info.kind === 'owner' || info.kind === 'device' || info.kind === 'person') // person: F-52
    && Array.isArray(info.allowedMethods) && Array.isArray(info.capabilities);
}

/**
 * Asks the runtime who this connection is. A failure (or an answer that is not a session) leaves
 * the conservative default (null).
 */
export async function loadSession(call: (method: 'session.info') => Promise<SessionInfo>): Promise<SessionInfo | null> {
  try {
    const info: unknown = await call('session.info');
    session.value = isSessionInfo(info) ? info : null;
  } catch {
    session.value = null;
  }
  return session.value;
}

/** True when this connection may call `method` (reactive inside components). */
export function can(method: MethodName): boolean {
  const info = session.value;
  if (!info) return assumeOwner;
  return info.kind === 'owner' || allowed.value.has(method);
}

/** The owner (desktop window, local CLI) – not a paired phone or browser. */
export function isOwner(): boolean {
  const info = session.value;
  return info ? info.kind === 'owner' : assumeOwner;
}

/** Loopback, the local HTTPS proxy or the tailnet (always true for the owner). */
export const secure = computed(() => {
  const info = session.value;
  return info ? info.kind === 'owner' || info.secure : assumeOwner;
});

/** Does this connection hold `capability`? (the owner holds all). */
export function holds(capability: DeviceCapability): boolean {
  const info = session.value;
  if (!info) return assumeOwner;
  return info.kind === 'owner' || info.capabilities.includes(capability);
}

// ------------------------------------------------------------------ notes for unavailable controls

/** Shown instead of a sensitive control on plain LAN http. */
export const HTTPS_NOTE = 'Open the HTTPS address to do this';
/** Shown next to a disabled control the phone may not use. */
export const PC_NOTE = 'Change this on your PC';

/**
 * Methods the runtime withholds on plain LAN http even from a phone holding their capability –
 * the opt-in 'permissions' tier (rpc/handlers/security.ts) and, X02, agents' browsers for 'todo'
 * devices (typed text and page pictures travel over the link). Only picks the note.
 */
const SECURE_METHODS: ReadonlyMap<MethodName, DeviceCapability> = new Map<MethodName, DeviceCapability>([
  ...(['secrets.list', 'secrets.save', 'spend.list'] as const)
    .map((method) => [method, 'permissions'] as const),
  ...(['browser.list', 'browser.pull', 'browser.pullPart', 'browser.navigate', 'browser.input', 'browser.takeover'] as const)
    .map((method) => [method, 'todo'] as const),
  ...(['secrets.groups', 'secrets.saveGroup'] as const).map((method) => [method, 'permissions'] as const), // X05
  ['secrets.import', 'permissions'], // 29.10.2026: password import
  // B-078: plans, keys and sign-ins from the phone need a secure transport (the app's tunnel or the HTTPS address)
  ...(['accounts.list', 'accounts.detect', 'accounts.add', 'accounts.update', 'accounts.login', 'accounts.logout', 'accounts.remove',
    'accounts.install', 'accounts.try', 'accounts.useReset', 'accounts.test'] as const).map((method) => [method, 'settings'] as const),
]);

/** Why a control calling `method` is unavailable here (a note), or undefined when it may be used. */
export function blockedNote(method: MethodName): string | undefined {
  if (can(method)) return undefined;
  const info = session.value;
  const needs = SECURE_METHODS.get(method);
  if (info && !info.secure && needs && info.capabilities.includes(needs)) return HTTPS_NOTE;
  return PC_NOTE;
}
