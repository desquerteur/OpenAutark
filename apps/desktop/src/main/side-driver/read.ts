// Reading a side tab for an agent – its accessibility snapshot (with the page facts: human
// check, password fields whose values stay hidden), a screenshot, its visible text, the response body of
// a request, and eval in the page's own world (debugging only).
// Owns: those reads. Never: changes the page (eval is the agent's own expression, on request only).

import type { NativeImage } from 'electron';
import { SIDE_TEXT_MAX, type SideBrowserCall, type SideBrowserResult } from '../../shared/model/side-browser.ts';
import { SideError } from './cdp.ts';
import { isChallengeUrl } from './page-script.ts';
import { snapshotLines, type AXNode, type Look, type Snapshot } from './snapshot.ts';
import type { SideTab } from './tab.ts';

const AX_MS = 20_000;
const SCREENSHOT_EDGE = 1280;
const EVAL_MS = 5_000;

export function dialogError(tab: SideTab): SideError | undefined {
  return tab.dialog ? new SideError(`A ${tab.dialog.type} dialog is open (${JSON.stringify(tab.dialog.message).slice(0, 160)}) – press Enter to accept or Escape to dismiss it (act with a press step).`) : undefined;
}

function origin(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/** Backend node ids of the page's password fields (their values never show). */
async function passwordNodes(tab: SideTab): Promise<Set<number>> {
  const ids = new Set<number>();
  const group = 'wf-side-pw';
  try {
    const list = await tab.cdp.send('Runtime.evaluate', { expression: '__wfSide.passwords()', contextId: await tab.cdp.world(), objectGroup: group }) as { result?: { objectId?: string } };
    if (!list.result?.objectId) return ids;
    const props = await tab.cdp.send('Runtime.getProperties', { objectId: list.result.objectId, ownProperties: true }) as { result?: Array<{ name: string; value?: { objectId?: string } }> };
    for (const prop of props.result ?? []) {
      if (!/^\d+$/.test(prop.name) || !prop.value?.objectId) continue;
      const described = await tab.cdp.send('DOM.describeNode', { objectId: prop.value.objectId }) as { node?: { backendNodeId?: number } };
      if (typeof described.node?.backendNodeId === 'number') ids.add(described.node.backendNodeId);
    }
  } finally {
    void tab.cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
  return ids;
}

/** A fresh snapshot of the tab (its refs become the tab's known refs). */
export async function takeLook(tab: SideTab): Promise<{ snap: Snapshot; look: Look; human: boolean }> {
  const dialog = dialogError(tab);
  if (dialog) throw dialog;
  const url = tab.contents.getURL();
  const facts = await tab.cdp.inWorld<{ human?: boolean; passwords?: number }>('__wfSide.facts()').catch(() => ({ human: false, passwords: 0 }));
  const secret = facts.passwords ? await passwordNodes(tab).catch(() => new Set<number>()) : new Set<number>();
  const tree = await tab.cdp.send('Accessibility.getFullAXTree', {}, AX_MS) as { nodes?: AXNode[] };
  const snap = snapshotLines(tree.nodes ?? [], { origin: origin(url), secret });
  tab.refs = snap.refs;
  return { snap, look: { lines: snap.lines, url, title: tab.contents.getTitle(), doc: tab.doc }, human: facts.human === true || isChallengeUrl(url) };
}

/** B-076: the page's picture through CDP (Page.captureScreenshot), for when capturePage fails; undefined when that fails too. */
async function cdpPicture(tab: SideTab, clip?: { x: number; y: number; width: number; height: number }): Promise<NativeImage | undefined> {
  try {
    const shot = await tab.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }) as { data?: string };
    if (!shot.data) return undefined;
    const { nativeImage } = await import('electron'); // loaded here: unit tests import this file without Electron
    return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
  } catch {
    return undefined;
  }
}

/** The visible page (or a region of it, viewport CSS px) as JPEG; 1 image px = 1 CSS px unless scaled down to maxEdge. */
export async function screenshot(tab: SideTab, call: SideBrowserCall): Promise<Pick<SideBrowserResult, 'image' | 'text'>> {
  const contents = tab.contents;
  const zoom = contents.getZoomFactor?.() ?? 1;
  const metrics = await tab.cdp.send('Page.getLayoutMetrics') as { cssVisualViewport?: { clientWidth: number; clientHeight: number } };
  const view = { width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0), height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0) };
  const r = call.region;
  if (r && (r.x >= view.width || r.y >= view.height)) throw new SideError(`The region starts outside the visible page (${view.width}×${view.height} CSS px).`);
  const css = r ? { x: r.x, y: r.y, width: Math.min(r.width, view.width - r.x), height: Math.min(r.height, view.height - r.y) } : { x: 0, y: 0, ...view };
  // capturePage (not Page.captureScreenshot): it also draws a tab the person is not looking at. B-076 (live 05.11.: a global
  // pane tab answered "UnknownVizError"): when the compositor refuses, the page's own CDP picture is the second way.
  const rect = r ? { x: Math.round(css.x * zoom), y: Math.round(css.y * zoom), width: Math.max(1, Math.round(css.width * zoom)), height: Math.max(1, Math.round(css.height * zoom)) } : undefined;
  let image = await contents.capturePage(rect, { stayHidden: true }).catch(() => undefined);
  if (!image || image.isEmpty()) image = await cdpPicture(tab, r ? css : undefined);
  if (!image || image.isEmpty()) throw new SideError('This tab cannot be captured right now – it has not been shown yet; ask the person to open it once.');
  const edge = call.maxEdge ?? SCREENSHOT_EDGE;
  const cssW = css.width || image.getSize().width, cssH = css.height || image.getSize().height;
  const scale = Math.min(1, edge / Math.max(cssW, cssH));
  const width = Math.max(1, Math.round(cssW * scale)), height = Math.max(1, Math.round(cssH * scale));
  const size = image.getSize();
  if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'good' });
  const out = image.getSize();
  const note = scale < 1 ? `Scaled to ${Math.round(scale * 100)} %: a point in the image × ${(1 / scale).toFixed(3)} is the page's CSS px${r ? ` (from ${r.x},${r.y})` : ''}.` : `1 image px = 1 CSS px of the page${r ? ` (from ${r.x},${r.y})` : ''}.`;
  return { image: { data: image.toJPEG(72).toString('base64'), mime: 'image/jpeg', width: out.width, height: out.height }, text: note };
}

/** The page's visible text (innerText, read in the driver's world). */
export async function pageText(tab: SideTab): Promise<string> {
  const dialog = dialogError(tab);
  if (dialog) throw dialog;
  const text = await tab.cdp.inWorld<string>(`__wfSide.text(${SIDE_TEXT_MAX + 1})`);
  if (!text?.trim()) return '(The page shows no text.)';
  return text.length > SIDE_TEXT_MAX ? `${text.slice(0, SIDE_TEXT_MAX - 80)}\n… (the text is longer – cut at ${SIDE_TEXT_MAX} characters)` : text;
}

interface EvalOut { result?: { type?: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }

/** The agent's expression in the page's own world (debugging): its value as JSON, capped. */
export async function evaluate(tab: SideTab, expression: string): Promise<string> {
  const dialog = dialogError(tab);
  if (dialog) throw dialog;
  const run = (byValue: boolean) => tab.cdp.send('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise: true, userGesture: false, replMode: true, timeout: EVAL_MS, objectGroup: 'wf-side-eval' }, EVAL_MS + 3000) as Promise<EvalOut>;
  let out: EvalOut;
  try { out = await run(true); } catch (error) {
    if (error instanceof SideError) throw error;
    out = await run(false); // a value that cannot travel as JSON (a node, a cycle): its description
  }
  void tab.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'wf-side-eval' }).catch(() => {});
  if (out.exceptionDetails) throw new SideError(`The expression threw: ${(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'error').split('\n').slice(0, 4).join('\n').slice(0, 1000)}`);
  const result = out.result ?? {};
  let text: string;
  if (result.unserializableValue) text = result.unserializableValue;
  else if (result.value !== undefined) { try { text = JSON.stringify(result.value, null, 1) ?? String(result.value); } catch { text = String(result.value); } }
  else text = result.description ?? result.type ?? 'undefined';
  return text.length > SIDE_TEXT_MAX ? `${text.slice(0, SIDE_TEXT_MAX - 40)}\n… (cut)` : text;
}

/** A request's response body as the page received it, or why there is none. */
export async function responseBody(tab: SideTab, requestId: string): Promise<{ body: string; base64Encoded?: boolean } | undefined> {
  if (requestId.includes('~')) return undefined; // a redirect step has no body
  return tab.cdp.send('Network.getResponseBody', { requestId }).then((out) => out as { body: string; base64Encoded?: boolean }, () => undefined);
}
