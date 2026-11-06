// QR codes as data URLs (pairing links for PCs, PWA links).
// Owns: the one place that loads the `qrcode` package (lazily, it is only needed while
// a pairing dialog is open). Never: logs the encoded text (it contains one-time secrets).

import { createRequire } from 'node:module';

type QrModule = { toDataURL(text: string, options: Record<string, unknown>): Promise<string> };

let cached: QrModule | undefined;

export async function qrDataUrl(text: string): Promise<string> {
  // `qrcode` is CommonJS without bundled types; require keeps the import untyped but contained.
  cached ??= createRequire(import.meta.url)('qrcode') as QrModule;
  return cached.toDataURL(text, { width: 320, margin: 4, errorCorrectionLevel: 'M' });
}
