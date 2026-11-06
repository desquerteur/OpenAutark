// The file name of a dictation take (lib/dictation.ts).
// Owns: that name. Never: records, uploads or reads the clock itself.

const EXTENSIONS: Record<string, string> = { 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * "Dictation 2026-10-20 09-30.webm" in the phone's own time (an attached take shows this name;
 * no ':' – the store would turn it into '_'); the extension follows the recorder's format
 * (Safari records mp4).
 */
export function takeName(mime: string, at: Date): string {
  const extension = EXTENSIONS[mime.split(';')[0].trim().toLowerCase()] ?? 'webm';
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `Dictation ${day} ${pad(at.getHours())}-${pad(at.getMinutes())}.${extension}`;
}
