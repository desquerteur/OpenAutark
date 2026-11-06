// Mermaid rendering: lazy `import('mermaid')` on first use, securityLevel 'strict', one render
// at a time, sanitized SVG cached in memory by hash(source)+theme so every diagram renders once.
// Owns: the loader, the render queue and the SVG cache. Also serves sandboxed apps (wf_mermaid).
// Never: loads Mermaid before a diagram is visible or asked for, or hands out unsanitized SVG.

import DOMPurify from 'dompurify';
import { LIMITS } from '../../shared/blocks/catalog.ts';
import { hash } from './host.ts';

type MermaidApi = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
};

let configuredTheme = '';
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
const svgCache = new Map<string, string>();
const CACHE_MAX = 60;

/** A lazy import kept once it loaded; a failed one (a chunk that did not load) is tried again next call. */
export function retrying<T>(importer: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= importer().catch((error: unknown) => { pending = null; throw error; });
    return pending;
  };
}

const load = retrying(() => import('mermaid').then(mod => (mod as unknown as { default: MermaidApi }).default));

export function cachedSvg(source: string, theme: string): string | undefined {
  return svgCache.get(`${theme}:${hash(source)}`);
}

/** Renders a diagram to sanitized SVG (cached). Rejects on syntax errors or oversize input. */
export function renderMermaid(source: string, theme: 'light' | 'dark'): Promise<string> {
  const key = `${theme}:${hash(source)}`;
  const hit = svgCache.get(key);
  if (hit) return Promise.resolve(hit);
  if (source.length > LIMITS.mermaidChars) return Promise.reject(new Error('Diagram too large'));
  // Mermaid keeps global config: serialize renders so a theme switch cannot interleave.
  const job = queue.then(async () => {
    const mermaid = await load();
    if (configuredTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'neutral',
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif',
        // SVG <text> labels: the sanitizer forbids <foreignObject>, which HTML labels need
        // (Mermaid 12 reads the root-level flag; the flowchart one is deprecated).
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      configuredTheme = theme;
    }
    const { svg } = await mermaid.render(`wf-mermaid-${++counter}`, source);
    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'script', 'a'], FORBID_ATTR: ['href', 'xlink:href'] }) as unknown as string;
    if (svgCache.size >= CACHE_MAX) svgCache.delete(svgCache.keys().next().value as string);
    svgCache.set(key, clean);
    return clean;
  });
  queue = job.catch(() => undefined);
  return job;
}
