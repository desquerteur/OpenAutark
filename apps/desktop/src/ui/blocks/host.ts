// Host capabilities used by blocks and widgets: links, files, chunked uploads, sandbox URLs,
// theme facts and small local drafts. One place so desktop and PWA differ only here.
// Owns: these helpers. Never: renders, keeps big data in memory, or opens non-http(s)/mailto
// links (protocol allowlist; agent text is untrusted).

import { signal } from '@preact/signals';
import { rpc } from '../lib/rpc.ts';
import { openExternal, platform } from '../lib/platform.ts';

export { platform };
/** Chunked uploads (≤ 4 MB per frame) live with the other file helpers. */
export { uploadBlob } from '../lib/files.ts';

/** Opens an agent-provided link through the host (system browser), allowlisted protocols only. */
export function openLink(url: string): void {
  const value = url.trim();
  if (/^(https?:|mailto:)/i.test(value)) openExternal(value);
}

export function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** sha256 file ids from the blob store. */
export function isFileId(src: string): boolean {
  return /^[0-9a-f]{64}$/.test(src);
}

/** Opens a deliverable by path (desktop/owner) – "Open" or "Show in folder". */
export async function openPath(path: string, reveal = false): Promise<void> {
  await rpc.call('files.openPath', { path, reveal });
}

/**
 * Where an ```app frame loads from. Desktop: the wf-sandbox: protocol served by main. Web:
 * a separate sandbox origin announced by the runtime in <meta name="wf-sandbox-origin">, else
 * the same server path – still an opaque origin because the frame never gets allow-same-origin.
 */
export function sandboxSrc(messageId: string, index: number): string {
  const m = encodeURIComponent(messageId);
  if (platform === 'desktop') return `wf-sandbox://app/${m}/${index}`;
  const origin = document.querySelector<HTMLMetaElement>('meta[name="wf-sandbox-origin"]')?.content?.replace(/\/$/, '') ?? '';
  return `${origin}/sandbox/app?m=${m}&i=${index}`;
}

// ------------------------------------------------------------------ theme

function resolvedTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const value = document.documentElement.dataset.theme;
  if (value === 'dark' || value === 'light') return value;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Effective light/dark theme, updated when the setting or the OS scheme flips. */
export const theme = signal<'light' | 'dark'>(resolvedTheme());

let watching = false;
export function watchTheme(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  const update = () => { theme.value = resolvedTheme(); };
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
}

/** Current values of every --wf-* token (sent to sandboxed apps on initialize/theme change). */
export function wfTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const keys = ['bg', 'surface', 'fg', 'muted', 'border', 'accent', 'accent-fg', 'success', 'warning', 'danger', 'radius', 'font', 'mono', 'space', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = styles.getPropertyValue(`--wf-${key}`).trim();
    if (value) out[`--wf-${key}`] = value;
  }
  return out;
}

// ------------------------------------------------------------------ local drafts ("never lose input")

export function readDraft<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(`wf.draft.${key}`);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch { return undefined; }
}

export function writeDraft(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(`wf.draft.${key}`);
    else localStorage.setItem(`wf.draft.${key}`, JSON.stringify(value));
  } catch { /* storage may be full or blocked; drafts are a convenience */ }
}

/** Sub-keys the ask widgets keep their input under (`<draftKey>.<suffix>`, see useDraft callers). */
export const WIDGET_DRAFT_SUFFIXES = ['values', 'files', 'note', 'checked', 'picked'] as const;

/** Drops every local draft of one answered block: the shell's own key and each widget sub-key. */
export function clearDrafts(key: string): void {
  writeDraft(key, undefined);
  for (const suffix of WIDGET_DRAFT_SUFFIXES) writeDraft(`${key}.${suffix}`, undefined);
}

/** Cheap stable hash (FNV-1a) for cache keys. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
