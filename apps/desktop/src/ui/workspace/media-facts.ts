// Pure helpers of the pane's Media and Video tabs: how a stored file is shown (image, video, audio,
// PDF or any other file, from its type and name) and its one-line facts ("1280×720 · 0:42 · 3.2 MB").
// Owns: these conversions. Never: the DOM or RPC (tested in test/unit/ui/workspace-tabs.test.ts).

export type ViewKind = 'image' | 'video' | 'audio' | 'pdf' | 'file';

export function viewKind(mime: string, name: string): ViewKind {
  const type = mime.toLowerCase();
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)) return 'image';
  if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'].includes(ext)) return 'video';
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

/** "0:42", "3:05", "1:02:09". */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Measured facts joined by " · "; empty when nothing is known. */
export function mediaFacts(info: { width?: number; height?: number; durationMs?: number; pages?: number; size?: number }): string {
  const parts: string[] = [];
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`);
  if (info.durationMs) parts.push(durationLabel(info.durationMs));
  if (info.pages) parts.push(info.pages === 1 ? '1 page' : `${info.pages} pages`);
  if (info.size !== undefined) parts.push(sizeLabel(info.size));
  return parts.join(' · ');
}
