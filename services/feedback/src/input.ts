// Owns: bounded, validated submissions and non-content receipts. Never: remote URLs from a sender.
import type { Payload, StoredReport } from './types.ts';
import { FEEDBACK_IMAGE_LIMIT } from '../../../apps/desktop/src/shared/model/feedback-delivery.ts';

export const MAX_IMAGE_BYTES = FEEDBACK_IMAGE_LIMIT;
export const MAX_REQUEST_BYTES = 1_500_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function receipt(row: StoredReport): Response {
  const payload = JSON.parse(row.payload) as Payload;
  return json({ receiptId: row.id, state: row.state === 'sent' ? 'sent' : 'received',
    ...(row.state === 'sent' && payload.visibility === 'public' && row.url ? { url: row.url } : {}) }, row.state === 'sent' ? 200 : 202);
}

export async function parse(request: Request): Promise<Payload> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Use JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing report.');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('Report too large.'); }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  const p = JSON.parse(new TextDecoder().decode(bytes)) as Payload;
  if (!p || Object.keys(p).some((key) => !['requestId', 'visibility', 'title', 'body', 'image'].includes(key))) throw new Error('Invalid report.');
  if (typeof p.requestId !== 'string' || !UUID.test(p.requestId)) throw new Error('Invalid receipt id.');
  if (p.visibility !== 'private' && p.visibility !== 'public') throw new Error('Choose private or public.');
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200 || /[\r\n]/.test(p.title)) throw new Error('Invalid title.');
  if (typeof p.body !== 'string' || !p.body.trim() || p.body.length > 40_000) throw new Error('Invalid report text.');
  if (p.image) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(p.image.mime) || typeof p.image.base64 !== 'string' ||
      p.image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.image.base64)) throw new Error('Invalid screenshot.');
    const image = Uint8Array.from(atob(p.image.base64), (c) => c.charCodeAt(0));
    if (image.length > MAX_IMAGE_BYTES) throw new Error('Screenshot too large.');
    const png = image[0] === 137 && String.fromCharCode(...image.slice(1, 4)) === 'PNG';
    const jpeg = image[0] === 255 && image[1] === 216 && image[2] === 255;
    const webp = String.fromCharCode(...image.slice(0, 4)) === 'RIFF' && String.fromCharCode(...image.slice(8, 12)) === 'WEBP';
    if (!(p.image.mime === 'image/png' ? png : p.image.mime === 'image/jpeg' ? jpeg : webp)) throw new Error('Invalid screenshot format.');
  }
  return p;
}
