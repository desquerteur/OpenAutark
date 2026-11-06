// RPC contract part: the person's live view of agents' own browsers – watching, steering and taking over – and the
// named pointers (pointers.point / pointers.list). Handlers: runtime/rpc/handlers/browser.ts.
// Merged into Methods by module augmentation.
// Owns: these method shapes. Never: behaviour.

import type { BrowserFrame, BrowserInput, BrowserSessionInfo, BrowserSteer, BrowserTakeoverRequest, BrowserViewState } from '../model/browser.ts';
import type { PointerAction, PointerState } from '../model/pointers.ts';

declare module '../api/methods.ts' {
  interface Methods {
    // ----------------------------------------------------------------- agent browser live view
    /** The open agent browsers. */
    'browser.list': { params: void; result: BrowserSessionInfo[] };
    /** Starts this connection's live view of an agent's browser: state and frames on topic browser:<agentId>. */
    'browser.subscribe': { params: { agentId: string }; result: { state: BrowserViewState; frame?: BrowserFrame } };
    'browser.unsubscribe': { params: { agentId: string }; result: { ok: true } };
    /** The person steers the agent's browser: switch tab, open a URL, back/forward/reload, show or hide its window. */
    'browser.navigate': { params: BrowserSteer & { agentId: string }; result: BrowserViewState };
    /** The person's mouse, wheel, key or text input on the shown tab `tab` (turns the takeover on; typed text is never stored or shown to the agent). */
    'browser.input': { params: { agentId: string; tab: string; input: BrowserInput }; result: { ok: true } };
    /** Take the agent's browser over (its browser steps answer that; `url` opens it when closed) or hand it back (wakes the agent). */
    'browser.takeover': { params: BrowserTakeoverRequest & { agentId: string }; result: BrowserViewState };
    // ----------------------------------------------------------------- named pointers
    /**
     * The calling person's pointer on a surface (side:<tab>, agent:<agentId>/<tab>, screen:local): CSS px of the tab's
     * viewport (screen: physical px). At most ~10 per second per person are kept (`kept: false` = dropped by the throttle).
     * Everyone's pointers of that surface go out as 'pointers.changed' (topic system, owner).
     */
    'pointers.point': { params: { surface: string; x: number; y: number; target?: { role?: string; name?: string; ref?: string }; action?: PointerAction }; result: { ok: true; kept: boolean } };
    /** Every live pointer of one surface. */
    'pointers.list': { params: { surface: string }; result: PointerState };
  }
}

export {};
