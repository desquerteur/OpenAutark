// The 6-digit code the PC shows beside the phone QR code (B-075). An iPhone keeps Safari's storage and a Home Screen
// app's apart, so a QR scanned in Safari pairs Safari, not the installed app: the app's unpaired screen
// (ui/pwa/AccessRequest.tsx) takes this code instead. A code stands for one pairing link (by its sha256), lives as long
// as that link (10 minutes) and works once; the exchange is the link's own (pwa/service.ts exchange). Shaped like the
// invite codes (people/join.ts), kept in memory as sha256 only. A right code is the owner's full access with no Allow
// step, so the limit counts guesses per code, not per minute: the open codes face MAX_WRONG_CODES wrong codes together,
// and the last of them drops every open code (at most 10 guesses against a million for any code). A stranger can make the
// PC drop its codes – the person then shows a new one (Settings › Devices again) – but never pair; the QR keeps working.
// Owns: the code map and the wrong-code limit. Never: keeps a code or a secret in plain form, or issues tokens.

import { randomInt } from 'node:crypto';
import { WorkforceError } from '../../shared/errors.ts';
import { hashToken } from './tokens.ts';

/** Wrong codes the open codes may face together; the last one drops them all. Counting starts again when none is open. */
export const MAX_WRONG_CODES = 10;

const keyOf = (code: string): string => hashToken(`pair:${code}`);

export class PairCodes {
  private readonly now: () => number;
  private readonly codes = new Map<string, { link: string; expiresAt: number }>();
  private wrong = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  /** A new code for the pairing link with this hash, valid until `expiresAt`. */
  issue(linkHash: string, expiresAt: number): string {
    this.sweep();
    let code = '';
    for (let i = 0; i < 20 && (!code || this.codes.has(keyOf(code))); i++) code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(keyOf(code), { link: linkHash, expiresAt });
    return code;
  }

  /** Six typed digits → the hash of their link (once); undefined for a wrong or expired code; rate_limited when it drops the open codes. */
  redeem(digits: string): string | undefined {
    this.sweep();
    const key = keyOf(digits);
    const entry = this.codes.get(key);
    if (entry) { this.codes.delete(key); return entry.link; }
    if (!this.codes.size || ++this.wrong < MAX_WRONG_CODES) return undefined;
    this.codes.clear();
    this.wrong = 0;
    throw new WorkforceError('rate_limited', 'Too many wrong codes. Open Settings › Devices on the PC again for a new one.');
  }

  /** Expired codes leave; with none open, the wrong codes no longer count against any. */
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(key);
    if (!this.codes.size) this.wrong = 0;
  }
}
