// The sign-in page an official CLI prints while its browser sign-in runs (B-051 L4: `codex login`,
// `claude auth login --claudeai` – when the CLI cannot open the browser, the person opens this page).
// Only complete lines are read, and only the first https:// URL on a known sign-in host counts
// (auth.openai.com, chatgpt.com, openai.com, claude.ai, claude.com, anthropic.com, console.anthropic.com
// and their subdomains; no user name, password or port). After that URL, or SCAN_CHARS of output, every
// further chunk is dropped unread – the stream keeps draining so the CLI never blocks on a full pipe.
// A sign-in URL is not a token, but it opens the person's sign-in: the caller keeps it in memory only.
// Owns: the host allow-list, the line scan and its caps.
// Never: logs, stores or forwards anything it reads.

import type { Readable } from 'node:stream';

const HOSTS = ['auth.openai.com', 'chatgpt.com', 'openai.com', 'claude.ai', 'claude.com', 'anthropic.com', 'console.anthropic.com'] as const;
/** Output read per stream before the scan gives up. */
export const SCAN_CHARS = 64 * 1024;
/** A line longer than this is dropped (no sign-in URL is that long). */
const LINE_CHARS = 8 * 1024;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const URL_LIKE = /https:\/\/[^\s"'<>`\u0000-\u001f\u007f]+/gi;

export function isSignInHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return HOSTS.some((host) => name === host || name.endsWith(`.${host}`));
}

/** The first sign-in page URL in this text, undefined without one. */
export function findSignInUrl(text: string): string | undefined {
  for (const match of text.replace(ANSI, '').matchAll(URL_LIKE)) {
    const raw = match[0].replace(/[).,;:!?\]}>]+$/, '');
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
    if (isSignInHost(url.hostname)) return url.href;
  }
  return undefined;
}

/** Reads the streams' complete lines until the first sign-in URL (then `found` once) or the cap; the rest is dropped. */
export function watchSignInUrl(streams: ReadonlyArray<Readable | null | undefined>, found: (url: string) => void): void {
  let done = false;
  for (const stream of streams) {
    if (!stream) continue;
    let pending = '';
    let seen = 0;
    stream.on('data', (chunk: Buffer | string) => {
      if (done || seen > SCAN_CHARS) return; // drained, never read again
      const text = chunk.toString();
      seen += text.length;
      pending += text;
      const end = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
      if (end >= 0) {
        const url = findSignInUrl(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (url) { done = true; pending = ''; found(url); return; }
      }
      if (pending.length > LINE_CHARS || seen > SCAN_CHARS) pending = '';
    });
    stream.on('error', () => {});
  }
}
