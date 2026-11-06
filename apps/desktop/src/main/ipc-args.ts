// Argument validation for the desktop IPC channels (renderer input is untrusted even from our
// own page: a compromised renderer must not reach more than the typed API allows).
// Owns: one parser per argument kind (returns the value or throws IpcArgError) and the error →
// IpcResult mapping. Never: performs the action, imports electron.

import type { IpcResult, PickKind } from '../shared/api/desktop.ts';
import { WorkforceError } from '../shared/errors.ts';
import type { MediaKind } from './security.ts';

export class IpcArgError extends Error {
  constructor(name: string) {
    super(`Invalid ${name}.`);
    this.name = 'IpcArgError';
  }
}

const PICK_KINDS: readonly PickKind[] = ['files', 'folder', 'images', 'audio', 'video'];
const BLOB_ID = /^[0-9a-f]{64}$/;
export const MAX_CLIPBOARD = 1_000_000;

export function pickKind(value: unknown): PickKind {
  if (typeof value !== 'string' || !(PICK_KINDS as readonly string[]).includes(value)) throw new IpcArgError('file kind');
  return value as PickKind;
}

export function mediaKinds(value: unknown): MediaKind[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) throw new IpcArgError('media kinds');
  const kinds = new Set<MediaKind>();
  for (const item of value) {
    if (item !== 'audio' && item !== 'video') throw new IpcArgError('media kinds');
    kinds.add(item);
  }
  return [...kinds];
}

/** FileRef ids are sha256 hex. */
export function fileId(value: unknown): string {
  if (typeof value !== 'string' || !BLOB_ID.test(value)) throw new IpcArgError('file');
  return value;
}

export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new IpcArgError('flag');
  return value;
}

export function optionalFlag(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return flag(value);
}

export function clipboardText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_CLIPBOARD || value.includes('\0')) throw new IpcArgError('text');
  return value;
}

export function requestId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new IpcArgError('request');
  return value as number;
}

/** Error → user-safe IPC error. Our own sentences pass; system errors (errno) stay generic. */
export function ipcFailure(error: unknown): IpcResult<never> {
  if (error instanceof WorkforceError) return { ok: false, error: { code: error.code, message: error.message } };
  if (error instanceof IpcArgError) return { ok: false, error: { code: 'bad_request', message: error.message } };
  if (error instanceof Error && error.message && !(error as NodeJS.ErrnoException).syscall && typeof (error as NodeJS.ErrnoException).errno !== 'number') {
    return { ok: false, error: { code: 'internal', message: error.message.slice(0, 300) } };
  }
  return { ok: false, error: { code: 'internal', message: 'The app could not do this.' } };
}
