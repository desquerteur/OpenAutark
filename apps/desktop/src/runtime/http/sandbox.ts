// ```app mini-tools for the PWA: `GET /sandbox/app?m=<messageId>&i=<blockIndex>&e=…&t=…` returns
// the block's HTML wrapped in a sandbox document with the `wf` helper inlined (web-genui.md
// §3/§7.9). The URL is a short-lived capability from `blocks.sandboxUrl` (sandbox-token.ts);
// without a valid token the route answers 403. The UI frames it with sandbox="allow-scripts
// allow-forms" (no allow-same-origin); the response CSP adds `sandbox` too, so the document runs
// in an opaque origin even when opened directly.
// Owns: loading the app HTML of a message and the sandbox document. Never: network access for
// the frame (CSP connect-src 'none'), device tokens, or serving non-app content.

import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { appHtmlOf } from '../../shared/blocks/parse.ts';
import { isId } from '../../shared/ids.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import { BASE_HEADERS, sendError } from './body.ts';
import { sandboxTokens } from './sandbox-token.ts';
import { SANDBOX_CSP } from './static.ts';

const META = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

/** Inline <script> body: a literal `</script` would end the element early. */
function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;
}

/** Wraps app HTML into a document that runs the `wf` helper first (full documents keep their head). */
export function sandboxDocument(html: string, helper: string | undefined): string {
  const script = helper ? inlineScript(helper) : '';
  if (/^\s*(<!doctype[^>]*>\s*)?<html[\s>]/i.test(html)) {
    // `<head>` / `<head …>` only – never `<header>`.
    const head = /<head(?:\s[^>]*)?>/i;
    if (head.test(html)) return html.replace(head, (match) => `${match}${META}${script}`);
    return html.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${META}${script}</head>`);
  }
  return `<!doctype html><html><head>${META}${script}</head><body>${html}</body></html>`;
}

export class SandboxRoute {
  private readonly services: () => RuntimeServices;
  private readonly helperFile: string;
  private readonly log: () => Logger;
  private helper?: { mtimeMs: number; source: string };

  constructor(deps: { services: () => RuntimeServices; staticDir: string; log: () => Logger }) {
    this.services = deps.services;
    this.helperFile = path.join(deps.staticDir, 'sandbox', 'wf.js');
    this.log = deps.log;
  }

  async serve(res: ServerResponse, url: URL, head: boolean): Promise<void> {
    const messageId = url.searchParams.get('m') ?? '';
    const index = Number(url.searchParams.get('i'));
    if (!isId(messageId, 'msg') || !Number.isInteger(index) || index < 0 || index > 9999) {
      sendError(res, 400, 'bad_request', 'Invalid app reference.');
      return;
    }
    const services = this.services();
    if (!sandboxTokens(services).verify(messageId, index, url.searchParams.get('e'), url.searchParams.get('t'))) {
      sendError(res, 403, 'forbidden', 'This app link is invalid or has expired.');
      return;
    }
    const message = services.chats.message(messageId);
    const html = message ? appHtmlOf(message.body, index) : undefined;
    if (html === undefined) {
      sendError(res, 404, 'not_found', 'This app is not available.');
      return;
    }
    const body = sandboxDocument(html, await this.helperSource());
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': SANDBOX_CSP,
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(body)),
    });
    res.end(head ? undefined : body);
  }

  /** The built wf.js (cached until its mtime changes). */
  private async helperSource(): Promise<string | undefined> {
    try {
      const info = await stat(this.helperFile);
      if (this.helper?.mtimeMs === info.mtimeMs) return this.helper.source;
      const source = await readFile(this.helperFile, 'utf8');
      this.helper = { mtimeMs: info.mtimeMs, source };
      return source;
    } catch {
      this.log().warn('sandbox helper wf.js missing; app blocks run without it', { file: this.helperFile });
      return undefined;
    }
  }
}
