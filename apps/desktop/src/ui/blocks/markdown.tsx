// Hardened Markdown for agent text: marked (GFM) → DOMPurify → innerHTML, plus a delegated
// click handler so links open through the host, '#…' links navigate in the app (never by their
// URL) and remote images load
// only on click.
// Owns: the sanitizer config, the small render cache, <Markdown> and <Inline>.
// Never: lets raw HTML, scripts, styles, forms, iframes or non-http(s)/mailto links through,
// or fetches remote images without a click (no exfiltration beacons from agent text).

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { navigate, parseRoute } from '../lib/router.ts';
import { openLink } from './host.ts';

const marked = new Marked({ gfm: true, breaks: false, async: false });

// Raw HTML in agent Markdown is shown as text, never parsed as HTML.
marked.use({
  renderer: {
    html(token) { return escapeHtml(token.text); },
  },
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

const SAFE_URI = /^(?:https?:|mailto:|#)/i;

let hooked = false;
function purifier(): typeof DOMPurify {
  if (hooked) return DOMPurify;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    const el = node as Element;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!SAFE_URI.test(href)) el.removeAttribute('href');
      el.setAttribute('rel', 'noopener noreferrer');
      el.removeAttribute('target');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      if (/^https?:/i.test(src)) {
        // Remote images are click-to-load: keep the URL in a data attribute only.
        el.setAttribute('data-remote-src', src);
        el.removeAttribute('src');
        el.setAttribute('alt', el.getAttribute('alt') || 'Image');
        el.classList.add('md-remote-image');
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        el.setAttribute('title', 'Load image');
      } else if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(src)) {
        el.removeAttribute('src');
      }
    }
    if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') el.remove();
    if (el.tagName === 'INPUT') el.setAttribute('disabled', '');
  });
  return DOMPurify;
}

const CONFIG = {
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'source', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset', 'action', 'formaction'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/)/i,
  ADD_ATTR: ['data-remote-src'],
};

const cache = new Map<string, string>();
const CACHE_MAX = 400;

function remember(key: string, html: string): string {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, html);
  return html;
}

/** Block Markdown → sanitized HTML (cached by text). */
export function renderMarkdown(text: string): string {
  const key = `b:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = marked.parse(text) as string;
  return remember(key, purifier().sanitize(html, CONFIG) as unknown as string);
}

/** Inline Markdown (bold, code, links) → sanitized HTML for strings inside blocks. */
export function renderInline(text: string): string {
  const key = `i:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = marked.parseInline(text) as string;
  return remember(key, purifier().sanitize(html, CONFIG) as unknown as string);
}

/** Delegated clicks: links via the host, remote images load on click. */
function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const image = target?.closest?.('img[data-remote-src]') as HTMLImageElement | null;
  if (image) {
    event.preventDefault();
    image.src = image.dataset.remoteSrc ?? '';
    image.removeAttribute('data-remote-src');
    image.classList.remove('md-remote-image');
    image.removeAttribute('role');
    return;
  }
  const link = target?.closest?.('a') as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  event.preventDefault();
  if (href.startsWith('#')) { navigate(parseRoute(href)); return; }
  if (href) openLink(href);
}

function onKeyDown(event: KeyboardEvent): void {
  if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).matches?.('img[data-remote-src]')) {
    onClick(event as unknown as MouseEvent);
  }
}

export function Markdown(props: { text: string; class?: string }) {
  return (
    <div
      class={`md${props.class ? ` ${props.class}` : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text) }}
    />
  );
}

/** Inline Markdown in a span (block titles, cells, option labels). */
export function Inline(props: { text: string | undefined; class?: string }) {
  if (!props.text) return null;
  // Plain strings skip the parser entirely (most cells and labels).
  if (!/[*_`[~<&\\]/.test(props.text)) return <span class={props.class}>{props.text}</span>;
  return <span class={props.class} onClick={onClick} dangerouslySetInnerHTML={{ __html: renderInline(props.text) }} />;
}
