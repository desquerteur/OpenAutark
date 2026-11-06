// Deterministic evidence checks of a task result (B-047 D11), run by verify.ts before the verifier's predicate:
// - a file the evidence names (kind file/screenshot, by an absolute path, a file:// URL, or a path relative to the
//   workspace): it exists, and a file is not empty; a missing absolute path is a confident no only when its folder
//   exists here (a folder missing too may be another PC's – a linked PC's result), a missing relative one only
//   "could not tell" (it may live in a task's own worktree); a line reference (":12", ":12:5", "#L12") is tried
//   without it, and on Windows a Git Bash path ("/c/Users/…") is read as "C:\Users\…";
// - a link (an http(s) URL in ref or label): one HEAD request (GET when HEAD is not allowed, body not read),
//   redirects followed, LINK_TIMEOUT_MS; 404/410 is a confident no – except on hosts that answer 404 for a private
//   page without its login (GitHub, GitLab, Bitbucket, Azure DevOps: PRIVATE_404) –, a network error, timeout or 5xx
//   "could not tell", everything else (2xx, 3xx, 401/403/429 – the page exists behind a login or a limit) answers.
// At most MAX_CHECKS targets per result, each once, all in parallel. No retries, no polling.
// Owns: which evidence is checked and how, and the check lines. Never: reads a file's content, sends cookies or
// secrets, follows anything beyond the one request, or decides the verdict (verify.ts does).

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence } from '../../shared/model/tasks.ts';
import type { EvidenceCheck, EvidenceChecker } from '../contracts/evidence.ts';

export const MAX_CHECKS = 8;
export const LINK_TIMEOUT_MS = 8000;

export type CheckFetch = (url: string, init: { method: 'HEAD' | 'GET'; signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> }) => Promise<Response>;
export type CheckStat = (file: string) => Promise<{ size: number; isDirectory(): boolean } | undefined>;

const URL_RE = /^https?:\/\/\S+$/i;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
/** Hosts that answer 404 for a private repository, PR or file to a request without its login – no proof of absence. */
const PRIVATE_404 = /(?:^|\.)(?:github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|dev\.azure\.com|visualstudio\.com)$/i;
/** A trailing line reference of a path: "a.ts:12", "a.ts:12:5", "a.ts#L12" / "#L12-L20". */
const LINE_REF = /^(.+?)(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

const defaultStat: CheckStat = async (file) => {
  try { return await fsp.stat(file); } catch { return undefined; }
};

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const short = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };

/** The targets worth checking: file paths of file/screenshot evidence and URLs of any evidence, each once. */
export function targetsOf(evidence: readonly Evidence[]): Array<{ kind: 'file' | 'link'; target: string }> {
  const out: Array<{ kind: 'file' | 'link'; target: string }> = [];
  const seen = new Set<string>();
  const add = (kind: 'file' | 'link', target: string) => {
    if (seen.has(target) || out.length >= MAX_CHECKS) return;
    seen.add(target);
    out.push({ kind, target });
  };
  for (const item of evidence) {
    const candidates = [item.ref, item.label].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
    const url = candidates.find((value) => URL_RE.test(value));
    if (url) { add('link', url); continue; }
    if (item.kind !== 'file' && item.kind !== 'screenshot') continue;
    const file = candidates.find((value) => value.startsWith('file://') || ABSOLUTE.test(value) || /[\\/]/.test(value));
    if (file) add('file', file);
  }
  return out;
}

async function checkFile(target: string, workspace: string | undefined, stat: CheckStat, platform: NodeJS.Platform): Promise<EvidenceCheck> {
  let file = target;
  if (target.startsWith('file://')) { try { file = fileURLToPath(target); } catch { return { kind: 'file', target, ok: undefined, line: `file not checked (not a usable file URL): ${short(target)}` }; } }
  const bash = platform === 'win32' ? /^\/([A-Za-z])(?:\/(.*))?$/.exec(file) : null; // Git Bash "/c/Users/…" on Windows
  if (bash) file = `${bash[1].toUpperCase()}:\\${(bash[2] ?? '').replace(/\//g, '\\')}`;
  const absolute = ABSOLUTE.test(file) || path.isAbsolute(file);
  if (!absolute && !workspace) return { kind: 'file', target, ok: undefined, line: `file not checked (relative path): ${short(target)}` };
  const resolved = absolute ? file : path.resolve(workspace!, file);
  let info = await stat(resolved);
  const bare = info ? undefined : LINE_REF.exec(resolved)?.[1]; // "a.ts:12" names a line of a.ts
  if (bare) info = await stat(bare);
  if (!info) {
    if (!absolute) return { kind: 'file', target, ok: undefined, line: `file not found in the workspace (may be elsewhere): ${short(target)}` };
    // Its folder is here, the file is not: a confident no. A folder missing too may be another PC's (a linked PC's result).
    const folder = await stat(path.dirname(bare ?? resolved));
    return folder?.isDirectory()
      ? { kind: 'file', target, ok: false, line: `file missing: ${short(target)}` }
      : { kind: 'file', target, ok: undefined, line: `file and its folder not found on this PC (maybe another PC's): ${short(target)}` };
  }
  if (info.isDirectory()) return { kind: 'file', target, ok: true, line: `folder exists: ${short(target)}` };
  if (info.size === 0) return { kind: 'file', target, ok: false, line: `file is empty: ${short(target)}` };
  return { kind: 'file', target, ok: true, line: `file exists (${size(info.size)}): ${short(target)}` };
}

async function checkLink(target: string, doFetch: CheckFetch, outer?: AbortSignal): Promise<EvidenceCheck> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, LINK_TIMEOUT_MS);
  timer.unref?.();
  const headers = { 'user-agent': 'Mozilla/5.0 (Autark evidence check)', accept: '*/*' };
  try {
    let response = await doFetch(target, { method: 'HEAD', signal: controller.signal, redirect: 'follow', headers });
    if (response.status === 405 || response.status === 501) {
      response = await doFetch(target, { method: 'GET', signal: controller.signal, redirect: 'follow', headers });
      try { await response.body?.cancel(); } catch { /* nothing to read */ }
    }
    const status = response.status;
    if ((status === 404 || status === 410) && PRIVATE_404.test(hostOf(response.url || target))) {
      return { kind: 'link', target, ok: undefined, line: `link not checked (HTTP ${status} – this host answers so for private pages too): ${short(target)}` };
    }
    if (status === 404 || status === 410) return { kind: 'link', target, ok: false, line: `link does not exist (HTTP ${status}): ${short(target)}` };
    if (status >= 500) return { kind: 'link', target, ok: undefined, line: `link not checked (server error HTTP ${status}): ${short(target)}` };
    return { kind: 'link', target, ok: true, line: `link answers (HTTP ${status}): ${short(target)}` };
  } catch {
    return { kind: 'link', target, ok: undefined, line: `link not checked (${controller.signal.aborted ? 'timed out' : 'network error'}): ${short(target)}` };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

/** The checker compose/services.ts wires (tests pass their own fetch and stat). */
export function createEvidenceChecker(deps: { fetch?: CheckFetch; stat?: CheckStat; platform?: NodeJS.Platform } = {}): EvidenceChecker {
  const doFetch: CheckFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const stat = deps.stat ?? defaultStat;
  const platform = deps.platform ?? process.platform;
  return {
    async check(evidence, context = {}) {
      const targets = targetsOf(evidence);
      return Promise.all(targets.map((item) => (item.kind === 'file'
        ? checkFile(item.target, context.workspace, stat, platform).catch(() => ({ kind: 'file' as const, target: item.target, ok: undefined, line: `file not checked: ${short(item.target)}` }))
        : checkLink(item.target, doFetch, context.signal))));
    },
  };
}
