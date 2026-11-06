// browser.wait in a side tab without a polling loop – the condition is checked once, then
// again only when the page reports something: a navigation or load, a dialog, network activity, or a
// document change from the isolated world's MutationObserver (switched on only while someone waits).
// text = the page's visible text contains it; url = the address contains it (or matches a * pattern);
// change = anything changed since the wait began; idle = no change and no open request for 500 ms.
// Owns: the wait. Never: waits longer than SIDE_WAIT_MAX_MS.

import { SIDE_WAIT_MAX_MS, type SideBrowserCall } from '../../shared/model/side-browser.ts';
import type { SideTab } from './tab.ts';

const IDLE_MS = 500;
const DEFAULT_MS = 10_000;

/** An address pattern: with * a whole-address pattern, otherwise a part of the address (both case-insensitive). */
export function urlMatcher(pattern: string): (url: string) => boolean {
  if (!pattern.includes('*')) { const low = pattern.toLowerCase(); return (url) => url.toLowerCase().includes(low); }
  const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return (url) => re.test(url);
}

export interface WaitDeps { now(): number }

export async function waitFor(tab: SideTab, wait: NonNullable<SideBrowserCall['wait']>, deps: WaitDeps): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const timeout = Math.min(SIDE_WAIT_MAX_MS, wait.timeoutMs ?? DEFAULT_MS);
  const matchUrl = wait.url ? urlMatcher(wait.url) : undefined;
  const text = wait.text?.toLowerCase();
  const startDoc = tab.doc;
  const startUrl = tab.contents.getURL();
  let changed = false;
  let activeAt = deps.now();

  const met = async (): Promise<boolean> => {
    if (matchUrl && !matchUrl(tab.contents.getURL())) return false;
    if (wait.change && !changed && tab.doc === startDoc && tab.contents.getURL() === startUrl) return false;
    if (wait.idle && (deps.now() - activeAt < IDLE_MS || tab.network.inflight(tab.network.latest()) > 0 || tab.navigating)) return false;
    if (text) {
      if (tab.dialog) return false;
      const has = await tab.cdp.inWorld<boolean>(`__wfSide.text(4000000).toLowerCase().includes(${JSON.stringify(text)})`).catch(() => false);
      if (!has) return false;
    }
    return true;
  };
  const note = () => [
    text ? `the text ${JSON.stringify(wait.text)} is on the page` : '', matchUrl ? `the address matches ${JSON.stringify(wait.url)}` : '',
    wait.change ? 'the page changed' : '', wait.idle ? 'the page is quiet' : '',
  ].filter(Boolean).join(', ');

  if (!wait.change && !wait.idle && (await met())) return { ok: true, note: `Already true: ${note()}.` };
  const watched = Boolean(text || wait.change || wait.idle);
  if (watched) await tab.watch(true);
  return new Promise((resolve) => {
    let done = false;
    let checking = false;
    let again = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { ok: true; note: string } | { ok: false; error: string }) => {
      if (done) return;
      done = true;
      offEvent(); offChange();
      clearTimeout(timer); clearTimeout(idleTimer);
      if (watched) void tab.watch(false);
      resolve(result);
    };
    const check = async () => {
      if (done) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        do { again = false; if (await met()) { finish({ ok: true, note: `Now ${note()}.` }); return; } } while (again && !done);
      } finally { checking = false; }
    };
    const armIdle = () => { if (!wait.idle) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => void check(), IDLE_MS + 20); };
    const offChange = tab.onMutation(() => { changed = true; activeAt = deps.now(); });
    const offEvent = tab.onEvent(() => {
      if (tab.doc !== startDoc) changed = true;
      activeAt = deps.now();
      if (watched) void tab.rewatch();
      armIdle();
      void check();
    });
    const timer = setTimeout(() => {
      const what = [text ? `the text ${JSON.stringify(wait.text)} did not appear` : '', matchUrl ? `the address did not match ${JSON.stringify(wait.url)}` : '',
        wait.change ? 'the page did not change' : '', wait.idle ? 'the page did not get quiet' : ''].filter(Boolean).join(', ');
      finish({ ok: false, error: `Waited ${Math.round(timeout / 100) / 10} s – ${what}.` });
    }, timeout);
    armIdle();
    void check();
  });
}
