// Where a personal tab's native view sits (main's WebContentsView over the app's page): exactly on
// its slot element (the whole pixels inside it, so it never covers an edge beside it), and hidden
// whenever something of the app's own would lie over it – an open dialog, a popover or menu, a toast
// over the slot, a hidden window; for a chat area's page also the global pane (floating in a narrow window, or
// the phone's pushed one) or the chat's details floating over it – or while `shown` is false (blank tab, a
// message over the page). The status line never hides a page: its lines lie beside the pane and under a chat's
// open area (header.css), and where one still reaches a page (full view, a narrow window, the phone) the page
// stays – a to-do's line can last for hours. Geometry follows ResizeObserver, DOM mutations, window resizes, visibility changes
// and the end of an animation or transition (a sheet sliding in moves the slot without resizing it) –
// never a timer loop – and is sent to main only when it changed. Main shows one tab per space, so
// 'hide' names its tab and the other surface's page stays. Unmounting hides the view.
// Owns: that placement loop. Never: draws anything or talks to the page.

import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import type { WorkspaceBrowserApi, WorkspaceBrowserCommand } from '../../shared/api/workspace-browser.ts';

/** What may lie over a slot: anywhere popovers and toasts; over a chat area also the global pane (the phone's too) and the chat's details. */
const OVER = '.popover, .toast';
const OVER_CHAT = `${OVER}, .global-pane, .phone-pane, .chat-panel, .chat-panel-scrim`;

export function useNativeSurface(slot: RefObject<HTMLElement>, id: string, native: WorkspaceBrowserApi | undefined, shown: boolean): void {
  useEffect(() => {
    const element = slot.current;
    if (!element || !native || !shown) return;
    let frame = 0;
    let last = '';
    const over = element.closest('.global-pane, .phone-pane') ? OVER : OVER_CHAT;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const floating = document.querySelectorAll(over); // B-044: the status notes hide no page (they last)
      // AF-010: while a dock or a tab is dragged (lib/appearance.ts) every page steps aside, so the pointer stays the app's
      const covered = document.querySelector('dialog[open]') !== null || document.documentElement.classList.contains('dock-dragging') || [...floating].some((item) => {
        if (item.contains(element)) return false;
        const box = item.getBoundingClientRect(); // 1 px of slack: a pane or panel right beside the slot does not cover it
        return box.width > 0 && box.height > 0 && box.left < rect.right - 1 && box.right > rect.left + 1 && box.top < rect.bottom - 1 && box.bottom > rect.top + 1;
      });
      const show = !covered && document.visibilityState === 'visible' && rect.width > 0 && rect.height > 0;
      // whole pixels inside the slot (never past it: a sheet's 1 px edge beside it stays visible)
      const left = Math.ceil(rect.left - 0.01);
      const top = Math.ceil(rect.top - 0.01);
      const bounds = { x: left, y: top, width: Math.max(1, Math.floor(rect.right + 0.01) - left), height: Math.max(1, Math.floor(rect.bottom + 0.01) - top) };
      const next: WorkspaceBrowserCommand = show ? { action: 'show', id, bounds } : { action: 'hide', id };
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      void native.command(next).catch(() => {});
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(queue);
    resize.observe(element);
    const mutations = new MutationObserver(queue);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    const onResize = () => { last = ''; queue(); };
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onResize);
    document.addEventListener('animationend', queue, true);
    document.addEventListener('transitionend', queue, true);
    document.addEventListener('wf-surfaces-moved', queue); // AF-010: a floating window or a dock moved its slot without resizing it
    queue();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onResize);
      document.removeEventListener('animationend', queue, true); document.removeEventListener('transitionend', queue, true);
      document.removeEventListener('wf-surfaces-moved', queue);
      void native.command({ action: 'hide', id }).catch(() => {});
    };
  }, [id, native, shown]);
}
