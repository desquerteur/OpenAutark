// What a phone socket's close means (DEV4): 4401 = token refused, this device is no longer paired,
// 4403 = this phone was removed; App.tsx shows the two apart. The runtime closes the live socket
// of a removed phone with 4403 but refuses every later Hello of that token with 4401, so on its
// own a removed phone would say "no longer paired" after the first reconnect and after every
// reload. This module therefore remembers, per token, that the runtime revoked it and keeps
// reading a later 4401 for that same token as 4403 – across reconnects (memory) and reloads
// (localStorage 'wf.revoked'). Another token (the phone was paired again) starts clean.
// Owns: close code → refusal and the revoked marker. Never: stores the token or anything that
// can stand in for it (the marker is a 32-bit fingerprint), touches the socket or app state.

export type Refusal = 4401 | 4403;

export const REVOKED_KEY = 'wf.revoked';

/** The few Storage members used (localStorage in the app, a fake in tests). */
export interface MarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** FNV-1a (32 bit) of the token as hex: tells two tokens apart; useless to authenticate with. */
export function tokenMark(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function pageStorage(): MarkStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export class RefusalMemory {
  private readonly storage: () => MarkStorage | null;
  /** Kept as well, for a page whose storage is blocked. */
  private mark: string | null = null;

  constructor(storage: () => MarkStorage | null = pageStorage) {
    this.storage = storage;
  }

  /** The refusal a close with `code` means for the socket that sent `token`; null for any other close. */
  closed(code: number, token: string): Refusal | null {
    if (code === 4403) {
      if (token) this.write(tokenMark(token));
      return 4403;
    }
    if (code !== 4401) return null;
    return token && this.read() === tokenMark(token) ? 4403 : 4401;
  }

  /** The runtime answered: the token in use works, so no revoked marker is needed any more. */
  answered(): void {
    this.write(null);
  }

  private read(): string | null {
    try {
      const stored = this.storage()?.getItem(REVOKED_KEY);
      if (stored) return stored;
    } catch { /* storage blocked: memory only */ }
    return this.mark;
  }

  private write(mark: string | null): void {
    this.mark = mark;
    try {
      const storage = this.storage();
      if (mark) storage?.setItem(REVOKED_KEY, mark);
      else storage?.removeItem(REVOKED_KEY);
    } catch { /* storage blocked: memory only */ }
  }
}
