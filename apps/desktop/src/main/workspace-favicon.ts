// A personal tab's favicon as a small data: picture for the pane's tab strip – the app's page shows only data: and
// blob: pictures. Read through the tab's own session (the page loaded it already, so it usually comes from its
// cache), within 5 s and 256 KiB; a bitmap is scaled to 32 px, a format Electron cannot decode (an .ico) or an SVG
// passes as it is when small.
// Owns: reading and shrinking the icon. Never: keeps it, reads the page or sends cookies elsewhere.

import { nativeImage, type Session } from 'electron';

const MAX_BYTES = 256 * 1024;
/** Largest icon passed through undecoded (SVG, .ico). */
const MAX_PLAIN = 24 * 1024;
const SIZE = 32;

function shrink(type: string, bytes: Buffer): string | undefined {
  if (!/^image\//i.test(type) || bytes.length === 0 || bytes.length > MAX_BYTES) return undefined;
  if (!/svg/i.test(type)) {
    const image = nativeImage.createFromBuffer(bytes);
    if (!image.isEmpty()) return (image.getSize().width > SIZE ? image.resize({ width: SIZE, height: SIZE, quality: 'best' }) : image).toDataURL();
  }
  return bytes.length <= MAX_PLAIN ? `data:${type.toLowerCase()};base64,${bytes.toString('base64')}` : undefined;
}

function fromDataUrl(url: string): string | undefined {
  const match = /^data:(image\/[\w.+-]+)(;base64)?,(.*)$/is.exec(url);
  if (!match) return undefined;
  const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return shrink(match[1], bytes);
}

/** The body up to MAX_BYTES (a page names its icon, so a huge or endless one is cut off, never held whole). */
async function capped(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    size += value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); return undefined; }
    parts.push(value);
  }
}

async function one(session: Session, url: string): Promise<string | undefined> {
  if (/^data:/i.test(url)) return fromDataUrl(url);
  if (!/^https?:\/\//i.test(url)) return undefined;
  const response = await session.fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return undefined;
  const declared = Number(response.headers.get('content-length') ?? 0);
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (declared > MAX_BYTES || !/^image\//i.test(type)) { void response.body?.cancel().catch(() => {}); return undefined; }
  const bytes = await capped(response);
  return bytes ? shrink(type, bytes) : undefined;
}

/** The first of the page's icons that reads as a picture, or undefined. */
export async function faviconData(session: Session, urls: readonly string[]): Promise<string | undefined> {
  for (const url of urls.slice(0, 3)) {
    try {
      const data = await one(session, url);
      if (data) return data;
    } catch { /* the next one, or none */ }
  }
  return undefined;
}
