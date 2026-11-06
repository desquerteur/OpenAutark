// Where an ```app frame's document comes from and what it may use: the frame URL
// (wf-sandbox:// on the desktop; elsewhere a short-lived capability URL from blocks.sandboxUrl,
// fetched per mount and again after it expired) and the remembered permission grants
// (microphone/camera/clipboard, per block, asked once).
// Owns: URL lifecycle and grant storage for AppFrame.tsx. Never: renders, talks to the frame,
// or grants anything the human did not allow.

import { useEffect, useRef, useState } from 'preact/hooks';
import { blockKey } from '../../shared/blocks/parse.ts';
import { platform } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { hostedShell } from '../pwa/hosted.ts';
import { sandboxSrc } from './host.ts';

const GRANTS_KEY = 'wf.appGrants';

export function readGrants(): Record<string, true> {
  try { return JSON.parse(localStorage.getItem(GRANTS_KEY) ?? '{}') as Record<string, true>; } catch { return {}; }
}

export function saveGrant(key: string): void {
  try { localStorage.setItem(GRANTS_KEY, JSON.stringify({ ...readGrants(), [key]: true })); } catch { /* storage blocked */ }
}

// No media arm for mini-apps: main grants microphone/camera only to our page's main frame
// (session-guards.ts), never to a frame, so an arm from Allow or a frame load gave the frame
// nothing and only armed the window without a click.

/**
 * Frame URL: wf-sandbox:// on the desktop; elsewhere a capability URL from the runtime (10 min),
 * fetched on mount and again when the app reloads itself after the URL expired (the old one
 * then answers 403). `expiresAt` is runtime time; a small clock skew only shifts that refetch.
 */
export function useSandboxSrc(messageId: string, index: number) {
  const desktop = platform === 'desktop';
  const key = blockKey(messageId, index);
  // Tagged with its block: a part re-used for another block never shows the previous app.
  const [fetched, setFetched] = useState<{ key: string; url: string } | undefined>(undefined);
  const src = desktop ? sandboxSrc(messageId, index) : fetched?.key === key ? fetched.url : undefined;
  const [error, setError] = useState<string | undefined>(undefined);
  const [request, setRequest] = useState(0);
  const expiresAt = useRef(0);
  const loads = useRef(0);
  useEffect(() => {
    if (desktop) return;
    let cancelled = false;
    rpc.call('blocks.sandboxUrl', { messageId, blockIndex: index }).then(
      (result) => {
        if (cancelled) return;
        expiresAt.current = result.expiresAt;
        loads.current = 0;
        setError(undefined);
        // The runtime returns a path; resolve it against the sandbox base host.ts uses – inside the iPhone web app the
        // shell's service worker relays it to the PC (with the PC's sandbox CSP), under the shell's base.
        const hosted = hostedShell();
        setFetched({ key, url: hosted ? new URL(hosted.frameUrl(result.url), location.href).href : new URL(result.url, new URL(sandboxSrc(messageId, index), location.href)).href });
      },
      (failure: unknown) => { if (!cancelled) setError(errorText(failure)); },
    );
    return () => { cancelled = true; };
  }, [messageId, index, request]);
  const refetch = () => { setError(undefined); setRequest((n) => n + 1); };
  /** onLoad of the frame: false when the load is not the app (blank frame, expired URL being replaced). */
  const loaded = (): boolean => {
    if (!src) return false;
    if (!desktop && ++loads.current > 1 && Date.now() >= expiresAt.current - 5_000) { refetch(); return false; }
    return true;
  };
  return { src, error, refetch, loaded };
}
